'use strict';

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { insertAdaptive } = require('../util/dbcompat');
const { scheduleWhatsApp } = require('../services/whatsappService');
const sms = require('../services/smsService');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);
const DUMMY_HASH    = '$2a$12$eLr2FWz7m3VbmJBbCzKQWOaOEDtB7lGS6cLUvp5Kx3kH1AHdmq0W6';

// Wrong password / MPIN: exponential back-off per account (numbers in src/middleware/rateLimits.js,
// all configurable). After MPIN_WIPE_AT wrong tries in a row the MPIN stops working and the
// owner must give a new login code.
const { CFG: RL, backoffSeconds, waitText } = require('../middleware/rateLimits');
const MPIN_WIPE_AT = RL.mpinWipeAt;
const OTP_MAX_TRIES = 5;

// Same secret for signing and verifying (previously login signed with a dev
// fallback while the middleware rejected it in production → every request 401).
const { getJwtSecret } = require('../middleware/auth');
const { effectivePermissions } = require('../middleware/permissions');

function makeToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, property: user.property_id, account: user.account_id },
    getJwtSecret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h', algorithm: 'HS256' }
  );
}

/** Plan / trial facts the app shows the owner (banner, "choose a plan"). Never blocks anything. */
function accountInfo(user) {
  if (!user || user.role === 'superadmin' || !user.account_id) return null;
  try {
    const db = getDb();
    const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(user.account_id);
    if (!a) return null;
    const st = require('../services/accountStatus').accountState(a);
    let planName = null;
    try { planName = a.plan_id ? (db.prepare('SELECT name FROM saas_plans WHERE id = ?').get(a.plan_id) || {}).name || null : null; } catch (_) { /* table added at boot */ }
    return { business_name: a.business_name, status: st.status, days_left: st.days_left,
      trial_ends_at: a.trial_ends_at || null, paid_until: a.paid_until || null, plan_name: planName };
  } catch (_) { return null; }
}

function publicUser(user) {
  return {
    id:          user.id,
    name:        user.name,
    email:       user.email,
    mobile:      user.mobile,
    role:        user.role,
    property_id: user.property_id,
    account_id:  user.account_id,
    has_mpin:    !!user.mpin_hash,
    permissions: effectivePermissions(user),   // what this user may do (drives the menu)
    account:     accountInfo(user),            // trial / plan status for the banner
  };
}

/** Why this user's business can't sign in right now (or null). Superadmin is never blocked. */
function accountBlock(db, user) {
  if (user.role === 'superadmin' || !user.account_id) return null;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(user.account_id);
  return require('../services/accountStatus').accountProblem(account);
}

const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

/** Record a wrong password / MPIN. Wait grows 30 s, 1 min, 2 min… (capped); wipes the MPIN at MPIN_WIPE_AT. */
function recordFailure(db, user) {
  const n = (user.failed_logins || 0) + 1;
  const wait = backoffSeconds(n);
  const lock = wait ? new Date(Date.now() + wait * 1000).toISOString() : null;
  db.prepare('UPDATE users SET failed_logins = ?, locked_until = COALESCE(?, locked_until) WHERE id = ?').run(n, lock, user.id);
  if (n >= MPIN_WIPE_AT && user.mpin_hash) {
    db.prepare('UPDATE users SET mpin_hash = NULL WHERE id = ?').run(user.id);
    console.warn(`[AUTH] MPIN switched off after ${n} wrong tries for user ${user.id}`);
  }
  return lock;
}
/** Is this user in a back-off wait right now? Returns the wait message or null. */
function waitingMessage(user) {
  if (user && user.locked_until && user.locked_until > new Date().toISOString()) {
    return `Too many wrong tries. Try again in ${waitText(user.locked_until)}.`;
  }
  return null;
}
function clearFailures(db, user) {
  if (user.failed_logins || user.locked_until) db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(user.id);
}

