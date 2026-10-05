'use strict';
/**
 * Super-admin panel — everything the DormBook owner (you) manages across all customers.
 *
 *   Overview      GET  /admin/overview
 *   Customers     POST /admin/accounts · PATCH /admin/accounts/:id · POST /admin/accounts/:id/extend-trial
 *   Users         GET /admin/users · PATCH/DELETE /admin/users/:id · POST /admin/users/:id/reset-password · /unlock
 *   Super-admins  GET/POST /admin/admins · PATCH/DELETE /admin/admins/:id
 *   Plans         GET/POST /admin/plans · PATCH/DELETE /admin/plans/:id
 *   Payments      GET/POST /admin/payments · GET/PATCH /admin/payments/:id · POST /admin/payments/:id/void
 *   Content       GET /admin/content · PUT /admin/content/:key   (branding | support | faq)
 *   Reports       GET /admin/reports · GET /admin/reports/export?type=payments|accounts|users
 *   System        GET /admin/system · POST /admin/system/backup · POST /admin/system/sync-uploads
 *   Audit         GET /admin/audit
 *
 * Privacy rule (unchanged): the super-admin never sees guest names, guest mobiles, ID
 * proofs or a PG's money. "Payments" here are what PG owners pay YOU for DormBook.
 * Every change is written to admin_audit.
 */
const bcrypt = require('bcryptjs');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { accountState } = require('../services/accountStatus');
const settings = require('../services/appSettings');
const realtime = require('../services/realtime');
const { istDate, addDays, isValidDate, daysBetween } = require('../util/time');
const { mobile10 } = require('../util/security');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);
const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MODES = ['cash', 'upi', 'bank_transfer', 'card', 'cheque', 'other'];
const STAFF_ROLES = ['owner', 'manager', 'reception'];

function bad(res, msg, status = 400) { return res.status(status).json({ error: msg }); }
/** Whole-second time: tokens carry whole-second issue times (see auth.js). */
function nowSec() { return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(); }

