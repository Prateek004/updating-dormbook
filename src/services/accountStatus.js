'use strict';
/**
 * One rule for "may this business use DormBook right now?" — used at sign-in,
 * on every request, and by the super-admin screens (so they always agree).
 *
 *   suspended                        → blocked
 *   trial, trial end date passed     → blocked
 *   active, paid_until passed        → still works for SUBSCRIPTION_GRACE_DAYS (default 7), then blocked
 *   active, no paid_until            → never blocked (accounts activated before subscriptions existed)
 *
 * paid_until is the last paid DAY (YYYY-MM-DD, inclusive).
 */
const { envInt } = require('../util/env');

const DAY = 86400000;
const graceDays = () => envInt('SUBSCRIPTION_GRACE_DAYS', 7, 0, 365);

/** End of the paid period, as a time (start of the day AFTER paid_until), or NaN. */
function paidEndMs(paidUntil) {
  if (!paidUntil) return NaN;
  const t = Date.parse(String(paidUntil).slice(0, 10));
  return Number.isFinite(t) ? t + DAY : NaN;
}

/**
 * status: trial | trial_expired | active | grace | expired | suspended
 * days_left: whole days left on the trial / paid period (negative = days over), or null.
 */
function accountState(account, now = Date.now()) {
  if (!account) return { status: 'unknown', days_left: null, blocked: null };
  if (account.suspended_at) return { status: 'suspended', days_left: null, blocked: 'Account suspended. Contact support.' };
  const nowIso = new Date(now).toISOString();
  if (account.plan === 'trial') {
    const ends = account.trial_ends_at ? Date.parse(account.trial_ends_at) : NaN;
    const days = Number.isFinite(ends) ? Math.ceil((ends - now) / DAY) : null;
    // Same comparison as before (text compare of ISO times), so nothing changes for existing trials.
    if (account.trial_ends_at && account.trial_ends_at < nowIso) {
      return { status: 'trial_expired', days_left: days, blocked: 'Trial expired. Contact support to continue.' };
    }
    return { status: 'trial', days_left: days, blocked: null };
  }
  if (account.plan === 'active') {
    const end = paidEndMs(account.paid_until);
    if (!Number.isFinite(end)) return { status: 'active', days_left: null, blocked: null };
    const days = Math.ceil((end - now) / DAY);
    if (now < end) return { status: 'active', days_left: days, blocked: null };
    if (now < end + graceDays() * DAY) return { status: 'grace', days_left: days, blocked: null };
    return { status: 'expired', days_left: days, blocked: 'Subscription ended. Contact support to renew.' };
  }
  if (account.plan === 'suspended') return { status: 'suspended', days_left: null, blocked: 'Account suspended. Contact support.' };
  return { status: String(account.plan || 'unknown'), days_left: null, blocked: null };
}

/** The message to show when this account may not be used right now, or null. */
function accountProblem(account, now) {
  return accountState(account, now).blocked;
}

module.exports = { accountState, accountProblem, graceDays, paidEndMs };
