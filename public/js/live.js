'use strict';
/* ============================================================
   DormBook — live updates + automatic app updates
   Loaded after app.js. Works with src/services/realtime.js.

   1. Live data: when someone else at the same PG saves something, this phone
      refreshes the screen it is on (lists, reports, dashboard). Screens with a
      form, or an open popup, are never refreshed under your fingers: a small
      “New updates — tap to refresh” bar appears instead.
   2. New app version: after a deploy the server reports a new version. The app
      reloads itself when it is safe (no popup, not typing), otherwise it shows
      “New version ready — Refresh”. No APK download is ever needed for this.
   Any failure here only switches live updates off; the app keeps working.
   ============================================================ */

const LIVE = {
  es: null, retry: 0, timer: null, pending: false, lastLocalWrite: 0,
  version: null, newVersion: null, refreshTimer: null, stopped: true,
};

// Screens that only show data: safe to redraw automatically.
const LIVE_AUTO_PAGES = new Set(['dashboard', 'residents', 'bookings', 'daily', 'summary', 'reports', 'gst', 'feedback', 'audit',
  'acc_daybook', 'acc_ledger', 'acc_tb', 'acc_pl', 'acc_bs', 'salary', 'purchases', 'expenses']);

/** Called by api() for every answer: the version the server is running. */
function onServerVersion(v) {
  if (!v) return;
  if (!LIVE.version) { LIVE.version = v; return; }
  if (v !== LIVE.version && v !== LIVE.newVersion) { LIVE.newVersion = v; offerAppUpdate(); }
}
/** Called by api() after this phone saved something (its own screen already shows it). */
function onLocalWrite() { LIVE.lastLocalWrite = Date.now(); }

function userIsBusy() {
  const overlay = document.getElementById('modal-overlay');
  if (overlay && !overlay.classList.contains('hidden')) return true;
  const a = document.activeElement;
  return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'search');
}
function pageIsAutoRefreshable() {
  const p = STATE.currentPage;
  if (!p) return false;
  if (typeof ADMIN_AUTO_REFRESH !== 'undefined' && ADMIN_AUTO_REFRESH.has(p)) return true;
  return LIVE_AUTO_PAGES.has(p);
}

function bar(id, html, onClick) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('button');
    el.id = id; el.type = 'button'; el.className = 'live-bar';
    document.body.appendChild(el);
  }
  el.innerHTML = html;
  el.onclick = onClick;
  el.hidden = false;
  return el;
}
function hideBar(id) { const el = document.getElementById(id); if (el) el.hidden = true; }

function offerAppUpdate() {
  // Safe moment: reload now (the sign-in stays: it is kept for this browser tab).
  if (!userIsBusy() && !document.hidden) { setTimeout(() => { if (!userIsBusy()) location.reload(); }, 1500); return; }
  bar('update-bar', '✨ New version of DormBook is ready · <b>Refresh</b>', () => location.reload());
}

function liveRefreshNow() {
  LIVE.pending = false;
  hideBar('live-bar');
  try { refreshCurrentPage(); } catch (_) { /* ignore */ }
}
function onRemoteChange(data) {
  if (data && data.by && STATE.user && data.by === STATE.user.id && Date.now() - LIVE.lastLocalWrite < 4000) return;
  clearTimeout(LIVE.refreshTimer);
  LIVE.refreshTimer = setTimeout(() => {
    if (pageIsAutoRefreshable() && !userIsBusy() && !document.hidden) { liveRefreshNow(); return; }
    LIVE.pending = true;
    bar('live-bar', '🔄 New updates · <b>tap to refresh</b>', liveRefreshNow);
  }, 900);
}
/** app.js calls this when a popup closes: catch up on changes that arrived meanwhile. */
function onModalClosed() {
  if (LIVE.pending && pageIsAutoRefreshable()) setTimeout(() => { if (!userIsBusy()) liveRefreshNow(); }, 300);
  if (LIVE.newVersion && LIVE.newVersion !== LIVE.version) offerAppUpdate();
}

async function liveStart() {
  liveStop();
  LIVE.stopped = false;
  if (!STATE.token || typeof EventSource === 'undefined') return;
  try {
    const { ticket } = await api('POST', '/events/ticket');
    if (LIVE.stopped) return;
    const es = new EventSource(`/api/v1/events?ticket=${encodeURIComponent(ticket)}`);
    LIVE.es = es;
    es.addEventListener('hello', (e) => {
      LIVE.retry = 0;
      try { onServerVersion(JSON.parse(e.data).version); } catch (_) { /* ignore */ }
      if (LIVE.reconnected) onRemoteChange({});   // we may have missed something while offline
      LIVE.reconnected = false;
    });
    es.addEventListener('changed', (e) => { let d = {}; try { d = JSON.parse(e.data); } catch (_) { /* ignore */ } onRemoteChange(d); });
    es.addEventListener('signout', () => { liveStop(); toast('Your login was changed by the administrator — please sign in again', 'warning', 6000); setTimeout(() => logout(), 1500); });
    es.addEventListener('bye', () => liveReconnect(3000));
    // The browser's own auto-retry would reuse the spent ticket, so we reconnect ourselves.
    es.onerror = () => liveReconnect();
  } catch (_) {
    liveReconnect();
  }
}
function liveReconnect(delay) {
  if (LIVE.es) { try { LIVE.es.close(); } catch (_) { /* ignore */ } LIVE.es = null; }
  if (LIVE.stopped || !STATE.token) return;
  clearTimeout(LIVE.timer);
  LIVE.retry = Math.min(LIVE.retry + 1, 8);
  const wait = delay || Math.min(60000, 2000 * 2 ** (LIVE.retry - 1)) + Math.floor(Math.random() * 1000);
  LIVE.reconnected = true;
  LIVE.timer = setTimeout(() => { if (!document.hidden && navigator.onLine !== false) liveStart(); else LIVE.waiting = true; }, wait);
}
function liveStop() {
  LIVE.stopped = true;
  clearTimeout(LIVE.timer);
  if (LIVE.es) { try { LIVE.es.close(); } catch (_) { /* ignore */ } LIVE.es = null; }
}

// Phone wakes up / app comes back to the front / internet returns → reconnect and catch up.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !STATE.token || LIVE.stopped) return;
  if (!LIVE.es || LIVE.es.readyState === 2 || LIVE.waiting) { LIVE.waiting = false; LIVE.retry = 0; LIVE.reconnected = true; liveStart(); }
});
window.addEventListener('online', () => {
  if (STATE.token && !LIVE.stopped && (!LIVE.es || LIVE.es.readyState === 2)) { LIVE.retry = 0; LIVE.reconnected = true; liveStart(); }
});
