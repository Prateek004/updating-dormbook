'use strict';

const path    = require('path');
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const morgan  = require('morgan');

const { setDb } = require('./db/connection');
const { initDb: openDb } = require('./db/init');
const { autoSeedIfEmpty, ensureSuperadmin } = require('./db/seed');
const routes        = require('./routes');
const { startScheduler } = require('./services/scheduler');
const realtime      = require('./services/realtime');
const env           = require('./util/env');

// App version = fingerprint of the screens (HTML / JS / CSS). It changes only when those files
// change, so phones are told to reload only when there really is something new.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const APP_VERSION = (() => {
  try {
    const h = require('crypto').createHash('sha1');
    for (const f of ['index.html', 'js/app.js', 'js/admin.js', 'js/live.js', 'css/app.css', 'sw.js']) {
      try { h.update(require('fs').readFileSync(path.join(PUBLIC_DIR, f))); } catch (_) { /* optional file */ }
    }
    return h.digest('hex').slice(0, 12);
  } catch (_) { return String(Date.now()); }
})();
realtime.setVersion(APP_VERSION);

const app  = express();
const PORT = process.env.PORT || 8080;
const ENV  = process.env.NODE_ENV || 'development';

// Railway (and most PaaS) put the app behind a single reverse proxy. Trusting
// one hop lets express-rate-limit and req.ip see the real client IP instead of
// the proxy's — without it every user would share one IP and be rate-limited
// together.
app.set('trust proxy', 1);
// Query strings are parsed simply (no nested objects/arrays): nothing in the app needs more,
// and it closes the known "qs" denial-of-service holes.
app.set('query parser', 'simple');
app.disable('x-powered-by');

// Real visitor IP for rate limits. Render puts Cloudflare in front of the app and Cloudflare
// writes the visitor's IP in CF-Connecting-IP (a visitor cannot fake it through Cloudflare).
// Elsewhere the normal "trust one proxy" rule applies. Override with CLIENT_IP_HEADER.
const CLIENT_IP_HEADER = String(process.env.CLIENT_IP_HEADER || (env.onRender() ? 'cf-connecting-ip' : '')).toLowerCase().trim();
if (CLIENT_IP_HEADER) {
  app.use((req, res, next) => {
    const v = String(req.headers[CLIENT_IP_HEADER] || '').split(',')[0].trim();
    if (v && v.length <= 45 && /^[0-9a-fA-F:.]+$/.test(v)) {
      Object.defineProperty(req, 'ip', { value: v, configurable: true, enumerable: true });
    }
    next();
  });
}

// A crash-proof server must survive stray async errors instead of exiting.
// Log loudly and keep serving; a single bad request should never take the
// whole process down.
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err && err.stack ? err.stack : err);
});

// Moving servers (e.g. Railway → Render): set REDIRECT_TO_URL=https://new-address on the OLD
// server and every visitor (including installed apps that open the old address) is sent to the
// same page on the new one. The health check still answers, so the old service stays "up".
const REDIRECT_TO = String(process.env.REDIRECT_TO_URL || '').trim().replace(/\/+$/, '');
if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(REDIRECT_TO)) {
  app.use((req, res, next) => {
    if (req.path === '/api/v1/health') return next();
    return res.redirect(308, REDIRECT_TO + req.originalUrl);
  });
  console.log(`[SERVER] Redirecting every request to ${REDIRECT_TO}`);
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'"],
      imgSrc:        ["'self'", 'data:', 'blob:'],
      connectSrc:    ["'self'"],
    },
  },
}));

