'use strict';
/**
 * Live updates (Server-Sent Events).
 *
 * Every signed-in phone / browser keeps one light connection open to
 * GET /api/v1/events. When anyone at the same PG saves something (check-in,
 * payment, bed change…), the others get a "changed" message and refresh the
 * screen they are on. The super-admin gets "changed" messages for account-level
 * changes (sign-ups, admin edits).
 *
 * The connection also tells each app the current app version, so a phone that
 * still runs old screens after a deploy is told to reload.
 *
 * Safety:
 *  - The browser's EventSource cannot send the sign-in token, so it first asks
 *    POST /events/ticket (signed in) for a one-use ticket valid 60 seconds.
 *  - Messages carry no private data: only "something changed" + which area.
 *  - Caps: SSE_MAX_PER_USER connections per login (default 6), SSE_MAX_CLIENTS overall (2000).
 *  - A ping every 25 s keeps proxies from closing idle connections.
 *  - Single server process (SQLite) → an in-memory hub is enough.
 */
const crypto = require('crypto');
const { envInt } = require('../util/env');

const MAX_TOTAL = envInt('SSE_MAX_CLIENTS', 2000, 1, 100000);
const MAX_PER_USER = envInt('SSE_MAX_PER_USER', 6, 1, 100);
const TICKET_MS = 60 * 1000;
const PING_MS = 25 * 1000;

const clients = new Map();   // id → { res, userId, propertyId, role }
const tickets = new Map();   // ticket → { userId, exp }
let nextId = 1;
let appVersion = 'dev';
let pingTimer = null;

function setVersion(v) { appVersion = String(v || 'dev'); }
function getVersion() { return appVersion; }

function issueTicket(userId) {
  const now = Date.now();
  // Drop expired tickets so the map never grows.
  if (tickets.size > 5000) for (const [t, v] of tickets) if (v.exp < now) tickets.delete(t);
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, { userId, exp: now + TICKET_MS });
  return { ticket, expires_in: TICKET_MS / 1000 };
}

/** The user id for a ticket (one use), or null. */
function useTicket(ticket) {
  const t = typeof ticket === 'string' && /^[a-f0-9]{48}$/.test(ticket) ? tickets.get(ticket) : null;
  if (!t) return null;
  tickets.delete(ticket);
  return t.exp >= Date.now() ? t.userId : null;
}

function write(c, chunk) {
  try { c.res.write(chunk); return true; } catch (_) { drop(c.id); return false; }
}
function sendEvent(c, event, data) {
  return write(c, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function drop(id) {
  const c = clients.get(id);
  if (!c) return;
  clients.delete(id);
  try { c.res.end(); } catch (_) { /* already closed */ }
}

function startPing() {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    for (const c of clients.values()) write(c, ': ping\n\n');
  }, PING_MS);
  if (pingTimer.unref) pingTimer.unref();
}

/** Open a stream for this (already checked) user. Returns false when a limit is reached (caller answers 429). */
function connect(req, res, user) {
  if (clients.size >= MAX_TOTAL) return false;
  let mine = 0;
  for (const c of clients.values()) if (c.userId === user.id) mine++;
  if (mine >= MAX_PER_USER) {
    // Oldest connection of this user makes room (e.g. a closed tab that has not timed out yet).
    const oldest = [...clients.values()].find((c) => c.userId === user.id);
    if (oldest) drop(oldest.id);
  }
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();
  const c = { id: nextId++, res, userId: user.id, propertyId: user.property_id || null, role: user.role };
  clients.set(c.id, c);
  write(c, 'retry: 5000\n\n');
  sendEvent(c, 'hello', { version: appVersion, at: new Date().toISOString() });
  req.on('close', () => drop(c.id));
  res.on('error', () => drop(c.id));
  startPing();
  return true;
}

// Many saves in a row (a bulk bed change) become one message per area.
const pending = new Map();
const COALESCE_MS = 400;
function queue(key, deliver) {
  if (pending.has(key)) return;
  const t = setTimeout(() => { pending.delete(key); try { deliver(); } catch (e) { console.error('[LIVE]', e.message); } }, COALESCE_MS);
  if (t.unref) t.unref();
  pending.set(key, t);
}

/** Something at this property changed. `by` = user id who did it (their own screen already shows it). */
function propertyChanged(propertyId, area, by) {
  if (!propertyId) return;
  queue(`p:${propertyId}:${area}:${by || ''}`, () => {
    for (const c of clients.values()) {
      if (c.propertyId === propertyId) sendEvent(c, 'changed', { area, by: by || null });
    }
  });
}

/** Account-level change (sign-up, super-admin edit) → super-admin screens refresh. */
function adminChanged(area, by) {
  queue(`a:${area}:${by || ''}`, () => {
    for (const c of clients.values()) {
      if (c.role === 'superadmin') sendEvent(c, 'changed', { area, by: by || null, admin: true });
    }
  });
}

/** Tell every open app that a user's session ended (password reset, blocked) — their app signs out. */
function userSignedOut(userId) {
  for (const c of clients.values()) if (c.userId === userId) { sendEvent(c, 'signout', {}); drop(c.id); }
}

const SKIP = /^\/(events|auth\/login|auth\/staff\/request-code|auth\/forgot-password|auth\/reset-password)(\/|$)/;
const ADMIN_AREAS = /^\/(auth\/register|admin|staff)(\/|$)/;

/** Called after every successful write request (see server.js). */
function afterWrite(req, apiPath) {
  const p = String(apiPath || req.path || '');
  if (SKIP.test(p)) return;
  const area = (p.split('/')[1] || 'app').slice(0, 30);
  const u = req.user;
  if (u && u.property_id) propertyChanged(u.property_id, area, u.id);
  if (ADMIN_AREAS.test(p) || (u && u.role === 'superadmin')) adminChanged(area, u && u.id);
}

function stats() {
  const byRole = {};
  for (const c of clients.values()) byRole[c.role] = (byRole[c.role] || 0) + 1;
  return { connections: clients.size, by_role: byRole, max: MAX_TOTAL };
}

/** Shutdown: tell apps to reconnect shortly, then close every stream. */
function closeAll() {
  for (const c of clients.values()) { write(c, 'event: bye\ndata: {}\n\n'); drop(c.id); }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

module.exports = { issueTicket, useTicket, connect, propertyChanged, adminChanged, userSignedOut, afterWrite,
  stats, closeAll, setVersion, getVersion };
