'use strict';
/**
 * Where is the app running? One place for the checks that used to be copied
 * into several files (Railway only). Render and Railway are both "deployed".
 */

function onRailway() {
  return !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
}

function onRender() {
  return process.env.RENDER === 'true' || !!process.env.RENDER_SERVICE_ID;
}

/** A real server (never the local test setup): secrets must be set, no test defaults allowed. */
function isDeployed() {
  return process.env.NODE_ENV === 'production' || onRailway() || onRender();
}

function platform() {
  if (onRender()) return 'render';
  if (onRailway()) return 'railway';
  return 'other';
}

/** Whole number from an environment variable, or the default when missing / out of range. */
function envInt(name, dflt, min = 0, max = 1e9) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n < min || n > max) return dflt;
  return Math.floor(n);
}

module.exports = { onRailway, onRender, isDeployed, platform, envInt };