/** POST /api/v1/auth/login — email or mobile + password, or mobile + MPIN (4/6 digits). */
function login(req, res) {
  const body = req.body || {};
  const identifier = str(body.email || body.mobile).toLowerCase().trim();
  const secret = str(body.password);
  if (!identifier || !secret) {
    return res.status(400).json({ error: 'Login credential and password are required' });
  }
  if (identifier.length > 120 || secret.length > 200) return res.status(400).json({ error: 'Invalid credentials' });

  let db;
  try { db = getDb(); } catch (err) {
    console.error('[AUTH] DB not ready:', err.message);
    return res.status(503).json({ error: 'Service temporarily unavailable' });
  }

  const digits = identifier.replace(/\D/g, '');
  const asMobile = /^[\d\s+()-]+$/.test(identifier) ? (digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits) : identifier;
  // Emails match without caring about capital letters (staff emails may have
  // been saved as typed, e.g. "Ravi@Gmail.com").
  const user = db.prepare('SELECT * FROM users WHERE (lower(email) = ? OR mobile = ?) AND is_active = 1').get(identifier, asMobile);

  const waiting = waitingMessage(user);
  if (waiting) return res.status(429).json({ error: waiting });

  // 4 or 6 digits = MPIN (passwords are at least 8 characters).
  const isMpin = !!(user && user.mpin_hash && /^(\d{4}|\d{6})$/.test(secret));
  const hashToCheck = user ? (isMpin ? user.mpin_hash : user.password_hash) : DUMMY_HASH;
  let valid = false;
  try { valid = bcrypt.compareSync(secret, hashToCheck); } catch (_) { valid = false; }
  // A phone keyboard may add a space before/after the password. If the exact
  // text fails, try once without those outer spaces.
  if (!valid && user && !isMpin && secret.trim() !== secret && secret.trim().length >= 8) {
    try { valid = bcrypt.compareSync(secret.trim(), user.password_hash); } catch (_) { valid = false; }
  }

  if (!user || !valid) {
    if (user) {
      const lock = recordFailure(db, user);
      if (lock) return res.status(429).json({ error: `Too many wrong tries. Try again in ${waitText(lock)}.` });
    }
    return res.status(401).json({ error: /^\d{4,6}$/.test(secret) ? 'Wrong mobile number or MPIN' : 'Invalid credentials' });
  }

  const blocked = accountBlock(db, user);
  if (blocked) return res.status(403).json({ error: blocked, code: 'ACCOUNT_BLOCKED' });

  clearFailures(db, user);
  try { db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id); }
  catch (_) { /* column added at boot; never block a sign-in over it */ }
  return res.json({ token: makeToken(user), user: publicUser(user) });
}

/** Is password reset by OTP (WhatsApp / SMS) switched on? Off unless OTP_ENABLED=true. */
function otpEnabled() { return process.env.OTP_ENABLED === 'true'; }
const OTP_OFF = 'Password reset by OTP is switched off. Ask DormBook support to reset your password.';

/**
 * Make a new business: account + first property + owner login, all or nothing.
 * Used by self sign-up and by the super-admin "Add customer" screen.
 * Returns { userId, accountId, propertyId } or throws { status, message }.
 */
function createCustomer(db, f) {
  const fail = (status, message) => { throw Object.assign(new Error(message), { status, expose: true }); };
  const business_name = str(f.business_name).trim().slice(0, 120);
  const owner_name = str(f.owner_name).trim().slice(0, 120);
  const password = str(f.password);
  const email = str(f.email).toLowerCase().trim().slice(0, 120);
  const pg_name = str(f.pg_name).trim().slice(0, 120);
  const city = str(f.city).trim().slice(0, 60);
  if (!business_name || !owner_name || !f.mobile || !password) {
    fail(400, 'business_name, owner_name, mobile, and password are required');
  }
  if (password.length < 8 || password.length > 200) fail(400, 'Password must be at least 8 characters');
  const mobileTrim = str(f.mobile).replace(/\D/g, '');
  if (mobileTrim.length < 10 || mobileTrim.length > 13) fail(400, 'Invalid mobile number');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Email is not valid');
  if (db.prepare('SELECT id FROM users WHERE mobile = ?').get(mobileTrim)) fail(409, 'Mobile number already registered');
  if (email && db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email)) fail(409, 'Email already registered');

  const trialDays = Number.isInteger(f.trial_days) && f.trial_days >= 1 && f.trial_days <= 3650 ? f.trial_days : 30;
  const accountId  = uuidv4();
  const propertyId = uuidv4();
  const userId     = uuidv4();
  const now        = new Date().toISOString();
  const trialEnds  = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000).toISOString();
  const hash       = bcrypt.hashSync(password, BCRYPT_ROUNDS);

  try {
    db.transaction(() => {
      // insertAdaptive: older databases have extra NOT NULL columns
      // (owner_name, owner_mobile, owner_id, city NOT NULL) — fill them when
      // present so signup works on every schema version.
      insertAdaptive(db, 'accounts', {
        id: accountId, business_name, plan: 'trial', trial_ends_at: trialEnds,
        created_at: now, owner_name, owner_mobile: mobileTrim,
        owner_email: email || null,
      });

      insertAdaptive(db, 'properties', {
        id: propertyId, account_id: accountId, name: pg_name || business_name,
        city, owner_id: userId, created_at: now,
      });

      db.prepare(`
        INSERT INTO users (id, account_id, property_id, name, email, mobile, role, password_hash, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'owner', ?, 1, ?)
      `).run(userId, accountId, propertyId, owner_name, email || null, mobileTrim, hash, now);
    })();
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) fail(409, 'Email or mobile already registered');
    console.error('[AUTH] create customer failed:', err.message);
    fail(500, 'Registration failed — please try again');
  }
  return { userId, accountId, propertyId };
}

