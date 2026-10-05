'use strict';
/**
 * GET /api/v1/onboarding — the owner's "Get started" checklist on the Today screen.
 * Only yes/no facts about the owner's own PG; read-only; never fails the screen.
 */
const { getDb } = require('../db/connection');

function onboarding(req, res) {
  const db = getDb();
  const pid = req.user.property_id;
  const one = (sql, ...a) => { try { return db.prepare(sql).get(...a) || {}; } catch (_) { return {}; } };
  const n = (sql, ...a) => one(sql, ...a).n || 0;
  const p = one('SELECT * FROM properties WHERE id = ?', pid);
  let bedsWhere = 'property_id = ?';
  try {
    const cols = db.prepare("SELECT name FROM pragma_table_info('beds')").all().map((c) => c.name);
    if (cols.includes('removed_at')) bedsWhere += ' AND removed_at IS NULL';
  } catch (_) { /* old database */ }
  res.json({
    beds: n(`SELECT COUNT(*) n FROM beds WHERE ${bedsWhere}`, pid) > 0,
    business_details: !!(p.address || p.contact_phone),
    payment_details: !!(p.upi_id || p.bank_account_enc),
    first_guest: n('SELECT COUNT(*) n FROM residents WHERE property_id = ?', pid) > 0,
    staff: n("SELECT COUNT(*) n FROM users WHERE property_id = ? AND role IN ('manager','reception')", pid) > 0,
  });
}

module.exports = { onboarding };