function log(req, action, targetType, targetId, details) {
  try {
    getDb().prepare(`INSERT INTO admin_audit (id, actor_id, actor_name, action, target_type, target_id, details, ip, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(uuidv4(), req.user.id, req.user.name || null, action, targetType || null,
      targetId || null, details ? JSON.stringify(details).slice(0, 4000) : null, req.ip || null, new Date().toISOString());
  } catch (e) { console.error('[ADMIN AUDIT] write failed:', e.message); }
  console.log(`[SUPERADMIN] ${action} ${targetType || ''} ${targetId || ''} by ${req.user.id}`);
}

/** Money typed as rupees (number or text) → paise, or null. Accepts amount_paise too. */
function moneyPaise(b, field) {
  if (b[`${field}_paise`] !== undefined && b[`${field}_paise`] !== null && b[`${field}_paise`] !== '') {
    const n = Number(b[`${field}_paise`]);
    return Number.isInteger(n) && n >= 0 && n <= 1e12 ? n : null;
  }
  if (b[field] === undefined || b[field] === null || b[field] === '') return undefined;
  const n = Number(b[field]);
  return Number.isFinite(n) && n >= 0 && n <= 1e10 ? Math.round(n * 100) : null;
}

function cleanEmail(v) {
  const e = str(v).toLowerCase().trim();
  if (!e) return '';
  return e.length <= 120 && EMAIL_RE.test(e) ? e : null;
}

function emailTaken(db, email, exceptId) {
  return !!db.prepare('SELECT 1 FROM users WHERE lower(email) = ? AND id != ?').get(email, exceptId || '');
}
function mobileTaken(db, mobile, exceptId) {
  // Old rows may hold 91XXXXXXXXXX; compare on the last 10 digits.
  return !!db.prepare("SELECT 1 FROM users WHERE id != ? AND (mobile = ? OR mobile = ('91' || ?))").get(exceptId || '', mobile, mobile);
}

// ── Overview ─────────────────────────────────────────────────────────────────
function overview(req, res) {
  const db = getDb();
  const today = istDate();
  const accounts = db.prepare('SELECT * FROM accounts').all();
  const counts = { total: accounts.length, trial: 0, trial_expired: 0, active: 0, grace: 0, expired: 0, suspended: 0 };
  const renewals = [];
  const trialsEnding = [];
  for (const a of accounts) {
    const st = accountState(a);
    counts[st.status] = (counts[st.status] || 0) + 1;
    if ((st.status === 'active' || st.status === 'grace' || st.status === 'expired') && st.days_left !== null && st.days_left <= 7) {
      renewals.push({ id: a.id, business_name: a.business_name, paid_until: a.paid_until, days_left: st.days_left, status: st.status });
    }
    if (st.status === 'trial' && st.days_left !== null && st.days_left <= 7) {
      trialsEnding.push({ id: a.id, business_name: a.business_name, trial_ends_at: a.trial_ends_at, days_left: st.days_left });
    }
  }
  const month = today.slice(0, 7);
  const lastMonth = addDays(`${month}-01`, -1).slice(0, 7);
  const sum = (where, ...args) => db.prepare(`SELECT COALESCE(SUM(amount_paise),0) s, COUNT(*) n FROM subscription_payments WHERE status = 'paid' ${where}`).get(...args);
  const revenue = {
    this_month: sum("AND substr(paid_on,1,7) = ?", month),
    last_month: sum("AND substr(paid_on,1,7) = ?", lastMonth),
    all_time: sum(''),
  };
  const n = (sql, ...a) => { try { return db.prepare(sql).get(...a).n || 0; } catch (_) { return 0; } };
  res.json({
    today, counts, revenue,
    platform: {
      properties: n('SELECT COUNT(*) n FROM properties'),
      users_active: n("SELECT COUNT(*) n FROM users WHERE is_active = 1 AND role != 'superadmin'"),
      residents_staying: n("SELECT COUNT(*) n FROM residents WHERE status = 'active'"),
      signups_this_month: accounts.filter((a) => String(a.created_at || '').slice(0, 7) === month).length,
    },
    renewals_due: renewals.sort((x, y) => x.days_left - y.days_left).slice(0, 20),
    trials_ending: trialsEnding.sort((x, y) => x.days_left - y.days_left).slice(0, 20),
    recent_signups: accounts.slice().sort((x, y) => (String(x.created_at) < String(y.created_at) ? 1 : -1)).slice(0, 6)
      .map((a) => ({ id: a.id, business_name: a.business_name, created_at: a.created_at, status: accountState(a).status })),
    recent_payments: db.prepare(`SELECT id, invoice_no, business_name, amount_paise, mode, paid_on, status FROM subscription_payments
      ORDER BY created_at DESC LIMIT 6`).all(),
  });
}

// ── Customer accounts (create / edit / extend trial) ────────────────────────
function createAccount(req, res) {
  const db = getDb();
  const { createCustomer } = require('./authController');
  const b = req.body || {};
  const trialDays = b.trial_days === undefined || b.trial_days === '' || b.trial_days === null ? 30 : Number(b.trial_days);
  if (!Number.isInteger(trialDays) || trialDays < 1 || trialDays > 3650) return bad(res, 'Trial days must be a whole number from 1 to 3650');
  let made;
  try {
    made = createCustomer(db, { ...b, trial_days: trialDays });
  } catch (e) {
    if (e.expose) return bad(res, e.message, e.status);
    throw e;
  }
  log(req, 'ACCOUNT_CREATED', 'account', made.accountId, { business_name: str(b.business_name).slice(0, 120) });
  res.status(201).json({ ok: true, account_id: made.accountId, user_id: made.userId });
}

function updateAccount(req, res) {
  const db = getDb();
  const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!a) return bad(res, 'Account not found', 404);
  const b = req.body || {};
  const set = {};
  if (b.business_name !== undefined) {
    const v = str(b.business_name).trim();
    if (!v || v.length > 120) return bad(res, 'Business name is required (max 120 characters)');
    set.business_name = v;
  }
  if (b.plan !== undefined) {
    if (!['trial', 'active'].includes(b.plan)) return bad(res, 'Plan must be "trial" or "active"');
    set.plan = b.plan;
  }
  if (b.trial_ends_at !== undefined) {
    if (b.trial_ends_at === null || b.trial_ends_at === '') set.trial_ends_at = null;
    else if (isValidDate(str(b.trial_ends_at))) set.trial_ends_at = `${b.trial_ends_at}T18:29:59.999Z`;   // end of that day in India
    else return bad(res, 'Trial end must be a date (YYYY-MM-DD)');
  }
  if (b.paid_until !== undefined) {
    if (b.paid_until === null || b.paid_until === '') set.paid_until = null;
    else if (isValidDate(str(b.paid_until))) set.paid_until = str(b.paid_until);
    else return bad(res, 'Paid until must be a date (YYYY-MM-DD)');
  }
  if (b.plan_id !== undefined) {
    if (b.plan_id === null || b.plan_id === '') set.plan_id = null;
    else if (db.prepare('SELECT 1 FROM saas_plans WHERE id = ?').get(str(b.plan_id))) set.plan_id = str(b.plan_id);
    else return bad(res, 'Plan not found');
  }
  if (b.admin_notes !== undefined) {
    const v = str(b.admin_notes).trim();
    if (v.length > 2000) return bad(res, 'Notes are too long (max 2000)');
    set.admin_notes = v || null;
  }
  const keys = Object.keys(set);
  if (!keys.length) return bad(res, 'Nothing to change');
  db.prepare(`UPDATE accounts SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id`)
    .run({ ...set, now: new Date().toISOString(), id: a.id });
  log(req, 'ACCOUNT_UPDATED', 'account', a.id, set);
  res.json({ ok: true, account: { ...a, ...set } });
}

function extendTrial(req, res) {
  const db = getDb();
  const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!a) return bad(res, 'Account not found', 404);
  const days = Number((req.body || {}).days);
  if (!Number.isInteger(days) || days < 1 || days > 365) return bad(res, 'Days must be a whole number from 1 to 365');
  const from = Math.max(Date.now(), Date.parse(a.trial_ends_at || '') || 0);
  const ends = new Date(from + days * 86400000).toISOString();
  db.prepare("UPDATE accounts SET plan = 'trial', trial_ends_at = ?, updated_at = ? WHERE id = ?").run(ends, new Date().toISOString(), a.id);
  log(req, 'TRIAL_EXTENDED', 'account', a.id, { days, trial_ends_at: ends });
  res.json({ ok: true, trial_ends_at: ends });
}

// ── Users (owners and staff of every customer) ──────────────────────────────
function listUsers(req, res) {
  const db = getDb();
  const q = str(req.query.q).trim().toLowerCase().slice(0, 100);
  const role = str(req.query.role);
  const status = str(req.query.status);
  const accountId = str(req.query.account_id);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const where = ["u.role != 'superadmin'"];
  const args = {};
  if (q) {
    where.push(`(lower(u.name) LIKE @q OR lower(COALESCE(u.email,'')) LIKE @q OR u.mobile LIKE @q OR lower(COALESCE(a.business_name,'')) LIKE @q)`);
    args.q = `%${q.replace(/[%_]/g, '')}%`;
  }
  if (STAFF_ROLES.includes(role)) { where.push('u.role = @role'); args.role = role; }
  if (status === 'active') where.push('u.is_active = 1');
  if (status === 'blocked') where.push('u.is_active = 0');
  if (status === 'locked') { where.push('u.locked_until > @now'); args.now = new Date().toISOString(); }
  if (accountId) { where.push('u.account_id = @acc'); args.acc = accountId; }
  const from = `FROM users u LEFT JOIN accounts a ON a.id = u.account_id LEFT JOIN properties p ON p.id = u.property_id WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) n ${from}`).get(args).n;
  const rows = db.prepare(`SELECT u.id, u.name, u.email, u.mobile, u.role, u.is_active, u.created_at, u.last_login_at,
      u.failed_logins, u.locked_until, (u.mpin_hash IS NOT NULL) AS has_mpin,
      u.account_id, a.business_name, p.name AS property_name
    ${from} ORDER BY u.created_at DESC LIMIT @limit OFFSET @offset`).all({ ...args, limit, offset });
  const now = new Date().toISOString();
  res.json({ total, limit, offset, rows: rows.map((r) => ({ ...r, is_active: !!r.is_active, has_mpin: !!r.has_mpin,
    locked: !!(r.locked_until && r.locked_until > now) })) });
}

function getNonAdminUser(db, id) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return u && u.role !== 'superadmin' ? u : null;
}
function otherActiveOwners(db, u) {
  return db.prepare("SELECT COUNT(*) n FROM users WHERE account_id = ? AND role = 'owner' AND is_active = 1 AND id != ?").get(u.account_id, u.id).n;
}

function updateUser(req, res) {
  const db = getDb();
  const u = getNonAdminUser(db, req.params.id);
  if (!u) return bad(res, 'User not found', 404);
  const b = req.body || {};
  const set = {};
  if (b.name !== undefined) {
    const v = str(b.name).trim();
    if (!v || v.length > 120) return bad(res, 'Name is required (max 120 characters)');
    set.name = v;
  }
  if (b.email !== undefined) {
    const e = cleanEmail(b.email);
    if (e === null) return bad(res, 'Email is not valid');
    if (e && emailTaken(db, e, u.id)) return bad(res, 'Another login already uses this email', 409);
    set.email = e || null;
  }
  if (b.mobile !== undefined) {
    const m = mobile10(b.mobile);
    if (!m) return bad(res, 'Mobile must be a 10-digit number');
    if (mobileTaken(db, m, u.id)) return bad(res, 'Another login already uses this mobile', 409);
    set.mobile = m;
  }
  if (b.role !== undefined) {
    if (!STAFF_ROLES.includes(b.role)) return bad(res, 'Role must be owner, manager or reception');
    if (b.role === 'owner' && !u.account_id) return bad(res, 'This login has no business account');
    if (u.role === 'owner' && b.role !== 'owner' && u.is_active && otherActiveOwners(db, u) === 0) {
      return bad(res, 'This is the only owner of the business. Make another user owner first.', 409);
    }
    set.role = b.role;
  }
  if (b.is_active !== undefined) {
    if (typeof b.is_active !== 'boolean') return bad(res, 'is_active must be true or false');
    set.is_active = b.is_active ? 1 : 0;
  }
  const keys = Object.keys(set);
  if (!keys.length) return bad(res, 'Nothing to change');
  const signOut = set.is_active === 0 || (set.role && set.role !== u.role);
  if (signOut) set.pwd_changed_at = nowSec();     // role change / block → sign in again
  db.prepare(`UPDATE users SET ${Object.keys(set).map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id`)
    .run({ ...set, now: new Date().toISOString(), id: u.id });
  if (signOut) realtime.userSignedOut(u.id);
  log(req, 'USER_UPDATED', 'user', u.id, { ...set, pwd_changed_at: undefined });
  res.json({ ok: true });
}

function resetUserPassword(req, res) {
  const db = getDb();
  const u = getNonAdminUser(db, req.params.id);
  if (!u) return bad(res, 'User not found', 404);
  const pwd = str((req.body || {}).new_password).trim();
  if (pwd.length < 8) return bad(res, 'New password must be at least 8 characters');
  if (pwd.length > 200) return bad(res, 'New password is too long');
  db.prepare("UPDATE users SET password_hash = ?, pwd_changed_at = ?, failed_logins = 0, locked_until = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(bcrypt.hashSync(pwd, BCRYPT_ROUNDS), nowSec(), u.id);
  realtime.userSignedOut(u.id);
  log(req, 'USER_PASSWORD_RESET', 'user', u.id, { name: u.name });
  res.json({ ok: true, login: { name: u.name, mobile: u.mobile || '', email: u.email || '' }, password: pwd });
}

function unlockUser(req, res) {
  const db = getDb();
  const u = getNonAdminUser(db, req.params.id);
  if (!u) return bad(res, 'User not found', 404);
  db.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL, updated_at = datetime('now') WHERE id = ?").run(u.id);
  log(req, 'USER_UNLOCKED', 'user', u.id, { name: u.name });
  res.json({ ok: true });
}

/** Delete a login. A login with history (payments, check-ins…) cannot be removed from the books → it is blocked instead. */
function deleteUser(req, res) {
  const db = getDb();
  const u = getNonAdminUser(db, req.params.id);
  if (!u) return bad(res, 'User not found', 404);
  if (u.role === 'owner' && otherActiveOwners(db, u) === 0) {
    return bad(res, 'This is the only owner. To remove the whole business use Customers → Delete.', 409);
  }
  let mode = 'deleted';
  try {
    db.transaction(() => {
      try { db.prepare('DELETE FROM login_codes WHERE user_id = ?').run(u.id); } catch (_) { /* table may be missing */ }
      db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    })();
  } catch (e) {
    if (!/FOREIGN KEY/i.test(e.message)) throw e;
    mode = 'blocked';
    db.prepare("UPDATE users SET is_active = 0, mpin_hash = NULL, pwd_changed_at = ?, updated_at = datetime('now') WHERE id = ?").run(nowSec(), u.id);
  }
  realtime.userSignedOut(u.id);
  log(req, mode === 'deleted' ? 'USER_DELETED' : 'USER_BLOCKED_HAS_HISTORY', 'user', u.id, { name: u.name, role: u.role });
  res.json({ ok: true, mode, message: mode === 'deleted' ? `${u.name} deleted` : `${u.name} has records in the books, so the login was blocked instead of deleted.` });
}

// ── Super-admin logins ───────────────────────────────────────────────────────
function listAdmins(req, res) {
  const rows = getDb().prepare(`SELECT id, name, email, mobile, is_active, created_at, last_login_at, locked_until
    FROM users WHERE role = 'superadmin' ORDER BY created_at`).all();
  res.json(rows.map((r) => ({ ...r, is_active: !!r.is_active, is_me: r.id === req.user.id })));
}

function adminFields(db, b, exceptId, requirePassword) {
  const out = {};
  if (b.name !== undefined || requirePassword) {
    const v = str(b.name).trim();
    if (!v || v.length > 120) return { error: 'Name is required (max 120 characters)' };
    out.name = v;
  }
  if (b.email !== undefined || requirePassword) {
    const e = cleanEmail(b.email);
    if (!e) return { error: 'A valid email is required (super-admins sign in with email)' };
    if (emailTaken(db, e, exceptId)) return { error: 'Another login already uses this email', status: 409 };
    out.email = e;
  }
  if (b.mobile !== undefined && str(b.mobile).trim() !== '') {
    const m = mobile10(b.mobile);
    if (!m) return { error: 'Mobile must be a 10-digit number' };
    if (mobileTaken(db, m, exceptId)) return { error: 'Another login already uses this mobile', status: 409 };
    out.mobile = m;
  }
  if (b.password !== undefined && str(b.password) !== '' || requirePassword) {
    const p = str(b.password);
    if (p.length < 10 || p.length > 200) return { error: 'Super-admin password must be at least 10 characters' };
    out.password_hash = bcrypt.hashSync(p, BCRYPT_ROUNDS);
  }
  return { out };
}

function createAdmin(req, res) {
  const db = getDb();
  const { out, error, status } = adminFields(db, req.body || {}, '', true);
  if (error) return bad(res, error, status);
  const id = uuidv4();
  const now = new Date().toISOString();
  const mobile = out.mobile || `0${String(Date.now()).slice(-9)}`;   // users.mobile is required; super-admins sign in by email
  db.prepare(`INSERT INTO users (id, account_id, property_id, name, email, mobile, password_hash, role, is_active, created_at, updated_at)
    VALUES (?, NULL, NULL, ?, ?, ?, ?, 'superadmin', 1, ?, ?)`).run(id, out.name, out.email, mobile, out.password_hash, now, now);
  log(req, 'ADMIN_CREATED', 'superadmin', id, { name: out.name, email: out.email });
  res.status(201).json({ ok: true, id });
}

function activeAdminCount(db) {
  return db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'superadmin' AND is_active = 1").get().n;
}

function updateAdmin(req, res) {
  const db = getDb();
  const a = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'superadmin'").get(req.params.id);
  if (!a) return bad(res, 'Super-admin not found', 404);
  const b = req.body || {};
  const { out, error, status } = adminFields(db, b, a.id, false);
  if (error) return bad(res, error, status);
  if (b.is_active !== undefined) {
    if (typeof b.is_active !== 'boolean') return bad(res, 'is_active must be true or false');
    if (!b.is_active && a.id === req.user.id) return bad(res, 'You cannot switch off your own login', 409);
    if (!b.is_active && a.is_active && activeAdminCount(db) <= 1) return bad(res, 'At least one super-admin must stay active', 409);
    out.is_active = b.is_active ? 1 : 0;
  }
  if (!Object.keys(out).length) return bad(res, 'Nothing to change');
  const passwordChanged = !!out.password_hash;
  if (passwordChanged || out.is_active === 0) {
    out.pwd_changed_at = nowSec();
    out.failed_logins = 0;
    out.locked_until = null;
  }
  db.prepare(`UPDATE users SET ${Object.keys(out).map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id`)
    .run({ ...out, now: new Date().toISOString(), id: a.id });
  if (a.id !== req.user.id && (passwordChanged || out.is_active === 0)) realtime.userSignedOut(a.id);
  log(req, 'ADMIN_UPDATED', 'superadmin', a.id, { name: out.name, email: out.email, password_changed: passwordChanged, is_active: out.is_active });
  // Changing your OWN password ends your current session too: hand back a fresh one.
  let token;
  if (a.id === req.user.id && passwordChanged) {
    const { makeToken } = require('./authController');
    token = makeToken(db.prepare('SELECT * FROM users WHERE id = ?').get(a.id));
  }
  res.json({ ok: true, ...(token ? { token } : {}) });
}

function deleteAdmin(req, res) {
  const db = getDb();
  const a = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'superadmin'").get(req.params.id);
  if (!a) return bad(res, 'Super-admin not found', 404);
  if (a.id === req.user.id) return bad(res, 'You cannot delete your own login', 409);
  if (a.is_active && activeAdminCount(db) <= 1) return bad(res, 'At least one super-admin must stay active', 409);
  let mode = 'deleted';
  try { db.prepare('DELETE FROM users WHERE id = ?').run(a.id); }
  catch (e) {
    if (!/FOREIGN KEY/i.test(e.message)) throw e;
    mode = 'blocked';
    db.prepare("UPDATE users SET is_active = 0, pwd_changed_at = ?, updated_at = datetime('now') WHERE id = ?").run(nowSec(), a.id);
  }
  realtime.userSignedOut(a.id);
  log(req, mode === 'deleted' ? 'ADMIN_DELETED' : 'ADMIN_BLOCKED', 'superadmin', a.id, { name: a.name, email: a.email });
  res.json({ ok: true, mode });
}

// ── Plans & pricing ──────────────────────────────────────────────────────────
function planFields(b, partial) {
  const out = {};
  if (b.name !== undefined || !partial) {
    const v = str(b.name).trim();
    if (!v || v.length > 60) return { error: 'Plan name is required (max 60 characters)' };
    out.name = v;
  }
  const price = moneyPaise(b, 'price');
  if (price === null) return { error: 'Price must be a number (rupees)' };
  if (price !== undefined) out.price_paise = price; else if (!partial) return { error: 'Price is required' };
  if (b.duration_days !== undefined || !partial) {
    const d = Number(b.duration_days);
    if (!Number.isInteger(d) || d < 1 || d > 3660) return { error: 'Duration must be 1 to 3660 days' };
    out.duration_days = d;
  }
  if (b.max_beds !== undefined) {
    if (b.max_beds === null || b.max_beds === '') out.max_beds = null;
    else {
      const m = Number(b.max_beds);
      if (!Number.isInteger(m) || m < 1 || m > 100000) return { error: 'Bed limit must be a whole number (or empty for no limit)' };
      out.max_beds = m;
    }
  }
  if (b.description !== undefined) {
    const v = str(b.description).trim();
    if (v.length > 500) return { error: 'Description is too long (max 500)' };
    out.description = v || null;
  }
  if (b.is_active !== undefined) {
    if (typeof b.is_active !== 'boolean') return { error: 'is_active must be true or false' };
    out.is_active = b.is_active ? 1 : 0;
  }
  if (b.sort_order !== undefined) {
    const s = Number(b.sort_order);
    if (!Number.isInteger(s) || s < 0 || s > 9999) return { error: 'Sort order must be 0–9999' };
    out.sort_order = s;
  }
  return { out };
}

function listPlans(req, res) {
  const rows = getDb().prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM accounts a WHERE a.plan_id = p.id) AS accounts_on_plan,
      (SELECT COUNT(*) FROM subscription_payments s WHERE s.plan_id = p.id AND s.status = 'paid') AS payments
    FROM saas_plans p ORDER BY p.sort_order, p.price_paise, p.name`).all();
  res.json(rows.map((r) => ({ ...r, is_active: !!r.is_active })));
}

function createPlan(req, res) {
  const { out, error } = planFields(req.body || {}, false);
  if (error) return bad(res, error);
  const id = uuidv4();
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO saas_plans (id, name, price_paise, duration_days, max_beds, description, is_active, sort_order, created_at, updated_at)
    VALUES (@id, @name, @price_paise, @duration_days, @max_beds, @description, @is_active, @sort_order, @now, @now)`)
    .run({ max_beds: null, description: null, is_active: 1, sort_order: 0, ...out, id, now });
  log(req, 'PLAN_CREATED', 'plan', id, out);
  res.status(201).json({ ok: true, id });
}

function updatePlan(req, res) {
  const db = getDb();
  const p = db.prepare('SELECT * FROM saas_plans WHERE id = ?').get(req.params.id);
  if (!p) return bad(res, 'Plan not found', 404);
  const { out, error } = planFields(req.body || {}, true);
  if (error) return bad(res, error);
  if (!Object.keys(out).length) return bad(res, 'Nothing to change');
  db.prepare(`UPDATE saas_plans SET ${Object.keys(out).map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id`)
    .run({ ...out, now: new Date().toISOString(), id: p.id });
  log(req, 'PLAN_UPDATED', 'plan', p.id, out);
  res.json({ ok: true });
}

/** A plan that was ever used (payments / accounts) is hidden, not deleted — invoices keep their plan. */
function deletePlan(req, res) {
  const db = getDb();
  const p = db.prepare('SELECT * FROM saas_plans WHERE id = ?').get(req.params.id);
  if (!p) return bad(res, 'Plan not found', 404);
  const used = db.prepare('SELECT COUNT(*) n FROM subscription_payments WHERE plan_id = ?').get(p.id).n
    + db.prepare('SELECT COUNT(*) n FROM accounts WHERE plan_id = ?').get(p.id).n;
  if (used) {
    db.prepare("UPDATE saas_plans SET is_active = 0, updated_at = ? WHERE id = ?").run(new Date().toISOString(), p.id);
    log(req, 'PLAN_HIDDEN', 'plan', p.id, { name: p.name });
    return res.json({ ok: true, mode: 'hidden', message: `"${p.name}" is used by customers or invoices, so it was hidden instead of deleted.` });
  }
  db.prepare('DELETE FROM saas_plans WHERE id = ?').run(p.id);
  log(req, 'PLAN_DELETED', 'plan', p.id, { name: p.name });
  res.json({ ok: true, mode: 'deleted' });
}

// ── Subscription payments (what owners pay you) ─────────────────────────────
function nextInvoiceNo(db, paidOn) {
  const ym = paidOn.slice(0, 7).replace('-', '');
  const prefix = `DB-${ym}-`;
  const last = db.prepare('SELECT invoice_no FROM subscription_payments WHERE invoice_no LIKE ? ORDER BY invoice_no DESC LIMIT 1').get(`${prefix}%`);
  const n = last ? parseInt(last.invoice_no.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(Number.isFinite(n) ? n : 1).padStart(4, '0')}`;
}

/** The account's paid_until from its non-void payments (null when none). */
function paidUntilFromPayments(db, accountId) {
  const r = db.prepare("SELECT MAX(period_end) m FROM subscription_payments WHERE account_id = ? AND status = 'paid'").get(accountId);
  return r && r.m ? r.m : null;
}

function listPayments(req, res) {
  const db = getDb();
  const where = ['1=1'];
  const args = {};
  const accountId = str(req.query.account_id);
  if (accountId) { where.push('s.account_id = @acc'); args.acc = accountId; }
  const status = str(req.query.status);
  if (status === 'paid' || status === 'void') { where.push('s.status = @status'); args.status = status; }
  const from = str(req.query.from), to = str(req.query.to);
  if (from) { if (!isValidDate(from)) return bad(res, 'from must be YYYY-MM-DD'); where.push('s.paid_on >= @from'); args.from = from; }
  if (to) { if (!isValidDate(to)) return bad(res, 'to must be YYYY-MM-DD'); where.push('s.paid_on <= @to'); args.to = to; }
  const q = str(req.query.q).trim().toLowerCase().slice(0, 100);
  if (q) {
    where.push(`(lower(COALESCE(s.business_name,'')) LIKE @q OR lower(s.invoice_no) LIKE @q OR lower(COALESCE(s.reference,'')) LIKE @q)`);
    args.q = `%${q.replace(/[%_]/g, '')}%`;
  }
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const w = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) n FROM subscription_payments s WHERE ${w}`).get(args).n;
  const totals = db.prepare(`SELECT COALESCE(SUM(CASE WHEN s.status='paid' THEN s.amount_paise END),0) paid_paise,
      SUM(CASE WHEN s.status='paid' THEN 1 ELSE 0 END) paid_count FROM subscription_payments s WHERE ${w}`).get(args);
  const rows = db.prepare(`SELECT s.*, COALESCE(a.business_name, s.business_name) AS business_name, (a.id IS NULL) AS account_deleted
    FROM subscription_payments s LEFT JOIN accounts a ON a.id = s.account_id WHERE ${w}
    ORDER BY s.paid_on DESC, s.created_at DESC LIMIT @limit OFFSET @offset`).all({ ...args, limit, offset });
  res.json({ total, totals: { paid_paise: totals.paid_paise || 0, paid_count: totals.paid_count || 0 }, limit, offset,
    rows: rows.map((r) => ({ ...r, account_deleted: !!r.account_deleted })) });
}

function getPayment(req, res) {
  const db = getDb();
  const p = db.prepare('SELECT * FROM subscription_payments WHERE id = ?').get(req.params.id);
  if (!p) return bad(res, 'Payment not found', 404);
  const owner = db.prepare("SELECT name, mobile, email FROM users WHERE account_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1").get(p.account_id) || {};
  const prop = db.prepare('SELECT city, state, address, gstin FROM properties WHERE account_id = ? ORDER BY created_at LIMIT 1').get(p.account_id) || {};
  res.json({ ...p, owner, property: prop, seller: settings.get('branding').app_name, support: settings.get('support') });
}

function createPayment(req, res) {
  const db = getDb();
  const b = req.body || {};
  const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(str(b.account_id));
  if (!a) return bad(res, 'Choose the customer');
  let plan = null;
  if (b.plan_id) {
    plan = db.prepare('SELECT * FROM saas_plans WHERE id = ?').get(str(b.plan_id));
    if (!plan) return bad(res, 'Plan not found');
  }
  const amount = moneyPaise(b, 'amount');
  const amountPaise = amount === undefined && plan ? plan.price_paise : amount;
  if (amountPaise === null || amountPaise === undefined) return bad(res, 'Amount must be a number (rupees)');
  const mode = str(b.mode);
  if (!MODES.includes(mode)) return bad(res, `Mode must be one of: ${MODES.join(', ')}`);
  const reference = str(b.reference).trim();
  if (reference.length > 120) return bad(res, 'Reference is too long (max 120)');
  const notes = str(b.notes).trim();
  if (notes.length > 1000) return bad(res, 'Notes are too long (max 1000)');
  const today = istDate();
  const paidOn = b.paid_on ? str(b.paid_on) : today;
  if (!isValidDate(paidOn)) return bad(res, 'Payment date must be YYYY-MM-DD');
  if (paidOn > addDays(today, 1)) return bad(res, 'Payment date cannot be in the future');
  const days = b.duration_days !== undefined && b.duration_days !== '' ? Number(b.duration_days) : (plan ? plan.duration_days : NaN);
  if (!Number.isInteger(days) || days < 1 || days > 3660) return bad(res, 'Choose a plan or type how many days this payment covers (1–3660)');

  // Period: continues right after the current paid period, or starts today.
  let start;
  if (b.period_start) {
    if (!isValidDate(str(b.period_start))) return bad(res, 'Period start must be YYYY-MM-DD');
    start = str(b.period_start);
  } else {
    const after = a.plan === 'active' && a.paid_until && a.paid_until >= today ? addDays(a.paid_until, 1) : today;
    start = after;
  }
  const end = addDays(start, days - 1);
  const id = uuidv4();
  const now = new Date().toISOString();
  let invoiceNo;
  db.transaction(() => {
    invoiceNo = nextInvoiceNo(db, paidOn);
    db.prepare(`INSERT INTO subscription_payments (id, account_id, business_name, plan_id, plan_name, invoice_no, amount_paise, mode,
        reference, paid_on, period_start, period_end, notes, status, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'paid', ?, ?, ?)`).run(id, a.id, a.business_name, plan ? plan.id : null,
      plan ? plan.name : `${days} days`, invoiceNo, amountPaise, mode, reference || null, paidOn, start, end, notes || null,
      req.user.id, now, now);
    const paidUntil = paidUntilFromPayments(db, a.id);
    db.prepare(`UPDATE accounts SET plan = 'active', paid_until = ?, plan_id = COALESCE(?, plan_id), updated_at = ? WHERE id = ?`)
      .run(paidUntil, plan ? plan.id : null, now, a.id);
  })();
  log(req, 'PAYMENT_RECORDED', 'payment', id, { account_id: a.id, invoice_no: invoiceNo, amount_paise: amountPaise, period_start: start, period_end: end });
  res.status(201).json({ ok: true, id, invoice_no: invoiceNo, period_start: start, period_end: end,
    still_suspended: !!a.suspended_at });
}

function updatePayment(req, res) {
  const db = getDb();
  const p = db.prepare('SELECT * FROM subscription_payments WHERE id = ?').get(req.params.id);
  if (!p) return bad(res, 'Payment not found', 404);
  if (p.status !== 'paid') return bad(res, 'A void payment cannot be edited', 409);
  const b = req.body || {};
  const set = {};
  if (b.mode !== undefined) { if (!MODES.includes(str(b.mode))) return bad(res, 'Mode is not valid'); set.mode = str(b.mode); }
  if (b.reference !== undefined) { const v = str(b.reference).trim(); if (v.length > 120) return bad(res, 'Reference is too long'); set.reference = v || null; }
  if (b.notes !== undefined) { const v = str(b.notes).trim(); if (v.length > 1000) return bad(res, 'Notes are too long'); set.notes = v || null; }
  if (b.paid_on !== undefined) {
    if (!isValidDate(str(b.paid_on))) return bad(res, 'Payment date must be YYYY-MM-DD');
    if (str(b.paid_on) > addDays(istDate(), 1)) return bad(res, 'Payment date cannot be in the future');
    set.paid_on = str(b.paid_on);
  }
  const amount = moneyPaise(b, 'amount');
  if (amount === null) return bad(res, 'Amount must be a number (rupees)');
  if (amount !== undefined) set.amount_paise = amount;
  if (b.period_end !== undefined) {
    if (!isValidDate(str(b.period_end)) || str(b.period_end) < p.period_start) return bad(res, 'Period end must be a date on or after the period start');
    set.period_end = str(b.period_end);
  }
  if (!Object.keys(set).length) return bad(res, 'Nothing to change');
  db.transaction(() => {
    db.prepare(`UPDATE subscription_payments SET ${Object.keys(set).map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id`)
      .run({ ...set, now: new Date().toISOString(), id: p.id });
    if (set.period_end) {
      db.prepare('UPDATE accounts SET paid_until = ?, updated_at = ? WHERE id = ?').run(paidUntilFromPayments(db, p.account_id), new Date().toISOString(), p.account_id);
    }
  })();
  log(req, 'PAYMENT_UPDATED', 'payment', p.id, { invoice_no: p.invoice_no, ...set });
  res.json({ ok: true });
}

/** Money records are never deleted: a wrong payment is made void (kept, shown struck-out, not counted). */
function voidPayment(req, res) {
  const db = getDb();
  const p = db.prepare('SELECT * FROM subscription_payments WHERE id = ?').get(req.params.id);
  if (!p) return bad(res, 'Payment not found', 404);
  if (p.status === 'void') return bad(res, 'Already void', 409);
  const reason = str((req.body || {}).reason).trim();
  if (!reason || reason.length > 300) return bad(res, 'Write why this payment is void (max 300 characters)');
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE subscription_payments SET status = 'void', void_reason = ?, voided_at = ?, voided_by = ?, updated_at = ? WHERE id = ?")
      .run(reason, now, req.user.id, now, p.id);
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(p.account_id);
    if (acc) {
      // Paid period goes back to what the remaining payments cover; with none left, to the day before this one started.
      const rest = paidUntilFromPayments(db, p.account_id);
      db.prepare('UPDATE accounts SET paid_until = ?, updated_at = ? WHERE id = ?').run(rest || addDays(p.period_start, -1), now, acc.id);
    }
  })();
  log(req, 'PAYMENT_VOIDED', 'payment', p.id, { invoice_no: p.invoice_no, reason });
  res.json({ ok: true });
}

// ── Content (branding, support, FAQ) ─────────────────────────────────────────
function getContent(req, res) {
  res.json({ branding: settings.get('branding'), support: settings.get('support'), faq: settings.get('faq') });
}

function putContent(req, res) {
  const key = str(req.params.key);
  if (!settings.KEYS.includes(key)) return bad(res, 'Unknown content section', 404);
  const b = req.body || {};
  let value;
  try {
    if (key === 'branding') value = settings.cleanBranding(b, settings.get('branding'));
    if (key === 'support') value = settings.cleanSupport(b);
    if (key === 'faq') value = settings.cleanFaq(b.items);
  } catch (e) {
    if (e.expose) return bad(res, e.message, e.status);
    throw e;
  }
  settings.set(key, value, req.user.id);
  log(req, 'CONTENT_UPDATED', 'content', key, key === 'branding' ? { app_name: value.app_name, tagline: value.tagline, logo: !!value.logo_data_url } : value);
  res.json({ ok: true, [key]: value });
}

// ── Reports ──────────────────────────────────────────────────────────────────
function monthsBack(n) {
  const out = [];
  let d = `${istDate().slice(0, 7)}-01`;
  for (let i = 0; i < n; i++) { out.unshift(d.slice(0, 7)); d = addDays(d, -1).slice(0, 7) + '-01'; }
  return out;
}

function reports(req, res) {
  const db = getDb();
  const today = istDate();
  const from = str(req.query.from) || `${today.slice(0, 7)}-01`;
  const to = str(req.query.to) || today;
  if (!isValidDate(from) || !isValidDate(to) || from > to) return bad(res, 'Choose a valid date range');
  if (daysBetween(from, to) > 3660) return bad(res, 'Date range is too long (max 10 years)');

  const months = monthsBack(12);
  const first = `${months[0]}-01`;
  const rev = Object.fromEntries(db.prepare(`SELECT substr(paid_on,1,7) m, SUM(amount_paise) s, COUNT(*) n FROM subscription_payments
    WHERE status='paid' AND paid_on >= ? GROUP BY m`).all(first).map((r) => [r.m, r]));
  // Sign-up time is stored in UTC; shift to India time before taking the month.
  const sign = Object.fromEntries(db.prepare(`SELECT substr(datetime(created_at, '+330 minutes'),1,7) m, COUNT(*) n FROM accounts
    WHERE created_at >= ? GROUP BY m`).all(first).map((r) => [r.m, r.n]));
  const monthly = months.map((m) => ({ month: m, revenue_paise: (rev[m] && rev[m].s) || 0, payments: (rev[m] && rev[m].n) || 0, signups: sign[m] || 0 }));

  const inRange = "status='paid' AND paid_on BETWEEN @from AND @to";
  const range = db.prepare(`SELECT COALESCE(SUM(amount_paise),0) revenue_paise, COUNT(*) payments, COUNT(DISTINCT account_id) customers
    FROM subscription_payments WHERE ${inRange}`).get({ from, to });
  const byMode = db.prepare(`SELECT mode, SUM(amount_paise) amount_paise, COUNT(*) n FROM subscription_payments WHERE ${inRange} GROUP BY mode ORDER BY amount_paise DESC`).all({ from, to });
  const byPlan = db.prepare(`SELECT COALESCE(plan_name,'—') plan, SUM(amount_paise) amount_paise, COUNT(*) n FROM subscription_payments WHERE ${inRange} GROUP BY plan ORDER BY amount_paise DESC`).all({ from, to });
  const signups = db.prepare(`SELECT COUNT(*) n FROM accounts WHERE date(created_at, '+330 minutes') BETWEEN ? AND ?`).get(from, to).n;

  const accounts = db.prepare('SELECT * FROM accounts').all();
  const status = {};
  const due30 = [];
  for (const a of accounts) {
    const st = accountState(a);
    status[st.status] = (status[st.status] || 0) + 1;
    if (['active', 'grace', 'expired'].includes(st.status) && st.days_left !== null && st.days_left <= 30) {
      due30.push({ id: a.id, business_name: a.business_name, paid_until: a.paid_until, days_left: st.days_left, status: st.status });
    }
  }
  const usersByRole = db.prepare("SELECT role, COUNT(*) n FROM users WHERE is_active = 1 AND role != 'superadmin' GROUP BY role").all();
  const topCustomers = db.prepare(`SELECT account_id, MAX(business_name) business_name, SUM(amount_paise) amount_paise, COUNT(*) n
    FROM subscription_payments WHERE status='paid' GROUP BY account_id ORDER BY amount_paise DESC LIMIT 10`).all();
  res.json({ from, to, range: { ...range, signups }, by_mode: byMode, by_plan: byPlan, monthly, status,
    renewals_due_30: due30.sort((x, y) => x.days_left - y.days_left), users_by_role: usersByRole, top_customers: topCustomers });
}

function csv(rows, cols) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;          // never let Excel run a cell as a formula
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.map((c) => c[0]).join(','), ...rows.map((r) => cols.map((c) => cell(c[1](r))).join(','))].join('\r\n');
}

function exportReport(req, res) {
  const db = getDb();
  const type = str(req.query.type);
  const from = str(req.query.from), to = str(req.query.to);
  if ((from && !isValidDate(from)) || (to && !isValidDate(to))) return bad(res, 'Dates must be YYYY-MM-DD');
  const rupee = (p) => (Number(p || 0) / 100).toFixed(2);
  let body;
  if (type === 'payments') {
    const rows = db.prepare(`SELECT * FROM subscription_payments WHERE (@from = '' OR paid_on >= @from) AND (@to = '' OR paid_on <= @to)
      ORDER BY paid_on, invoice_no`).all({ from, to });
    body = csv(rows, [['Invoice', (r) => r.invoice_no], ['Paid on', (r) => r.paid_on], ['Business', (r) => r.business_name],
      ['Plan', (r) => r.plan_name], ['Amount (Rs)', (r) => rupee(r.amount_paise)], ['Mode', (r) => r.mode], ['Reference', (r) => r.reference],
      ['Period start', (r) => r.period_start], ['Period end', (r) => r.period_end], ['Status', (r) => r.status], ['Void reason', (r) => r.void_reason],
      ['Notes', (r) => r.notes]]);
  } else if (type === 'accounts') {
    const rows = db.prepare(`SELECT a.*, (SELECT name FROM saas_plans WHERE id = a.plan_id) plan_name,
      (SELECT o.name FROM users o WHERE o.account_id = a.id AND o.role='owner' ORDER BY o.created_at LIMIT 1) owner_name,
      (SELECT o.mobile FROM users o WHERE o.account_id = a.id AND o.role='owner' ORDER BY o.created_at LIMIT 1) owner_mobile,
      (SELECT o.email FROM users o WHERE o.account_id = a.id AND o.role='owner' ORDER BY o.created_at LIMIT 1) owner_email,
      (SELECT COALESCE(SUM(amount_paise),0) FROM subscription_payments s WHERE s.account_id = a.id AND s.status='paid') paid_total
      FROM accounts a ORDER BY a.created_at`).all();
    body = csv(rows, [['Business', (r) => r.business_name], ['Owner', (r) => r.owner_name], ['Mobile', (r) => r.owner_mobile],
      ['Email', (r) => r.owner_email], ['Status', (r) => accountState(r).status], ['Plan', (r) => r.plan_name || r.plan],
      ['Trial ends', (r) => (r.trial_ends_at || '').slice(0, 10)], ['Paid until', (r) => r.paid_until], ['Total paid (Rs)', (r) => rupee(r.paid_total)],
      ['Joined', (r) => (r.created_at || '').slice(0, 10)], ['Suspended', (r) => (r.suspended_at ? 'yes' : '')], ['Notes', (r) => r.admin_notes]]);
  } else if (type === 'users') {
    const rows = db.prepare(`SELECT u.*, a.business_name FROM users u LEFT JOIN accounts a ON a.id = u.account_id
      WHERE u.role != 'superadmin' ORDER BY a.business_name, u.role, u.name`).all();
    body = csv(rows, [['Business', (r) => r.business_name], ['Name', (r) => r.name], ['Role', (r) => r.role], ['Mobile', (r) => r.mobile],
      ['Email', (r) => r.email], ['Active', (r) => (r.is_active ? 'yes' : 'no')], ['Last sign-in', (r) => (r.last_login_at || '').slice(0, 16)],
      ['Created', (r) => (r.created_at || '').slice(0, 10)]]);
  } else {
    return bad(res, 'type must be payments, accounts or users');
  }
  log(req, 'REPORT_EXPORTED', 'report', type, { from, to });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="dormbook-${type}-${istDate()}.csv"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(body);
}

// ── System health, backups ───────────────────────────────────────────────────
async function system(req, res) {
  const db = getDb();
  const { dbPath } = require('../db/init');
  const { listBackups } = require('../db/backup');
  const size = (f) => { try { return Math.round(fs.statSync(f).size / 1024); } catch (_) { return 0; } };
  let integrity = 'not checked';
  if (req.query.check === '1') {
    try { integrity = db.prepare('PRAGMA quick_check').get().quick_check; } catch (e) { integrity = e.message; }
  }
  const env = require('../util/env');
  res.json({
    version: realtime.getVersion(), node: process.version, platform: env.platform(),
    uptime_minutes: Math.round(process.uptime() / 60), memory_mb: Math.round(process.memoryUsage().rss / 1048576),
    database: { path: dbPath, kb: size(dbPath), wal_kb: size(`${dbPath}-wal`), integrity },
    backups: await listBackups(dbPath),
    live: realtime.stats(),
    settings: {
      otp_enabled: process.env.OTP_ENABLED === 'true',
      grace_days: require('../services/accountStatus').graceDays(),
      scheduler: process.env.DISABLE_SCHEDULER === 'true' ? 'off' : 'on',
      offsite: require('../services/offsite').names(),
      whatsapp: !!process.env.WHATSAPP_API_TOKEN,
      public_url: process.env.PUBLIC_URL || '',
    },
  });
}

async function backupNow(req, res) {
  const db = getDb();
  const { dbPath } = require('../db/init');
  const { backupDb, pushToR2 } = require('../db/backup');
  const file = backupDb(db, dbPath, 'manual', { upload: false });
  if (!file) return bad(res, 'Backup could not be made — see the server log', 500);
  const up = await pushToR2(file, 'manual');
  const offsiteText = up.skipped ? 'not set up'
    : `${up.stores && up.stores.length ? `copied to ${up.stores.join(' + ')}` : 'not copied'}${up.error ? ` (problem: ${up.error})` : ''}`;
  log(req, 'BACKUP_MADE', 'system', null, { file: require('path').basename(file), offsite: offsiteText });
  res.json({ ok: true, file: require('path').basename(file), offsite: offsiteText, offsite_ok: !!up.ok, offsite_skipped: !!up.skipped });
}

async function syncUploads(req, res) {
  const out = await require('./documentsController').syncUploadsToR2();
  log(req, 'UPLOADS_SYNCED', 'system', null, out);
  res.json({ ok: true, ...out });
}

function audit(req, res) {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const rows = getDb().prepare('SELECT * FROM admin_audit ORDER BY created_at DESC LIMIT ?').all(limit);
  res.json(rows.map((r) => { let d = null; try { d = r.details ? JSON.parse(r.details) : null; } catch (_) { d = r.details; } return { ...r, details: d }; }));
}

module.exports = {
  overview, createAccount, updateAccount, extendTrial,
  listUsers, updateUser, resetUserPassword, unlockUser, deleteUser,
  listAdmins, createAdmin, updateAdmin, deleteAdmin,
  listPlans, createPlan, updatePlan, deletePlan,
  listPayments, getPayment, createPayment, updatePayment, voidPayment,
  getContent, putContent, reports, exportReport, system, backupNow, syncUploads, audit, log,
  MODES,
};