/** POST /api/v1/auth/register — self-serve signup */
function register(req, res) {
  const db = getDb();
  let made;
  try {
    // Self sign-up always gets the standard 30-day trial (trial_days is only for the super-admin).
    made = createCustomer(db, { ...(req.body || {}), trial_days: undefined });
  } catch (e) {
    if (e.expose) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(made.userId);
  return res.status(201).json({ token: makeToken(user), user: publicUser(user) });
}

/** POST /api/v1/auth/forgot-password */
async function forgotPassword(req, res) {
  if (!otpEnabled()) return res.status(410).json({ error: OTP_OFF, code: 'OTP_OFF' });
  // Always returns 200 — prevents mobile enumeration
  const mobileTrim = str((req.body || {}).mobile).replace(/\D/g, '');
  if (!/^\d{10,13}$/.test(mobileTrim)) return res.json({ ok: true });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE mobile = ? AND is_active = 1').get(mobileTrim);

  if (!user) {
    return res.json({ ok: true });
  }

  // Generate 6-digit OTP (crypto-random)
  const otp     = String(crypto.randomInt(100000, 1000000));
  const otpHash = bcrypt.hashSync(otp, 10); // fewer rounds — OTP is short-lived
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const id = uuidv4();

  // Invalidate old OTPs for this mobile
  db.prepare("DELETE FROM otp_store WHERE mobile = ?").run(mobileTrim);
  db.prepare(`
    INSERT INTO otp_store (id, mobile, otp_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(id, mobileTrim, otpHash, expiresAt);

  // SMS when MSG91 is set up (non-blocking)
  sms.sendLoginCode(mobileTrim.slice(-10), otp).catch(() => {});
  // Send via WhatsApp (non-blocking)
  scheduleWhatsApp({
    propertyId:     user.property_id || null,
    residentId:     null,
    recipientMobile: mobileTrim,
    recipientType:  'user',
    eventType:      'otp_password_reset',
    templateData:   { name: user.name, otp },
  }).catch(err => console.error('[AUTH] forgot-password WhatsApp failed:', err.message));

  return res.json({ ok: true });
}

/** POST /api/v1/auth/reset-password */
function resetPassword(req, res) {
  if (!otpEnabled()) return res.status(410).json({ error: OTP_OFF, code: 'OTP_OFF' });
  const b = req.body || {};
  const mobile = str(b.mobile), otp = str(b.otp), new_password = str(b.new_password);
  if (!mobile || !otp || !new_password) {
    return res.status(400).json({ error: 'mobile, otp, and new_password are required' });
  }
  if (new_password.length < 8 || new_password.length > 200) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const mobileTrim = mobile.replace(/\D/g, '');
  const db = getDb();

  const record = db.prepare(
    'SELECT * FROM otp_store WHERE mobile = ? AND julianday(expires_at) > julianday(\'now\')'
  ).get(mobileTrim);

  if (!record || (record.attempts || 0) >= OTP_MAX_TRIES) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }
  if (!bcrypt.compareSync(otp, record.otp_hash)) {
    // 5 wrong guesses and this OTP is dead — stops guessing all 1,000,000 codes.
    db.prepare('UPDATE otp_store SET attempts = attempts + 1 WHERE id = ?').run(record.id);
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }

  // OTP valid — update password, end old sessions, clear OTP and any lock
  const hash = bcrypt.hashSync(new_password, BCRYPT_ROUNDS);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, pwd_changed_at = ?, failed_logins = 0, locked_until = NULL, updated_at = datetime('now') WHERE mobile = ? AND is_active = 1")
      .run(hash, now, mobileTrim);
    db.prepare('DELETE FROM otp_store WHERE mobile = ?').run(mobileTrim);
  })();

  return res.json({ ok: true, message: 'Password reset successfully' });
}

/** POST /api/v1/auth/change-password */
function changePassword(req, res) {
  const b = req.body || {};
  const current_password = str(b.current_password), new_password = str(b.new_password);
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Both current and new password are required' });
  }
  if (new_password.length < 8 || new_password.length > 200) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(401).json({ error: 'User not found or deactivated' });
  const waiting = waitingMessage(user);
  if (waiting) return res.status(429).json({ error: waiting });
  let okPwd = false;
  try { okPwd = !!user.password_hash && bcrypt.compareSync(current_password, user.password_hash); } catch (_) { okPwd = false; }
  if (!okPwd) {
    // Counts toward back-off, so a stolen session can't guess the password forever.
    recordFailure(db, user);
    return res.status(400).json({ error: 'Current password is incorrect' });   // 400, not 401: a typo must not sign you out
  }
  clearFailures(db, user);
  const now = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  db.prepare("UPDATE users SET password_hash = ?, pwd_changed_at = ?, updated_at = datetime('now') WHERE id = ?")
    .run(bcrypt.hashSync(new_password, BCRYPT_ROUNDS), now, req.user.id);

  // Other devices are signed out; this one gets a fresh token.
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  return res.json({ ok: true, message: 'Password changed successfully', token: makeToken(fresh) });
}

/** GET /api/v1/auth/me — return the currently authenticated user */
function me(req, res) {
  const db = getDb();
  const user = db.prepare(
    'SELECT * FROM users WHERE id = ?'
  ).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  return res.json({ user: publicUser(user) });
}

module.exports = {
  login, register, forgotPassword, resetPassword, changePassword, me,
  makeToken, publicUser, accountBlock, recordFailure, waitingMessage, clearFailures,
  createCustomer, otpEnabled,
};
