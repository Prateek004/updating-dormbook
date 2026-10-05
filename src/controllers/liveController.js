'use strict';
/**
 * Live updates — see src/services/realtime.js.
 *   POST /api/v1/events/ticket   (signed in)  → { ticket }   one use, 60 seconds
 *   GET  /api/v1/events?ticket=… (the app's EventSource)    → text/event-stream
 */
const { getDb } = require('../db/connection');
const realtime = require('../services/realtime');
const { accountProblem } = require('../services/accountStatus');

function ticket(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.json(realtime.issueTicket(req.user.id));
}

function stream(req, res) {
  const userId = realtime.useTicket(req.query.ticket);
  if (!userId) return res.status(401).json({ error: 'Live updates: ticket expired' });
  let user;
  try {
    user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || !user.is_active) return res.status(401).json({ error: 'User not found or deactivated' });
    if (user.role !== 'superadmin' && user.account_id) {
      const problem = accountProblem(getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(user.account_id));
      if (problem) return res.status(403).json({ error: problem });
    }
  } catch (e) {
    return res.status(503).json({ error: 'Server busy — please try again' });
  }
  if (!realtime.connect(req, res, user)) return res.status(429).json({ error: 'Too many live connections — try again soon' });
  return undefined;
}

module.exports = { ticket, stream };