// The app and its API are on the same site, so other websites get no CORS access.
// (To allow a separate front-end later, set CORS_ORIGINS=https://a.com,https://b.com)
const corsOrigins = String(process.env.CORS_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
app.use(cors({ origin: corsOrigins.length ? corsOrigins : false }));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), payment=()');
  next();
});
app.use(express.json({ limit: '3mb' })); // ID photos arrive as base64 (max 1.5 MB file)
// Request log. Guest bill links (/b/<secret>) and query strings are cut out so no link
// or search text ends up in the logs.
morgan.token('safe-url', (req) => String(req.originalUrl || req.url || '')
  .replace(/^\/b\/[^/?#]+/, '/b/[link]').replace(/\?.*$/, (q) => (q.length > 1 ? '?[…]' : '')));
app.use(morgan(ENV === 'production'
  ? ':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":user-agent"'
  : ':method :safe-url :status :response-time ms'));

// Rate limits: strict on sign-in (per IP + per mobile for codes, back-off per account),
// moderate on public pages, looser for signed-in users. All numbers are env settings —
// see src/middleware/rateLimits.js.
const { applyRateLimits, billLink } = require('./middleware/rateLimits');
applyRateLimits(app);

// Guest bill links (no sign-in): limited so links can't be guessed by brute force.
const share = require('./controllers/shareController');
app.get('/b/:token', billLink, share.viewBill);

// Logo and app icons (the super-admin can change the logo: Admin → Content → Branding).
const pub = require('./controllers/publicController');
app.get('/brand/logo', pub.logo);
app.get('/icons/icon-192.png', pub.icon192);
app.get('/icons/icon-512.png', pub.icon512);
app.get('/favicon.ico', pub.favicon);
app.get('/favicon.png', pub.favicon);

app.use(express.static(PUBLIC_DIR, {
  // The service worker must never be cached by the browser, or phones keep old screens.
  setHeaders: (res, file) => { if (/[\\/]sw\.js$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); },
}));
// Every API answer says which app version the server runs (the app reloads when it changes),
// and every successful change tells the other open phones of that PG to refresh.
app.use('/api/v1', (req, res, next) => {
  res.setHeader('X-App-Version', APP_VERSION);
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    const apiPath = req.path;   // e.g. /payments (read now: Express changes req.url while routing)
    res.on('finish', () => {
      if (res.statusCode < 400) { try { realtime.afterWrite(req, apiPath); } catch (e) { console.error('[LIVE]', e.message); } }
    });
  }
  next();
});
app.use('/api/v1', routes);
// Unknown API paths answer JSON 404 (not the app's HTML page).
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, _next) => {
  // A malformed JSON body is a client error, not a server fault — answer 400,
  // not 500, and don't log it as an internal error.
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError) && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  // Oversized body → 413 rather than a generic 500.
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  // Business-rule errors from the money ledger (day closed, refund > deposit,
  // duplicate payment, ...) are the user's to fix — answer 4xx with the reason.
  if (err && err.isLedgerError) {
    if (res.headersSent) return;
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  if (err && err.code === 'SQLITE_BUSY') {
    if (res.headersSent) return;
    return res.status(503).json({ error: 'Server busy — please retry' });
  }
  // Other client mistakes the body reader reports (bad charset, aborted upload…): plain message, no details.
  const st = err && Number(err.status || err.statusCode);
  if (st >= 400 && st < 500) {
    if (res.headersSent) return;
    return res.status(st).json({ error: 'The request could not be read. Please try again.' });
  }
  // Anything else: full details go to the server log only; the user gets a short message and a
  // reference to quote to support (never a stack trace, file path or database error).
  const ref = require('crypto').randomBytes(4).toString('hex');
  console.error(`[ERROR ref=${ref}] ${req.method} ${String(req.originalUrl || '').replace(/\?.*$/, '')}`,
    err && err.message, err && err.stack);
  if (res.headersSent) return;   // response already streaming (e.g. PDF export)
  res.status(500).json({ error: `Something went wrong on our side. Please try again. (ref ${ref})`, ref });
});

