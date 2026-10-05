'use strict';
/**
 * Database backups — so real data is never lost.
 *
 *  - On every boot, BEFORE any migration runs, the existing database is copied
 *    to DB_DIR/backups/dormbook-<IST date-time>-boot.db (skipped for a brand-new, empty DB).
 *  - Every night at 03:15 IST the scheduler makes another copy (…-daily.db).
 *  - The super-admin can make one any time (Admin → System → Back up now: …-manual.db).
 *  - The newest KEEP copies of each kind are kept on the disk; older ones are deleted.
 *  - When Cloudflare R2 and/or Supabase Storage are set up (see src/services/offsite.js) every
 *    copy is ALSO uploaded there (off-site). Each keeps the newest R2_KEEP_<KIND> copies
 *    (daily 30, boot 10, manual 20).
 *
 * Uses SQLite "VACUUM INTO": a complete, consistent copy (WAL included) taken
 * while the app keeps running. A failed backup is logged and never stops the app.
 *
 * Restore from the disk: stop the service, copy a backup over DB_DIR/dormbook.db, start again.
 * Restore (new server / lost disk): set RESTORE_FROM_R2=latest and start the service with an
 * EMPTY disk — the newest off-site copy (R2 or Supabase) is downloaded before the app opens
 * the database. An existing database is never overwritten.
 */
const fs = require('fs');
const path = require('path');
const offsite = require('../services/offsite');
const { envInt } = require('../util/env');

const KEEP = 14;
const R2_KEEP = { daily: envInt('R2_KEEP_DAILY', 30, 1, 3650), boot: envInt('R2_KEEP_BOOT', 10, 1, 1000), manual: envInt('R2_KEEP_MANUAL', 20, 1, 1000) };
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;   // 1 GB — far above a PG business's database

const status = { last_local: null, last_offsite: null, last_offsite_error: null };

function stamp() {
  // 2026-09-25T03-10-00 in India time
  return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 19).replace(/:/g, '-');
}

function hasData(db) {
  try {
    const t = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
    return !!t && db.prepare('SELECT COUNT(*) n FROM users').get().n > 0;
  } catch (_) { return false; }
}

function backupDb(db, dbPath, kind = 'manual', { upload = true } = {}) {
  try {
    if (!dbPath || dbPath === ':memory:' || !hasData(db)) return null;
    const dir = path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `dormbook-${stamp()}-${kind}.db`);
    if (fs.existsSync(file)) return file;
    db.prepare('VACUUM INTO ?').run(file);
    // keep the newest KEEP of this kind
    const mine = fs.readdirSync(dir).filter((f) => f.startsWith('dormbook-') && f.endsWith(`-${kind}.db`)).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - KEEP))) {
      try { fs.unlinkSync(path.join(dir, old)); } catch (_) { /* ignore */ }
    }
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`[BACKUP] Saved ${path.basename(file)} (${kb} KB)`);
    status.last_local = { file: path.basename(file), kb, at: new Date().toISOString() };
    // Off-site copy (never waits, never throws).
    if (upload) pushToR2(file, kind).catch((e) => console.error('[BACKUP] Off-site copy failed:', e.message));
    return file;
  } catch (e) {
    console.error('[BACKUP] Failed (app keeps running):', e.message);
    return null;
  }
}

/** Upload one backup file to every off-site place and prune old copies of the same kind there. */
async function pushToR2(file, kind) {
  const list = offsite.stores();
  if (!list.length) return { ok: false, skipped: true };
  const size = fs.statSync(file).size;
  if (size > MAX_UPLOAD_BYTES) {
    status.last_offsite_error = `Backup is ${Math.round(size / 1048576)} MB — too large to upload`;
    console.error('[BACKUP] ' + status.last_offsite_error);
    return { ok: false, error: status.last_offsite_error };
  }
  const name = path.basename(file);
  const body = fs.readFileSync(file);
  const done = [];
  const errors = [];
  for (const st of list) {
    const r = await st.put(`backups/${name}`, body, 'application/vnd.sqlite3');
    if (!r.ok) { errors.push(r.error || `${st.name} upload failed`); continue; }
    done.push(st.name);
    try {
      const keep = R2_KEEP[kind] || 20;
      const mine = (await st.list('backups/')).map((o) => o.key)
        .filter((k) => k.startsWith('backups/dormbook-') && k.endsWith(`-${kind}.db`)).sort();
      for (const old of mine.slice(0, Math.max(0, mine.length - keep))) await st.del(old);
    } catch (e) { console.error(`[BACKUP] ${st.name} clean-up skipped:`, e.message); }
  }
  if (done.length) {
    status.last_offsite = { file: name, kb: Math.round(size / 1024), at: new Date().toISOString(), stores: done };
    console.log(`[BACKUP] Copied ${name} to ${done.join(' + ')}`);
  }
  status.last_offsite_error = errors.length ? errors.join('; ') : null;
  if (errors.length) console.error('[BACKUP] Off-site upload problem:', status.last_offsite_error);
  return { ok: done.length > 0, stores: done, error: status.last_offsite_error || undefined };
}

