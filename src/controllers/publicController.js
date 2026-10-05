'use strict';
/**
 * Public (no sign-in) pieces of the app shell:
 *   GET /api/v1/public/config   app name, tagline, logo URL, support contact, FAQ, active plans, app version
 *   GET /brand/logo             the super-admin's uploaded logo, or the built-in DormBook logo
 *   GET /icons/icon-192.png, /icons/icon-512.png, /favicon.ico   built-in app icons
 * Nothing private is ever returned here.
 */
const settings = require('../services/appSettings');
const realtime = require('../services/realtime');
const brand = require('../assets/brand');
const { getDb } = require('../db/connection');

function config(req, res) {
  let plans = [];
  try {
    plans = getDb().prepare(`SELECT id, name, price_paise, duration_days, max_beds, description FROM saas_plans
      WHERE is_active = 1 ORDER BY sort_order, price_paise, name`).all();
  } catch (_) { plans = []; }
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({
    branding: settings.publicBranding(),
    support: settings.get('support'),
    faq: settings.get('faq'),
    plans,
    version: realtime.getVersion(),
    otp_enabled: process.env.OTP_ENABLED === 'true',
  });
}

function sendPng(res, buf, maxAge) {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(buf);
}

function logo(req, res) {
  try {
    const b = settings.get('branding');
    const m = b.logo_data_url && /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(b.logo_data_url);
    if (m) {
      const buf = Buffer.from(m[2], 'base64');
      if (settings.imageType(buf) === m[1]) {
        res.setHeader('Content-Type', m[1]);
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.send(buf);
      }
    }
  } catch (_) { /* fall back to the built-in logo */ }
  return sendPng(res, brand.png('logo'), 300);
}

const icon192 = (req, res) => sendPng(res, brand.png('icon192'), 86400);
const icon512 = (req, res) => sendPng(res, brand.png('icon512'), 86400);
const favicon = (req, res) => sendPng(res, brand.png('favicon'), 86400);

module.exports = { config, logo, icon192, icon512, favicon };
