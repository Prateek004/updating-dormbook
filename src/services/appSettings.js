'use strict';
/**
 * Super-admin content: app branding, support contact, FAQ.
 * Stored as JSON in the app_settings table (one row per key). Every read falls
 * back to safe defaults, so a missing or damaged row can never break a screen.
 */
const { getDb } = require('../db/connection');

const DEFAULTS = {
  branding: { app_name: 'DormBook', tagline: 'PG & Hostel Management', logo_data_url: null },
  support: { phone: '', whatsapp: '', email: '', hours: '', message: '' },
  faq: [],
};
const KEYS = Object.keys(DEFAULTS);

const clone = (v) => JSON.parse(JSON.stringify(v));

function readRaw(key) {
  try {
    const row = getDb().prepare('SELECT value, updated_at FROM app_settings WHERE key = ?').get(key);
    if (!row) return { value: clone(DEFAULTS[key]), updated_at: null };
    const v = JSON.parse(row.value);
    if (Array.isArray(DEFAULTS[key])) return { value: Array.isArray(v) ? v : clone(DEFAULTS[key]), updated_at: row.updated_at };
    return { value: { ...clone(DEFAULTS[key]), ...(v && typeof v === 'object' ? v : {}) }, updated_at: row.updated_at };
  } catch (_) {
    return { value: clone(DEFAULTS[key]), updated_at: null };
  }
}

function get(key) { return readRaw(key).value; }

function set(key, value, userId) {
  if (!KEYS.includes(key)) throw new Error(`unknown setting ${key}`);
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(value), userId || null, now);
  return now;
}

// ── Validation (every field: type, length, format) ───────────────────────────
const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
const LOGO_MAX = 400 * 1024;

function bad(message) { throw Object.assign(new Error(message), { status: 400, expose: true }); }

/** What the image really is, from its first bytes (png / jpeg / webp only — never SVG, it can carry scripts). */
function imageType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function cleanBranding(b, current) {
  const app_name = str(b.app_name).trim();
  if (!app_name || app_name.length > 40) bad('App name is required (max 40 characters)');
  const tagline = str(b.tagline).trim();
  if (tagline.length > 80) bad('Tagline is too long (max 80 characters)');
  let logo = current.logo_data_url || null;
  if (b.remove_logo === true) logo = null;
  if (b.logo_data_url) {
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(str(b.logo_data_url).replace(/\s/g, ''));
    if (!m) bad('Logo must be a PNG, JPG or WEBP image');
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > LOGO_MAX) bad('Logo must be smaller than 400 KB');
    if (imageType(buf) !== m[1]) bad('The logo file is not a real PNG / JPG / WEBP image');
    logo = `data:${m[1]};base64,${buf.toString('base64')}`;
  }
  return { app_name, tagline, logo_data_url: logo };
}

function cleanSupport(b) {
  const phone = str(b.phone).replace(/[^\d+]/g, '').slice(0, 15);
  const whatsapp = str(b.whatsapp).replace(/\D/g, '').slice(0, 15);
  const email = str(b.email).trim().toLowerCase();
  if (email && (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) bad('Support email is not valid');
  const hours = str(b.hours).trim();
  if (hours.length > 80) bad('Support hours text is too long (max 80)');
  const message = str(b.message).trim();
  if (message.length > 300) bad('Support message is too long (max 300)');
  if (phone && phone.replace(/\D/g, '').length < 8) bad('Support phone looks too short');
  if (whatsapp && whatsapp.length < 10) bad('WhatsApp number must have at least 10 digits (with country code, e.g. 9198…)');
  return { phone, whatsapp, email, hours, message };
}

function cleanFaq(list) {
  if (!Array.isArray(list)) bad('FAQ must be a list');
  if (list.length > 40) bad('At most 40 FAQ items');
  return list.map((x, i) => {
    const q = str(x && x.q).trim(), a = str(x && x.a).trim();
    if (!q || q.length > 200) bad(`FAQ ${i + 1}: question is required (max 200 characters)`);
    if (!a || a.length > 2000) bad(`FAQ ${i + 1}: answer is required (max 2000 characters)`);
    return { q, a };
  });
}

/** Small public view (no data URL inside — the logo is served at /brand/logo). */
function publicBranding() {
  const { value, updated_at } = readRaw('branding');
  return {
    app_name: value.app_name || 'DormBook', tagline: value.tagline || '',
    has_custom_logo: !!value.logo_data_url,
    logo_url: `/brand/logo?v=${encodeURIComponent((updated_at || 'default').replace(/\D/g, '').slice(0, 14) || 'default')}`,
  };
}

module.exports = { get, set, readRaw, KEYS, DEFAULTS, cleanBranding, cleanSupport, cleanFaq, publicBranding, imageType };