/** Newest copies on the disk and in each off-site place — for Admin → System. */
async function listBackups(dbPath) {
  const out = { local: [], offsite: [], offsite_configured: offsite.names(), status };
  try {
    const dir = path.join(path.dirname(dbPath), 'backups');
    out.local = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('dormbook-') && f.endsWith('.db')).sort().reverse()
      .slice(0, 30).map((f) => ({ file: f, kb: Math.round(fs.statSync(path.join(dir, f)).size / 1024) })) : [];
  } catch (_) { /* ignore */ }
  for (const st of offsite.stores()) {
    try {
      const files = (await st.list('backups/')).filter((o) => o.key.endsWith('.db'))
        .sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, 30)
        .map((o) => ({ file: o.key.replace(/^backups\//, ''), kb: Math.round(o.size / 1024), at: o.last_modified }));
      out.offsite.push({ store: st.name, files });
    } catch (e) { out.offsite.push({ store: st.name, files: [], error: e.message }); }
  }
  return out;
}

/**
 * New server / lost disk: when RESTORE_FROM_R2 is set and there is NO database file yet,
 * download a backup first (R2, else Supabase). RESTORE_FROM_R2=latest → newest copy anywhere;
 * RESTORE_FROM_R2=dormbook-2026-10-05T03-15-00-daily.db → that exact copy.
 * Never overwrites an existing database. Returns true when a copy was restored.
 */
async function restoreIfMissing(dbPath) {
  const want = String(process.env.RESTORE_FROM_R2 || '').trim();
  if (!want || !dbPath || dbPath === ':memory:') return false;
  try {
    if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
      console.log('[RESTORE] RESTORE_FROM_R2 is set but a database already exists — nothing restored. Remove RESTORE_FROM_R2.');
      return false;
    }
    const list = offsite.stores();
    if (!list.length) { console.error('[RESTORE] RESTORE_FROM_R2 is set but neither R2 nor Supabase is configured.'); return false; }
    // Which copy, and which place has it
    const found = [];
    for (const st of list) {
      try {
        for (const k of (await st.list('backups/')).map((o) => o.key)) {
          if (/^backups\/dormbook-.*\.db$/.test(k)) found.push({ st, name: k.replace(/^backups\//, '') });
        }
      } catch (e) { console.error(`[RESTORE] ${st.name} list failed:`, e.message); }
    }
    let pick;
    if (want === 'latest') {
      found.sort((a, b) => (a.name < b.name ? -1 : 1));
      pick = found[found.length - 1];
      if (!pick) { console.error('[RESTORE] No backups found off-site.'); return false; }
    } else {
      if (!/^dormbook-[\w.-]+\.db$/.test(want)) { console.error('[RESTORE] RESTORE_FROM_R2 must be "latest" or a backup file name.'); return false; }
      pick = found.find((f) => f.name === want);
      if (!pick) { console.error(`[RESTORE] ${want} was not found off-site.`); return false; }
    }
    const buf = await pick.st.get(`backups/${pick.name}`);
    if (!buf || buf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') {
      console.error(`[RESTORE] ${pick.name} could not be downloaded or is not a database.`);
      return false;
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    for (const extra of ['-wal', '-shm']) fs.rmSync(dbPath + extra, { force: true });
    const tmp = `${dbPath}.restoring`;
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, dbPath);
    console.log(`[RESTORE] ✅ Restored ${pick.name} from ${pick.st.name} (${Math.round(buf.length / 1024)} KB). Remove RESTORE_FROM_R2 now.`);
    return true;
  } catch (e) {
    console.error('[RESTORE] Failed:', e.message);
    return false;
  }
}

module.exports = { backupDb, pushToR2, listBackups, restoreIfMissing, status };