// Refuse to start in production without the secrets the app cannot work without.
// A clear boot error in Railway logs beats a running app where every login fails.
function checkRequiredEnv() {
  const onPaas = env.onRailway() || env.onRender();
  if (ENV !== 'production' && !onPaas) return;
  if (ENV !== 'production') console.warn('[BOOT WARNING] NODE_ENV is not "production" on this server — set NODE_ENV=production.');
  const problems = [];
  const jwt = process.env.JWT_SECRET;
  if (!jwt || jwt.startsWith('CHANGE_ME') || jwt.length < 32) problems.push('JWT_SECRET missing or shorter than 32 characters');
  const aes = process.env.AES_256_KEY;
  if (!aes || !/^[0-9a-fA-F]{64}$/.test(aes)) problems.push('AES_256_KEY must be exactly 64 hex characters (openssl rand -hex 32)');
  // On Railway the container disk is wiped on every deploy/restart. Without a
  // volume mounted at DB_DIR, all accounts and data vanish and every open
  // browser gets "User not found or deactivated". Refuse to run like that.
  const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
  if (onRailway && process.env.ALLOW_EPHEMERAL_DB !== 'true') {
    const dbDir = path.resolve(process.env.DB_DIR || '/data');
    const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH) : '';
    if (!mount) {
      problems.push(`No volume attached. In Railway: service → Settings → Volumes → add a volume with mount path ${dbDir}`);
    } else if (dbDir !== mount && !dbDir.startsWith(mount + path.sep)) {
      problems.push(`DB_DIR (${dbDir}) is not inside the volume mount (${mount}). Set DB_DIR=${mount}`);
    }
  }
  // On Render the app folder is wiped on every deploy. The database must live on a Render Disk:
  // add a disk (mount path e.g. /var/data) and set DB_DIR to that path.
  if (env.onRender() && process.env.ALLOW_EPHEMERAL_DB !== 'true') {
    const dbDir = path.resolve(process.env.DB_DIR || '/data');
    if (!process.env.DB_DIR) {
      problems.push('DB_DIR is not set. In Render: service → Disks → add a disk (mount path /var/data), then Environment → DB_DIR=/var/data');
    } else if (dbDir.startsWith('/opt/render/') || dbDir.startsWith(path.resolve(__dirname, '..'))) {
      problems.push(`DB_DIR (${dbDir}) is inside the app folder, which Render deletes on every deploy. Use the disk mount path, e.g. /var/data`);
    } else {
      try {
        const fsx = require('fs');
        fsx.accessSync(dbDir, fsx.constants.W_OK);
      } catch (_) {
        problems.push(`No writable disk at DB_DIR (${dbDir}). In Render: service → Disks → add a disk with mount path ${dbDir}`);
      }
    }
  }
  if (problems.length) {
    console.error('[BOOT ERROR] Fix these settings, then redeploy:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  const mobile = (process.env.SUPERADMIN_MOBILE || '').replace(/\D/g, '');
  if (process.env.SUPERADMIN_MOBILE && mobile.length !== 10) {
    console.warn(`[BOOT WARNING] SUPERADMIN_MOBILE should be a 10-digit mobile number (got ${mobile.length} digits)`);
  }
}

let server = null;
let shuttingDown = false;

/** Render / Railway send SIGTERM before replacing the app: finish open requests, save, close cleanly. */
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SERVER] ${signal} received — closing`);
  const finish = () => {
    try {
      const { getDb } = require('./db/connection');
      const db = getDb();
      try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) { /* ignore */ }
      db.close();
      console.log('[SERVER] Database closed');
    } catch (_) { /* not open */ }
    process.exit(0);
  };
  try { realtime.closeAll(); } catch (_) { /* ignore */ }
  if (server) {
    server.close(finish);
    // Long requests (exports) get 10 seconds, then we close anyway.
    setTimeout(finish, 10000).unref();
    try { server.closeIdleConnections && server.closeIdleConnections(); } catch (_) { /* old Node */ }
  } else finish();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

(async () => {
  try {
    checkRequiredEnv();
    // New server / lost disk: bring the newest R2 backup back BEFORE opening the database (RESTORE_FROM_R2).
    await require('./db/backup').restoreIfMissing(require('./db/init').DB_PATH);
    const db = openDb();
    setDb(db);
    autoSeedIfEmpty(db);
    ensureSuperadmin(db);
    startScheduler();
    server = app.listen(PORT, () => {
      console.log(`[SERVER] DormBook v4.1 on port ${PORT} (${ENV}, ${env.platform()}, app ${APP_VERSION})`);
    });
    // Slow or stuck clients cannot hold connections forever (live-update streams are not affected:
    // these limits are for receiving a request, not for how long an answer stays open).
    server.requestTimeout = 120000;
    server.headersTimeout = 65000;
    server.keepAliveTimeout = 75000;   // longer than the platform's load balancer idle time
  } catch (err) {
    console.error('[BOOT ERROR]', err.message, err.stack);
    process.exit(1);
  }
})();
