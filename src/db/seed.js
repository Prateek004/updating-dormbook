'use strict';

require('dotenv').config();
const bcrypt         = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

function autoSeedIfEmpty(db) {
  const count = db.prepare('SELECT COUNT(*) as n FROM users').get();
  if (count.n > 0) return;

  const email    = process.env.SUPERADMIN_EMAIL    || process.env.SEED_OWNER_EMAIL    || 'superadmin@dormbook.in';
  // No built-in password on a real server: without SUPERADMIN_PASSWORD the account gets a random
  // password nobody knows (set the variable, then reset it). The simple default is for local testing only.
  const deployed = require('../util/env').isDeployed();
  let password = process.env.SUPERADMIN_PASSWORD || process.env.SEED_OWNER_PASSWORD || '';
  if (!password) {
    if (deployed) {
      password = require('crypto').randomBytes(24).toString('base64url');
      console.warn('[SEED] SUPERADMIN_PASSWORD is not set — superadmin got a random password nobody knows. Set SUPERADMIN_PASSWORD.');
    } else {
      password = 'ChangeMe@Pilot1!';   // local testing only
    }
  }
  const mobile   = (process.env.SUPERADMIN_MOBILE  || process.env.SEED_OWNER_MOBILE   || '9999900000').replace(/\D/g, '');
  const name     = 'Super Admin';

  if (!process.env.SUPERADMIN_EMAIL && !process.env.SEED_OWNER_EMAIL) {
    console.warn('[SEED] SUPERADMIN_EMAIL / SEED_OWNER_EMAIL not set — using default. Set env vars before production!');
  }

  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const now  = new Date().toISOString();

  db.prepare(`
    INSERT INTO users (id, account_id, property_id, name, email, mobile, password_hash, role, is_active, created_at, updated_at)
    VALUES (?, NULL, NULL, ?, ?, ?, ?, 'superadmin', 1, ?, ?)
  `).run(uuidv4(), name, email, mobile, hash, now, now);

  // Never print the password: production logs are readable by anyone with
  // dashboard access and are kept for days.
  console.log('[SEED] ✅ Superadmin created');
  console.log(`[SEED]    Email   : ${email}`);
  console.log(`[SEED]    Mobile  : ${mobile}`);
  console.log('[SEED]    Password: (from SUPERADMIN_PASSWORD env var — not logged)');
}

/**
 * Never be locked out of the super-admin panel:
 *
 *  1. If the database has users but NO active super-admin (e.g. the last one was
 *     removed by hand), and SUPERADMIN_EMAIL + SUPERADMIN_PASSWORD are set,
 *     that super-admin is created (or switched back on).
 *  2. Break-glass: SUPERADMIN_RESET=true → on this boot the SUPERADMIN_EMAIL
 *     login gets SUPERADMIN_PASSWORD, is switched on and unlocked.
 *     Remove SUPERADMIN_RESET again after signing in.
 *
 * Never changes anyone else, never prints a password.
 */
function ensureSuperadmin(db) {
  try {
    // Same default as the first-start seed above, so both always mean the same login.
    const email = String(process.env.SUPERADMIN_EMAIL || process.env.SEED_OWNER_EMAIL || 'superadmin@dormbook.in').toLowerCase().trim();
    const password = String(process.env.SUPERADMIN_PASSWORD || '');
    const reset = process.env.SUPERADMIN_RESET === 'true';
    const active = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'superadmin' AND is_active = 1").get().n;
    if (active > 0 && !reset) return;
    if (!email || password.length < 8) {
      if (active === 0) console.warn('[SEED] No active super-admin. Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD (8+ characters) and restart.');
      if (reset) console.warn('[SEED] SUPERADMIN_RESET needs SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD (8+ characters).');
      return;
    }
    const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    const now = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
    const existing = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
    if (existing && existing.role !== 'superadmin') {
      console.error(`[SEED] ${email} belongs to a ${existing.role} login — cannot make it the super-admin. Use another SUPERADMIN_EMAIL.`);
      return;
    }
    if (existing) {
      db.prepare(`UPDATE users SET password_hash = ?, is_active = 1, failed_logins = 0, locked_until = NULL,
        pwd_changed_at = ?, updated_at = ? WHERE id = ?`).run(hash, now, now, existing.id);
      console.log(`[SEED] ✅ Super-admin ${email} switched on${reset ? ' and password reset (remove SUPERADMIN_RESET now)' : ''}`);
      return;
    }
    let mobile = String(process.env.SUPERADMIN_MOBILE || '').replace(/\D/g, '').slice(-10);
    if (mobile.length !== 10 || db.prepare('SELECT 1 FROM users WHERE mobile = ?').get(mobile)) {
      mobile = `0${String(Date.now()).slice(-9)}`;   // placeholder; super-admins sign in with email
    }
    db.prepare(`INSERT INTO users (id, account_id, property_id, name, email, mobile, password_hash, role, is_active, created_at, updated_at)
      VALUES (?, NULL, NULL, 'Super Admin', ?, ?, ?, 'superadmin', 1, ?, ?)`).run(uuidv4(), email, mobile, hash, now, now);
    console.log(`[SEED] ✅ Super-admin ${email} created`);
  } catch (e) {
    console.error('[SEED] ensureSuperadmin failed (app keeps running):', e.message);
  }
}

module.exports = { autoSeedIfEmpty, ensureSuperadmin };

if (require.main === module) {
  const { initDb } = require('./init');
  const db = initDb();
  const count = db.prepare('SELECT COUNT(*) as n FROM users').get();
  if (count.n > 0 && process.env.FORCE !== 'true') {
    console.log('[SEED] Database already has users. Set FORCE=true to re-seed.');
    process.exit(0);
  }
  autoSeedIfEmpty(db);
  db.close();
}
