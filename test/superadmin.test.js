'use strict';
// Super-admin panel end to end: super-admin logins, users, plans, subscription payments,
// content + logo, reports + CSV, system, audit, OTP switched off, live updates, and
// R2 backups + restore (against a small fake R2 server).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { boot } = require('./helpers');
const { istDate, addDays } = require('../src/util/time');

const TODAY = istDate();
const port = () => 25000 + Math.floor(Math.random() * 4000);
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function owner(s, n) {
  s.setToken(null);
  const r = await s.call('POST', '/auth/register', { business_name: `Biz ${n}`, owner_name: `Owner ${n}`, mobile: `98111000${n}0`,
    password: 'Passw0rd!23', pg_name: `PG ${n}`, city: 'Delhi' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
async function superLogin(s, email = 'superadmin@dormbook.in', password = 'Sup3r!secret') {
  s.setToken(null);
  const r = await s.call('POST', '/auth/login', { email, password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  s.setToken(r.body.token);
  return r.body;
}

test('super-admin panel: admins, users, plans, payments, content, reports, system', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-sa-'));
  const s = await boot({ dbDir, port: port() });
  const { call } = s;
  try {
    const o1 = await owner(s, 1);
    const o2 = await owner(s, 2);
    s.setToken(o1.token);
    let r = await call('POST', '/staff', { name: 'Desk One', mobile: '9811100099', role: 'reception', password: 'Desk@12345' });
    assert.ok(r.status < 300, JSON.stringify(r.body));

    // Owners can never reach the admin panel
    for (const p of ['/admin/overview', '/admin/users', '/admin/admins', '/admin/plans', '/admin/payments', '/admin/content', '/admin/reports', '/admin/system', '/admin/audit']) {
      assert.equal((await call('GET', p)).status, 403, p);
    }
    assert.equal((await call('POST', '/admin/admins', { name: 'x', email: 'x@y.in', password: 'Abcdefgh123' })).status, 403);

    const me = await superLogin(s);

    // ── Super-admin logins ──
    r = await call('POST', '/admin/admins', { name: 'Second Admin', email: 'Two@DormBook.in', password: 'short' });
    assert.equal(r.status, 400);
    r = await call('POST', '/admin/admins', { name: 'Second Admin', email: 'Two@DormBook.in', password: 'Second#Admin1' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const two = r.body.id;
    r = await call('POST', '/admin/admins', { name: 'Dup', email: 'two@dormbook.in', password: 'Second#Admin1' });
    assert.equal(r.status, 409, 'email taken (any capitals)');
    r = await call('GET', '/admin/admins');
    assert.equal(r.body.length, 2);
    assert.ok(r.body.find((a) => a.is_me));
    // second admin can sign in, edit, then is deleted
    s.setToken(null);
    r = await call('POST', '/auth/login', { email: 'two@dormbook.in', password: 'Second#Admin1' });
    assert.equal(r.status, 200);
    const twoToken = r.body.token;
    await new Promise((x) => setTimeout(x, 1100));   // sessions are timed in whole seconds
    s.setToken(me.token);
    r = await call('PATCH', `/admin/admins/${two}`, { name: 'Admin Two', password: 'Changed#Pass22' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    s.setToken(twoToken);
    assert.equal((await call('GET', '/admin/overview')).status, 401, 'old session ends after password change');
    s.setToken(me.token);
    r = await call('PATCH', `/admin/admins/${me.user.id}`, { is_active: false });
    assert.equal(r.status, 409, 'cannot switch yourself off');
    r = await call('DELETE', `/admin/admins/${me.user.id}`);
    assert.equal(r.status, 409, 'cannot delete yourself');
    r = await call('DELETE', `/admin/admins/${two}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('GET', '/admin/admins');
    assert.equal(r.body.length, 1);
    // own password change hands back a fresh token
    r = await call('PATCH', `/admin/admins/${me.user.id}`, { password: 'NewSuper#Pass1' });
    assert.equal(r.status, 200); assert.ok(r.body.token);
    s.setToken(r.body.token);
    assert.equal((await call('GET', '/admin/overview')).status, 200);

    // ── Users ──
    r = await call('GET', '/admin/users');
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 3, 'two owners + one staff, never the super-admin');
    r = await call('GET', '/admin/users?q=desk');
    assert.equal(r.body.rows.length, 1);
    const desk = r.body.rows[0];
    assert.equal(desk.role, 'reception'); assert.equal(desk.business_name, 'Biz 1');
    r = await call('PATCH', `/admin/users/${desk.id}`, { name: 'Desk Renamed', mobile: '98111 00098', role: 'manager' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('PATCH', `/admin/users/${desk.id}`, { mobile: '9811100010' });
    assert.equal(r.status, 409, 'mobile of owner 1');
    r = await call('PATCH', `/admin/users/${o1.user.id}`, { role: 'manager' });
    assert.equal(r.status, 409, 'only owner cannot be demoted');
    r = await call('POST', `/admin/users/${desk.id}/reset-password`, { new_password: 'Fresh#Desk1' });
    assert.equal(r.status, 200);
    s.setToken(null);
    r = await call('POST', '/auth/login', { mobile: '9811100098', password: 'Fresh#Desk1' });
    assert.equal(r.status, 200, 'staff signs in with the new password');
    assert.equal(r.body.user.role, 'manager');
    s.setToken(r.body.token);
    assert.equal((await call('GET', '/admin/users')).status, 403);
    // lock by wrong tries → unlock
    s.setToken(null);
    for (let i = 0; i < 6; i++) await call('POST', '/auth/login', { mobile: '9811100098', password: 'wrong-password' });
    r = await call('POST', '/auth/login', { mobile: '9811100098', password: 'Fresh#Desk1' });
    assert.equal(r.status, 429);
    s.setToken((await superLogin(s, 'superadmin@dormbook.in', 'NewSuper#Pass1')).token);
    r = await call('GET', '/admin/users?status=locked');
    assert.equal(r.body.rows.length, 1);
    assert.equal((await call('POST', `/admin/users/${desk.id}/unlock`)).status, 200);
    s.setToken(null);
    assert.equal((await call('POST', '/auth/login', { mobile: '9811100098', password: 'Fresh#Desk1' })).status, 200);
    s.setToken((await superLogin(s, 'superadmin@dormbook.in', 'NewSuper#Pass1')).token);
    // block / unblock
    assert.equal((await call('PATCH', `/admin/users/${desk.id}`, { is_active: false })).status, 200);
    s.setToken(null);
    assert.equal((await call('POST', '/auth/login', { mobile: '9811100098', password: 'Fresh#Desk1' })).status, 401);
    s.setToken((await superLogin(s, 'superadmin@dormbook.in', 'NewSuper#Pass1')).token);
    // delete: staff with no history → really deleted; the only owner → refused
    r = await call('DELETE', `/admin/users/${desk.id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(['deleted', 'blocked'].includes(r.body.mode));
    assert.equal((await call('DELETE', `/admin/users/${o2.user.id}`)).status, 409);
    assert.equal((await call('PATCH', `/admin/users/${me.user.id}`, { name: 'x' })).status, 404, 'super-admins are not edited here');

    // ── Create a customer from the panel ──
    r = await call('POST', '/admin/accounts', { business_name: 'Panel PG', owner_name: 'Panel Owner', mobile: '9811100300',
      password: 'Panel#Pass1', pg_name: 'Panel PG', trial_days: 7 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const panelAcc = r.body.account_id;
    r = await call('POST', '/admin/accounts', { business_name: 'Again', owner_name: 'X', mobile: '9811100300', password: 'Panel#Pass1' });
    assert.equal(r.status, 409);

    // ── Plans ──
    r = await call('POST', '/admin/plans', { name: 'Monthly', price: 499, duration_days: 30, max_beds: 50 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const monthly = r.body.id;
    r = await call('POST', '/admin/plans', { name: 'Yearly', price: '4999.50', duration_days: 365 });
    assert.equal(r.status, 201);
    const yearly = r.body.id;
    r = await call('POST', '/admin/plans', { name: 'Bad', price: -1, duration_days: 30 });
    assert.equal(r.status, 400);
    r = await call('PATCH', `/admin/plans/${yearly}`, { price: 4999, description: 'Best value' });
    assert.equal(r.status, 200);
    r = await call('GET', '/admin/plans');
    assert.deepEqual(r.body.map((p) => [p.name, p.price_paise]), [['Monthly', 49900], ['Yearly', 499900]]);
    s.setToken(null);
    r = await call('GET', '/public/config');
    assert.equal(r.status, 200);
    assert.equal(r.body.plans.length, 2, 'active plans are public (for the sign-up screen)');
    assert.equal(r.body.otp_enabled, false);
    s.setToken((await superLogin(s, 'superadmin@dormbook.in', 'NewSuper#Pass1')).token);

    // ── Subscription payments ──
    const acc1 = o1.user.account_id;
    r = await call('POST', '/admin/payments', { account_id: acc1, plan_id: monthly, mode: 'upi', reference: 'UPI123' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const pay1 = r.body;
    assert.match(pay1.invoice_no, /^DB-\d{6}-0001$/);
    assert.equal(pay1.period_start, TODAY);
    assert.equal(pay1.period_end, addDays(TODAY, 29));
    r = await call('POST', '/admin/payments', { account_id: acc1, plan_id: monthly, mode: 'cash' });
    assert.equal(r.status, 201);
    assert.equal(r.body.period_start, addDays(TODAY, 30), 'second payment continues after the first');
    assert.match(r.body.invoice_no, /-0002$/);
    const pay2 = r.body;
    r = await call('GET', `/admin/accounts/${acc1}`);
    assert.equal(r.body.status, 'active');
    assert.equal(r.body.paid_until, addDays(TODAY, 59));
    assert.equal(r.body.subscription_payments.length, 2);
    r = await call('POST', '/admin/payments', { account_id: acc1, mode: 'cash', amount: 100 });
    assert.equal(r.status, 400, 'no plan and no days');
    r = await call('POST', '/admin/payments', { account_id: acc1, mode: 'bitcoin', plan_id: monthly });
    assert.equal(r.status, 400);
    r = await call('POST', '/admin/payments', { account_id: acc1, plan_id: monthly, mode: 'cash', paid_on: addDays(TODAY, 5) });
    assert.equal(r.status, 400, 'no future payments');
    r = await call('PATCH', `/admin/payments/${pay1.id}`, { reference: 'UPI-REF-9', notes: 'checked' });
    assert.equal(r.status, 200);
    r = await call('POST', `/admin/payments/${pay2.id}/void`, {});
    assert.equal(r.status, 400, 'reason required');
    r = await call('POST', `/admin/payments/${pay2.id}/void`, { reason: 'Entered twice' });
    assert.equal(r.status, 200);
    r = await call('GET', `/admin/accounts/${acc1}`);
    assert.equal(r.body.paid_until, addDays(TODAY, 29), 'void gives the days back');
    r = await call('PATCH', `/admin/payments/${pay2.id}`, { notes: 'x' });
    assert.equal(r.status, 409);
    r = await call('GET', '/admin/payments');
    assert.equal(r.body.total, 2);
    assert.equal(r.body.totals.paid_paise, 49900, 'void not counted');
    r = await call('GET', `/admin/payments/${pay1.id}`);
    assert.equal(r.body.owner.name, 'Owner 1');

    // ── Subscription end blocks the business after the grace days; payment brings it back ──
    r = await call('PATCH', `/admin/accounts/${acc1}`, { paid_until: addDays(TODAY, -30) });
    assert.equal(r.status, 200);
    s.setToken(null);
    r = await call('POST', '/auth/login', { mobile: '9811100010', password: 'Passw0rd!23' });
    assert.equal(r.status, 403); assert.match(r.body.error, /Subscription ended/);
    s.setToken(o1.token);
    assert.equal((await call('GET', '/dashboard/today')).status, 403, 'open sessions are blocked too');
    s.setToken((await superLogin(s, 'superadmin@dormbook.in', 'NewSuper#Pass1')).token);
    r = await call('PATCH', `/admin/accounts/${acc1}`, { paid_until: addDays(TODAY, -3) });
    s.setToken(o1.token);
    assert.equal((await call('GET', '/dashboard/today')).status, 200, 'still works inside the grace days');
    s.setToken((await superLogin(s, 'superadmin@dormbook.in', 'NewSuper#Pass1')).token);
    r = await call('POST', `/admin/accounts/${panelAcc}/extend-trial`, { days: 10 });
    assert.equal(r.status, 200);
    r = await call('PATCH', `/admin/accounts/${panelAcc}`, { business_name: 'Panel PG Renamed', admin_notes: 'VIP' });
    assert.equal(r.status, 200);
    r = await call('PATCH', `/admin/accounts/${acc1}/suspend`, { reason: 'Test' });
    assert.equal(r.status, 200);
    r = await call('PATCH', `/admin/accounts/${acc1}/unsuspend`);
    assert.equal(r.status, 200);
    r = await call('GET', '/admin/accounts');
    const a1 = r.body.find((a) => a.id === acc1);
    assert.equal(a1.status, 'grace');
    assert.ok(r.body.find((a) => a.id === panelAcc).business_name === 'Panel PG Renamed');

    // ── Plans in use are hidden, not deleted ──
    r = await call('DELETE', `/admin/plans/${monthly}`);
    assert.equal(r.body.mode, 'hidden');
    r = await call('DELETE', `/admin/plans/${yearly}`);
    assert.equal(r.body.mode, 'deleted');

    // ── Content ──
    r = await call('PUT', '/admin/content/branding', { app_name: 'StayDesk', tagline: 'PGs made easy', logo_data_url: PNG_1PX });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('PUT', '/admin/content/branding', { app_name: 'StayDesk', logo_data_url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' });
    assert.equal(r.status, 400, 'svg refused');
    r = await call('PUT', '/admin/content/branding', { app_name: 'StayDesk', logo_data_url: 'data:image/png;base64,' + Buffer.from('not a png at all').toString('base64') });
    assert.equal(r.status, 400, 'fake png refused');
    r = await call('PUT', '/admin/content/support', { phone: '+91 98111 00555', whatsapp: '919811100555', email: 'Help@StayDesk.in', hours: '9–7' });
    assert.equal(r.status, 200);
    assert.equal(r.body.support.email, 'help@staydesk.in');
    r = await call('PUT', '/admin/content/faq', { items: [{ q: 'How to add beds?', a: 'Settings → Beds' }] });
    assert.equal(r.status, 200);
    r = await call('PUT', '/admin/content/faq', { items: [{ q: '', a: 'x' }] });
    assert.equal(r.status, 400);
    r = await call('PUT', '/admin/content/nope', {});
    assert.equal(r.status, 404);
    s.setToken(null);
    r = await call('GET', '/public/config');
    assert.equal(r.body.branding.app_name, 'StayDesk');
    assert.equal(r.body.branding.has_custom_logo, true);
    assert.equal(r.body.faq.length, 1);
    assert.equal(r.body.support.whatsapp, '919811100555');
    let res = await fetch(`http://127.0.0.1:${s.port}/brand/logo`);
    assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await res.arrayBuffer()).length, Buffer.from(PNG_1PX.split(',')[1], 'base64').length, 'custom logo served');
    for (const icon of ['/icons/icon-192.png', '/icons/icon-512.png', '/favicon.ico']) {
      res = await fetch(`http://127.0.0.1:${s.port}${icon}`);
      assert.equal(res.status, 200, icon);
      assert.equal(Buffer.from(await res.arrayBuffer()).subarray(1, 4).toString(), 'PNG', icon);
    }
    s.setToken((await superLogin(s, 'superadmin@dormbook.in', 'NewSuper#Pass1')).token);
    r = await call('PUT', '/admin/content/branding', { app_name: 'DormBook', tagline: 'PG & Hostel Management', remove_logo: true });
    assert.equal(r.status, 200);
    res = await fetch(`http://127.0.0.1:${s.port}/brand/logo`);
    assert.equal(Buffer.from(await res.arrayBuffer()).length > 1000, true, 'built-in logo back');

    // ── Reports & CSV ──
    r = await call('GET', '/admin/reports');
    assert.equal(r.status, 200);
    assert.equal(r.body.range.revenue_paise, 49900);
    assert.equal(r.body.monthly.length, 12);
    assert.ok(r.body.status.grace >= 1);
    r = await call('GET', '/admin/reports?from=2026-13-01');
    assert.equal(r.status, 400);
    for (const type of ['payments', 'accounts', 'users']) {
      res = await fetch(`${s.base}/admin/reports/export?type=${type}`, { headers: { authorization: `Bearer ${s.token()}` } });
      assert.equal(res.status, 200, type);
      assert.match(res.headers.get('content-type'), /text\/csv/);
      const text = await res.text();
      assert.ok(text.split('\r\n').length >= 2, type);
    }
    r = await call('GET', '/admin/overview');
    assert.equal(r.status, 200);
    assert.equal(r.body.revenue.all_time.s, 49900);

    // ── System & audit ──
    r = await call('GET', '/admin/system?check=1');
    assert.equal(r.status, 200);
    assert.equal(r.body.database.integrity, 'ok');
    assert.deepEqual(r.body.backups.offsite_configured, []);
    r = await call('POST', '/admin/system/backup');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.offsite, 'not set up');
    r = await call('GET', '/admin/audit');
    const actions = r.body.map((x) => x.action);
    for (const a of ['ADMIN_CREATED', 'ADMIN_DELETED', 'USER_UPDATED', 'PLAN_CREATED', 'PAYMENT_RECORDED', 'PAYMENT_VOIDED', 'CONTENT_UPDATED', 'BACKUP_MADE', 'ACCOUNT_SUSPENDED']) {
      assert.ok(actions.includes(a), `audit has ${a}`);
    }
    assert.ok(!JSON.stringify(r.body).includes('Changed#Pass22'), 'no passwords in the audit');

    // ── OTP is off ──
    s.setToken(null);
    r = await call('POST', '/auth/forgot-password', { mobile: '9811100010' });
    assert.equal(r.status, 410);
    r = await call('POST', '/auth/reset-password', { mobile: '9811100010', otp: '123456', new_password: 'Whatever#123' });
    assert.equal(r.status, 410);
    r = await call('POST', '/auth/staff/request-code', { mobile: '9811100010' });
    assert.equal(r.status, 200); assert.equal(r.body.sms_enabled, false);

    // ── Health, version header ──
    res = await fetch(`${s.base}/health`);
    const h = await res.json();
    assert.equal(h.db, 'ok'); assert.ok(h.version);
    assert.equal(res.headers.get('x-app-version'), h.version);
    assert.equal(res.headers.get('x-powered-by'), null);
  } finally {
    await s.stop();
  }
});

/** Read server-sent events from a stream until `want` returns true (or timeout). */
async function readEvents(url, want, ms = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const seen = [];
  try {
    const res = await fetch(url, { signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = (chunk.match(/^event: (.*)$/m) || [])[1];
        const data = (chunk.match(/^data: (.*)$/m) || [])[1];
        if (ev) seen.push({ event: ev, data: data ? JSON.parse(data) : null });
        if (want(seen)) { ac.abort(); return seen; }
      }
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { clearTimeout(timer); }
  return seen;
}

test('live updates: other phones of the same PG hear about changes; other PGs do not', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-live-'));
  const s = await boot({ dbDir, port: port() });
  const { call } = s;
  try {
    const a = await owner(s, 5);
    const b = await owner(s, 6);
    s.setToken(a.token);
    let r = await call('POST', '/events/ticket');
    assert.equal(r.status, 200);
    const ticketA = r.body.ticket;
    s.setToken(b.token);
    const ticketB = (await call('POST', '/events/ticket')).body.ticket;
    s.setToken(null);
    assert.equal((await call('POST', '/events/ticket')).status, 401, 'ticket needs sign-in');
    assert.equal((await fetch(`${s.base}/events?ticket=${'0'.repeat(48)}`)).status, 401, 'unknown ticket');

    const gotA = readEvents(`${s.base}/events?ticket=${ticketA}`, (ev) => ev.some((e) => e.event === 'changed'));
    const gotB = readEvents(`${s.base}/events?ticket=${ticketB}`, () => false, 2500);
    await new Promise((x) => setTimeout(x, 300));
    s.setToken(a.token);
    r = await call('POST', '/floors', { floor_number: 0, label: 'Ground' });
    assert.equal(r.status, 201);
    const evA = await gotA;
    assert.equal(evA[0].event, 'hello'); assert.ok(evA[0].data.version);
    const ch = evA.find((e) => e.event === 'changed');
    assert.equal(ch.data.area, 'floors'); assert.equal(ch.data.by, a.user.id);
    const evB = await gotB;
    assert.ok(!evB.some((e) => e.event === 'changed'), 'another PG hears nothing');
    assert.equal((await fetch(`${s.base}/events?ticket=${ticketA}`)).status, 401, 'tickets work once');
  } finally {
    await s.stop();
  }
});

/** A tiny in-memory stand-in for Cloudflare R2 (S3 API: PUT, GET, DELETE, ListObjectsV2). */
function fakeR2({ basePath = '', keyId = 'testkey', bucketName = 'dbk', region = 'auto' } = {}) {
  const objects = new Map();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!u.pathname.startsWith(basePath + '/')) { res.writeHead(404); return res.end(); }
    const parts = u.pathname.slice(basePath.length).split('/').filter(Boolean);
    const bucket = parts.shift();
    const key = parts.map(decodeURIComponent).join('/');
    if (!req.headers.authorization || !req.headers.authorization.startsWith(`AWS4-HMAC-SHA256 Credential=${keyId}/`)
      || !req.headers.authorization.includes(`/${region}/s3/aws4_request`)) {
      res.writeHead(403); return res.end('no auth');
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (bucket !== bucketName) { res.writeHead(404); return res.end(); }
      if (req.method === 'PUT') { objects.set(key, Buffer.concat(chunks)); res.writeHead(200); return res.end(); }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
        const prefix = u.searchParams.get('prefix') || '';
        const items = [...objects.entries()].filter(([k]) => k.startsWith(prefix));
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${items.map(([k, v]) =>
          `<Contents><Key>${k}</Key><Size>${v.length}</Size><LastModified>2026-10-05T00:00:00Z</LastModified></Contents>`).join('')}</ListBucketResult>`);
      }
      if (req.method === 'GET') {
        if (!objects.has(key)) { res.writeHead(404); return res.end(); }
        res.writeHead(200); return res.end(objects.get(key));
      }
      res.writeHead(400); return res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, objects, url: `http://127.0.0.1:${server.address().port}${basePath}` })));
}

test('R2 + Supabase: backups and ID files go off-site to both; an empty server restores', async () => {
  const r2 = await fakeR2();
  const sb = await fakeR2({ basePath: '/storage/v1/s3', keyId: 'sbkey', bucketName: 'dormbook-backups', region: 'ap-south-1' });
  const R2 = { R2_ENDPOINT: r2.url, R2_ACCESS_KEY_ID: 'testkey', R2_SECRET_ACCESS_KEY: 'testsecret', R2_BUCKET: 'dbk', R2_PREFIX: 'prod',
    SUPABASE_S3_ENDPOINT: sb.url, SUPABASE_S3_ACCESS_KEY_ID: 'sbkey', SUPABASE_S3_SECRET_ACCESS_KEY: 'sbsecret', SUPABASE_S3_REGION: 'ap-south-1',
    AES_256_KEY: 'a'.repeat(64) };
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-r2a-'));
  let s = await boot({ dbDir: dir1, port: port(), env: R2 });
  const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
  let guest, doc, ownerToken;
  try {
    const o = await owner(s, 7);
    ownerToken = o.token;
    s.setToken(o.token);
    let r = await s.call('POST', '/floors', { floor_number: 0, label: 'G' });
    await s.call('POST', `/floors/${r.body.id}/bunkers`, { bunkers: 1, beds_per_bunker: 2, daily_rate_paise: 30000 });
    const bed = (await s.call('GET', '/beds?status=available')).body[0];
    r = await s.call('POST', '/residents', { full_name: 'R2 Guest', mobile: '9000000777', bed_id: bed.id, check_in_date: TODAY,
      expected_checkout: addDays(TODAY, 2), id_consent: true, rate_type: 'daily', rate_paise: 30000, id_type: 'pan', id_number: 'abcde1234f' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    guest = r.body.resident.id;
    r = await s.call('POST', `/residents/${guest}/documents`, { doc_type: 'id_front', data_url: JPEG });
    assert.equal(r.status, 201);
    doc = r.body.id;
    await new Promise((x) => setTimeout(x, 500));
    assert.ok([...r2.objects.keys()].some((k) => k.startsWith('prod/uploads/') && k.endsWith('.enc')), 'ID file copied to R2 (encrypted)');
    assert.ok([...sb.objects.keys()].some((k) => k.startsWith('dormbook/uploads/') && k.endsWith('.enc')), 'ID file copied to Supabase too');
    const enc = [...r2.objects.entries()].find(([k]) => k.startsWith('prod/uploads/'))[1];
    assert.ok(!enc.includes(Buffer.from('JFIF')), 'R2 copy is encrypted');

    await superLogin(s);
    r = await s.call('POST', '/admin/system/backup');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.offsite, 'copied to R2 + Supabase', JSON.stringify(r.body));
    assert.ok([...r2.objects.keys()].some((k) => /^prod\/backups\/dormbook-.*-manual\.db$/.test(k)));
    assert.ok([...sb.objects.keys()].some((k) => /^dormbook\/backups\/dormbook-.*-manual\.db$/.test(k)));
    r = await s.call('GET', '/admin/system');
    assert.deepEqual(r.body.backups.offsite_configured, ['R2', 'Supabase']);
    assert.ok(r.body.backups.offsite.every((o) => o.files.length >= 1));
    r = await s.call('POST', '/admin/system/sync-uploads');
    assert.equal(r.status, 200); assert.equal(r.body.failed, 0);
  } finally {
    await s.stop();
  }

  // R2 is lost completely: Supabase alone must bring everything back.
  r2.objects.clear();
  // Brand-new empty disk + RESTORE_FROM_R2=latest → everything is back, ID photo comes from Supabase.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-r2b-'));
  s = await boot({ dbDir: dir2, port: port(), env: { ...R2, RESTORE_FROM_R2: 'latest' } });
  try {
    assert.ok(s.logs.join('').includes('[RESTORE] ✅') && s.logs.join('').includes('from Supabase'), s.logs.join(''));
    s.setToken(null);
    let r = await s.call('POST', '/auth/login', { mobile: '9811100070', password: 'Passw0rd!23' });
    assert.equal(r.status, 200, 'owner of the restored database signs in');
    s.setToken(r.body.token);
    r = await s.call('GET', `/residents/${guest}`);
    assert.equal(r.status, 200);
    // The ID file is not on this new disk (and the row still names the OLD folder): it is found
    // under the new uploads folder layout, fetched from R2, decrypted and served.
    let res = await fetch(`${s.base}/residents/${guest}/documents/${doc}`, { headers: { authorization: `Bearer ${s.token()}` } });
    assert.equal(res.status, 200, 'ID photo restored from R2');
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 3).toString('hex'), 'ffd8ff', 'original JPEG back');
    res = await fetch(`${s.base}/residents/${guest}/documents/${doc}`, { headers: { authorization: `Bearer ${s.token()}` } });
    assert.equal(res.status, 200, 'second read comes from the local copy');
    assert.ok(ownerToken);
  } finally {
    await s.stop();
    r2.server.close();
    sb.server.close();
  }
});

test('live-like old database: upgraded in place, owners keep working, admin panel reads it', async () => {
  const Database = require('better-sqlite3');
  const bcrypt = require('bcryptjs');
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-oldsa-'));
  const db = new Database(path.join(dbDir, 'dormbook.db'));
  db.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'schema-before-19sep.sql'), 'utf8'));
  const hash = bcrypt.hashSync('Old#Owner123', 4);
  const ci = addDays(TODAY, -20);
  db.exec(`INSERT INTO accounts (id, business_name, owner_name, owner_mobile, plan, trial_ends_at) VALUES ('a1','Old Paid PG','Amit','9822200010','active','2020-01-01');
    INSERT INTO accounts (id, business_name, owner_name, owner_mobile, plan, trial_ends_at) VALUES ('a2','Old Trial PG','Ravi','9822200020','trial','2099-01-01');
    INSERT INTO properties (id, account_id, name, owner_id) VALUES ('p1','a1','Old Paid PG','u1'), ('p2','a2','Old Trial PG','u2');
    INSERT INTO users (id, account_id, property_id, name, mobile, password_hash, role) VALUES
      ('u1','a1','p1','Amit','9822200010','${hash}','owner'), ('u2','a2','p2','Ravi','9822200020','${hash}','owner');
    INSERT INTO residents (id, property_id, full_name, mobile, check_in_date, expected_checkout, status, monthly_rent_paise,
      rate_type, rate_paise, deposit_paise, checkin_by, rent_due_day)
      VALUES ('r1','p1','Old Guest','9000000999','${ci}','${addDays(TODAY, 200)}','active',500000,'monthly',500000,500000,'u1',1);
    INSERT INTO payment_ledger (id, property_id, resident_id, amount_paise, direction, type, payment_mode, paid_at, recorded_by, created_at)
      VALUES ('pl1','p1','r1',500000,'credit','deposit','cash','${ci}T05:00:00.000Z','u1','${ci}T05:00:00.000Z');`);
  db.close();
  const s = await boot({ dbDir, port: port() });
  try {
    // Existing owners sign in exactly as before (paid account with no end date is never blocked)
    for (const m of ['9822200010', '9822200020']) {
      s.setToken(null);
      const r = await s.call('POST', '/auth/login', { mobile: m, password: 'Old#Owner123' });
      assert.equal(r.status, 200, `${m}: ${JSON.stringify(r.body)}`);
      s.setToken(r.body.token);
      assert.equal((await s.call('GET', '/dashboard/today')).status, 200);
    }
    await superLogin(s);
    for (const p of ['/admin/overview', '/admin/accounts', '/admin/users', '/admin/payments', '/admin/plans', '/admin/reports', '/admin/system', '/admin/audit', '/admin/content', '/admin/admins', '/admin/accounts/a1']) {
      const r = await s.call('GET', p);
      assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.body).slice(0, 300)}`);
    }
    const accs = (await s.call('GET', '/admin/accounts')).body;
    assert.equal(accs.find((a) => a.id === 'a1').status, 'active');
    assert.equal(accs.find((a) => a.id === 'a2').status, 'trial');
    let r = await s.call('POST', '/admin/payments', { account_id: 'a2', mode: 'cash', amount: 999, duration_days: 90 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await s.call('GET', '/admin/accounts/a2');
    assert.equal(r.body.status, 'active'); assert.equal(r.body.paid_until, addDays(TODAY, 89));
    // the guest's deposit is still in the books
    s.setToken(null);
    r = await s.call('POST', '/auth/login', { mobile: '9822200010', password: 'Old#Owner123' });
    s.setToken(r.body.token);
    r = await s.call('GET', '/residents/r1/ledger');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(JSON.stringify(r.body).includes('500000'), 'deposit kept');
    assert.ok(!/\[ERROR|UNCAUGHT/.test(s.logs.join('')), s.logs.join(''));
  } finally {
    await s.stop();
  }
});

test('owner journey helpers: plan status in the session, setup checklist, clear "paused" answer', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-owner-'));
  const s = await boot({ dbDir, port: port() });
  try {
    const o = await owner(s, 8);
    assert.equal(o.user.account.status, 'trial');
    assert.ok(o.user.account.days_left >= 29 && o.user.account.days_left <= 30);
    s.setToken(o.token);
    let r = await s.call('GET', '/onboarding');
    assert.deepEqual(r.body, { beds: false, business_details: false, payment_details: false, first_guest: false, staff: false });
    r = await s.call('POST', '/floors', { floor_number: 0, label: 'G' });
    await s.call('POST', `/floors/${r.body.id}/bunkers`, { bunkers: 1, beds_per_bunker: 2, daily_rate_paise: 30000 });
    r = await s.call('GET', '/onboarding');
    assert.equal(r.body.beds, true);
    r = await s.call('GET', '/auth/me');
    assert.equal(r.body.user.account.business_name, 'Biz 8');
    // Super-admin ends the trial → sign-in and open sessions get the code the app uses for the "paused" help box
    await superLogin(s);
    await s.call('PATCH', `/admin/accounts/${o.user.account_id}`, { trial_ends_at: addDays(TODAY, -2) });
    s.setToken(null);
    r = await s.call('POST', '/auth/login', { mobile: '9811100080', password: 'Passw0rd!23' });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'ACCOUNT_BLOCKED'); assert.match(r.body.error, /Trial expired/);
    s.setToken(o.token);
    r = await s.call('GET', '/dashboard/today');
    assert.equal(r.status, 403); assert.equal(r.body.code, 'ACCOUNT_BLOCKED');
  } finally {
    await s.stop();
  }
});
