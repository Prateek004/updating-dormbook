'use strict';
/* ============================================================
   DormBook — Super-admin panel
   Loaded after app.js (uses its helpers: api, h, esc, rupees, fmtDate, toast,
   openModal, closeModal, navigate, renderPage, refreshCurrentPage, STATE).
   Pages: admin (dashboard), admin_accounts, admin_users, admin_payments,
   admin_plans, admin_reports, admin_content, admin_admins, admin_system, admin_audit
   ============================================================ */

const ADMIN_NAV = [
  { section: 'Overview', items: [{ id: 'admin', label: '📊 Dashboard' }] },
  { section: 'Customers', items: [
    { id: 'admin_accounts', label: '🏢 Customers' },
    { id: 'admin_users', label: '👥 Users' },
  ] },
  { section: 'Money', items: [
    { id: 'admin_payments', label: '💳 Payments' },
    { id: 'admin_plans', label: '🏷 Plans & Pricing' },
    { id: 'admin_reports', label: '📈 Reports' },
  ] },
  { section: 'Settings', items: [
    { id: 'admin_content', label: '📝 Content & Branding' },
    { id: 'admin_admins', label: '👑 Super-admins' },
    { id: 'admin_system', label: '🛠 System & Backups' },
    { id: 'admin_audit', label: '🔍 Admin Log' },
  ] },
];
const ADMIN_TITLES = Object.fromEntries(ADMIN_NAV.flatMap((g) => g.items).map((p) => [p.id, p.label.replace(/^\S+\s+/, '')]));
const PAY_MODES = { cash: 'Cash', upi: 'UPI', bank_transfer: 'Bank transfer', card: 'Card', cheque: 'Cheque', other: 'Other' };
const ADMIN = { accounts: { q: '', status: '' }, users: { q: '', role: '', status: '', offset: 0 },
  payments: { q: '', status: '', from: '', to: '' }, reports: { from: '', to: '' }, contentTab: 'branding' };

function buildAdminNav() {
  const nav = document.getElementById('nav-list');
  nav.innerHTML = ADMIN_NAV.map((g) => `<li class="nav-section">${h(g.section)}</li>` +
    g.items.map((p) => `<li><a href="#" data-page="${p.id}">${h(p.label)}</a></li>`).join('')).join('');
  nav.querySelectorAll('[data-page]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.dataset.page); closeSidebar(); }));
}

async function renderAdminPage(el, page) {
  switch (page) {
    case 'admin': return adminDashboard(el);
    case 'admin_accounts': return adminAccounts(el);
    case 'admin_users': return adminUsers(el);
    case 'admin_payments': return adminPayments(el);
    case 'admin_plans': return adminPlans(el);
    case 'admin_reports': return adminReports(el);
    case 'admin_content': return adminContent(el);
    case 'admin_admins': return adminAdmins(el);
    case 'admin_system': return adminSystem(el);
    case 'admin_audit': return adminAudit(el);
    default: el.innerHTML = '<div class="empty-state"><p>Page not found</p></div>';
  }
}

// ── Small helpers ───────────────────────────────────────────────
const STATUS_TEXT = { trial: 'Trial', trial_expired: 'Trial ended', active: 'Active', grace: 'Payment due', expired: 'Expired', suspended: 'Suspended' };
const STATUS_CLS = { trial: 'badge-warning', trial_expired: 'badge-danger', active: 'badge-success', grace: 'badge-warning', expired: 'badge-danger', suspended: 'badge-danger' };
function statusBadge(st, days) {
  let extra = '';
  if (days !== null && days !== undefined && (st === 'trial' || st === 'active' || st === 'grace')) {
    extra = days >= 0 ? ` · ${days}d left` : ` · ${-days}d over`;
  }
  return `<span class="badge ${STATUS_CLS[st] || 'badge-gray'}">${h(STATUS_TEXT[st] || st)}${h(extra)}</span>`;
}
const val = (id) => { const e = document.getElementById(id); return e ? e.value : ''; };
function showErr(id, msg) { const e = document.getElementById(id); if (e) { e.textContent = msg; e.classList.remove('hidden'); } }
function hideErr(id) { const e = document.getElementById(id); if (e) e.classList.add('hidden'); }
function dateOnly(d) { return d ? String(d).slice(0, 10) : ''; }
function busy(btn, on, text) { if (!btn) return; if (on) { btn.dataset.t = btn.textContent; btn.disabled = true; if (text) btn.textContent = text; } else { btn.disabled = false; if (btn.dataset.t) btn.textContent = btn.dataset.t; } }
/** Run an admin action from a modal: shows errors in the modal, closes + refreshes on success. */
async function adminSubmit(btnId, errId, fn, okMsg) {
  hideErr(errId);
  const btn = document.getElementById(btnId);
  busy(btn, true, 'Saving…');
  try {
    const r = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'success');
    closeModal();
    refreshCurrentPage();
    return r;
  } catch (ex) { showErr(errId, ex.message); busy(btn, false); return null; }
}
function pwInput(id, placeholder) {
  return `<input id="${id}" type="text" placeholder="${h(placeholder || 'Min 8 characters')}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="200" />`;
}
function credentialsCard(r, who) {
  const l = r.login || {};
  return `<p>Send these sign-in details to <b>${h(l.name || who || 'the user')}</b>:</p>
    <div class="card" style="margin:12px 0">
      ${l.mobile ? `<div>Mobile: <b>${h(l.mobile)}</b></div>` : ''}
      ${l.email ? `<div>or Email: <b>${h(l.email)}</b></div>` : ''}
      <div class="mt-8">Password: <b style="font-family:monospace;font-size:17px">${h(r.password)}</b></div>
    </div>
    <p class="td-small">They are signed out everywhere and must sign in again with this password.</p>
    <div class="btn-group mt-12"><button class="btn btn-outline" onclick="copyText('${esc(r.password)}')">Copy password</button>
      <button class="btn btn-primary" onclick="closeModal()">Done</button></div>`;
}
async function adminDownload(type) {
  try {
    const q = new URLSearchParams({ type });
    if (ADMIN.reports.from) q.set('from', ADMIN.reports.from);
    if (ADMIN.reports.to) q.set('to', ADMIN.reports.to);
    const res = await fetch(`/api/v1/admin/reports/export?${q}`, { headers: { Authorization: `Bearer ${STATE.token}` } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Download failed (${res.status})`); }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dormbook-${type}-${todayIST()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Downloaded', 'success');
  } catch (ex) { toast(ex.message, 'error'); }
}

// ── Dashboard ───────────────────────────────────────────────────
async function adminDashboard(el) {
  const d = await api('GET', '/admin/overview');
  const c = d.counts;
  el.innerHTML = `
    <div class="kpis">
      <div class="kpi"><span>Customers</span><strong>${c.total}</strong><em>${d.platform.signups_this_month} new this month</em></div>
      <div class="kpi good"><span>Paying</span><strong>${(c.active || 0) + (c.grace || 0)}</strong><em>${c.grace || 0} payment due</em></div>
      <div class="kpi"><span>On trial</span><strong>${c.trial || 0}</strong><em>${c.trial_expired || 0} trial ended</em></div>
      <div class="kpi ${(c.expired || 0) + (c.suspended || 0) ? 'bad' : ''}"><span>Blocked</span><strong>${(c.expired || 0) + (c.suspended || 0)}</strong><em>${c.expired || 0} expired · ${c.suspended || 0} suspended</em></div>
      <div class="kpi good"><span>Revenue this month</span><strong>${rupees(d.revenue.this_month.s)}</strong><em>${d.revenue.this_month.n} payments · last month ${rupees(d.revenue.last_month.s)}</em></div>
      <div class="kpi"><span>Revenue all time</span><strong>${rupees(d.revenue.all_time.s)}</strong><em>${d.revenue.all_time.n} payments</em></div>
      <div class="kpi"><span>PGs / logins</span><strong>${d.platform.properties}</strong><em>${d.platform.users_active} active logins</em></div>
      <div class="kpi"><span>Guests staying</span><strong>${d.platform.residents_staying}</strong><em>across all PGs</em></div>
    </div>
    <div class="btn-group mb-20">
      <button class="btn btn-primary" onclick="adminPaymentModal()">💳 Record payment</button>
      <button class="btn btn-outline" onclick="adminAddCustomer()">➕ Add customer</button>
      <button class="btn btn-outline" onclick="navigate('admin_reports')">📈 Reports</button>
    </div>
    <div class="admin-grid">
      <div class="card"><strong>⏰ Renewals due (7 days)</strong>
        ${d.renewals_due.length ? `<div class="list-rows mt-12">${d.renewals_due.map((a) => `
          <div class="list-row"><div><div class="td-name">${h(a.business_name)}</div><div class="td-small">Paid until ${fmtDate(a.paid_until)}</div></div>
          <div class="row-end">${statusBadge(a.status, a.days_left)} <button class="btn btn-primary btn-sm" onclick="adminPaymentModal('${esc(a.id)}')">Renew</button></div></div>`).join('')}</div>`
          : '<p class="td-small mt-12">Nothing due ✓</p>'}
      </div>
      <div class="card"><strong>⌛ Trials ending (7 days)</strong>
        ${d.trials_ending.length ? `<div class="list-rows mt-12">${d.trials_ending.map((a) => `
          <div class="list-row"><div><div class="td-name">${h(a.business_name)}</div><div class="td-small">Ends ${fmtDate(a.trial_ends_at)}</div></div>
          <div class="row-end">${statusBadge('trial', a.days_left)} <button class="btn btn-outline btn-sm" onclick="adminExtendTrial('${esc(a.id)}','${esc(a.business_name)}')">Extend</button></div></div>`).join('')}</div>`
          : '<p class="td-small mt-12">No trials ending soon</p>'}
      </div>
      <div class="card"><strong>🆕 Recent sign-ups</strong>
        ${d.recent_signups.length ? `<div class="list-rows mt-12">${d.recent_signups.map((a) => `
          <div class="list-row" role="button" onclick="adminViewAccount('${esc(a.id)}')"><div><div class="td-name">${h(a.business_name)}</div><div class="td-small">${fmtDate(a.created_at)}</div></div>
          <div class="row-end">${statusBadge(a.status)}</div></div>`).join('')}</div>` : '<p class="td-small mt-12">No customers yet</p>'}
      </div>
      <div class="card"><strong>💳 Recent payments</strong>
        ${d.recent_payments.length ? `<div class="list-rows mt-12">${d.recent_payments.map((p) => `
          <div class="list-row" role="button" onclick="adminInvoice('${esc(p.id)}')"><div><div class="td-name">${h(p.business_name || '—')}</div><div class="td-small">${h(p.invoice_no)} · ${fmtDate(p.paid_on)} · ${h(PAY_MODES[p.mode] || p.mode)}</div></div>
          <div class="row-end"><b class="${p.status === 'void' ? 'struck' : ''}">${rupees(p.amount_paise)}</b></div></div>`).join('')}</div>` : '<p class="td-small mt-12">No payments yet</p>'}
      </div>
    </div>`;
}

// ── Customers ───────────────────────────────────────────────────
async function adminAccounts(el) {
  const [accounts, stats] = await Promise.all([api('GET', '/admin/accounts'), api('GET', '/admin/stats')]);
  STATE.adminAccounts = accounts;
  const f = ADMIN.accounts;
  const q = f.q.toLowerCase();
  const rows = accounts.filter((a) => (!f.status || a.status === f.status)
    && (!q || [a.business_name, a.owner_name, a.owner_mobile, a.owner_email].some((x) => String(x || '').toLowerCase().includes(q))));
  el.innerHTML = `
    <div class="filters">
      <input id="aa-q" type="search" placeholder="Search business, owner, mobile, email" value="${h(f.q)}" />
      <select id="aa-st"><option value="">All statuses</option>${Object.entries(STATUS_TEXT).map(([k, v]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${h(v)}</option>`).join('')}</select>
      <button class="btn btn-primary" onclick="adminAddCustomer()">➕ Add customer</button>
    </div>
    <p class="td-small mb-12">${rows.length} of ${accounts.length} customers · ${stats.residents} guests staying across all PGs</p>
    <div class="card table-wrap">
      ${rows.length ? `<table>
        <thead><tr><th>Business</th><th>Owner</th><th>Status</th><th>Plan</th><th>Paid until / trial</th><th>PGs</th><th>Guests</th><th>Logins</th><th>Actions</th></tr></thead>
        <tbody>${rows.map((a) => `<tr>
          <td><div class="td-name">${h(a.business_name)}</div><div class="td-small">Joined ${fmtDate(a.created_at)}</div></td>
          <td>${h(a.owner_name || '—')}<div class="td-small">${h(a.owner_mobile || '')}${a.owner_email ? ` · ${h(a.owner_email)}` : ''}</div></td>
          <td>${statusBadge(a.status, a.days_left)}</td>
          <td>${h(a.plan_name || (a.plan === 'active' ? 'Paid' : 'Trial'))}</td>
          <td>${a.plan === 'active' ? (a.paid_until ? fmtDate(a.paid_until) : 'No end date') : fmtDate(a.trial_ends_at)}</td>
          <td>${a.properties}</td><td>${a.residents}</td><td>${a.users}</td>
          <td class="actions-cell">
            <button class="btn btn-outline btn-sm" onclick="adminViewAccount('${esc(a.id)}')">👁 View</button>
            <button class="btn btn-primary btn-sm" onclick="adminPaymentModal('${esc(a.id)}')">💳 Payment</button>
            <button class="btn btn-outline btn-sm" onclick="adminEditAccount('${esc(a.id)}')">✏️ Edit</button>
            <button class="btn btn-outline btn-sm" onclick="adminAccountMore('${esc(a.id)}')">⋯ More</button>
          </td></tr>`).join('')}</tbody></table>` : '<div class="empty-state"><p>No customers match.</p></div>'}
    </div>`;
  let t;
  document.getElementById('aa-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value; adminAccounts(el).then(() => { const i = document.getElementById('aa-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 300); });
  document.getElementById('aa-st').addEventListener('change', (e) => { f.status = e.target.value; adminAccounts(el); });
}
const findAccount = (id) => (STATE.adminAccounts || []).find((a) => a.id === id) || null;

function adminAddCustomer() {
  openModal('Add customer', `
    <div class="field-row">
      <div class="field"><label for="nc-biz">Business name *</label><input id="nc-biz" maxlength="120" /></div>
      <div class="field"><label for="nc-pg">PG / hostel name</label><input id="nc-pg" maxlength="120" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label for="nc-name">Owner name *</label><input id="nc-name" maxlength="120" /></div>
      <div class="field"><label for="nc-mobile">Owner mobile *</label><input id="nc-mobile" type="tel" inputmode="numeric" maxlength="14" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label for="nc-email">Owner email</label><input id="nc-email" type="email" maxlength="120" /></div>
      <div class="field"><label for="nc-city">City</label><input id="nc-city" maxlength="60" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label for="nc-pass">Owner password *</label>${pwInput('nc-pass')}</div>
      <div class="field"><label for="nc-days">Trial days</label><input id="nc-days" type="number" min="1" max="3650" value="30" /></div>
    </div>
    <div id="nc-err" class="error-msg hidden"></div>
    <div class="btn-group mt-12"><button class="btn btn-primary" id="nc-btn" onclick="submitAddCustomer()">Create customer</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>`, { wide: true });
}
async function submitAddCustomer() {
  const body = { business_name: val('nc-biz').trim(), owner_name: val('nc-name').trim(), mobile: val('nc-mobile').trim(),
    email: val('nc-email').trim() || undefined, password: val('nc-pass').trim(), pg_name: val('nc-pg').trim() || undefined,
    city: val('nc-city').trim() || undefined, trial_days: Number(val('nc-days')) || 30 };
  if (!body.business_name || !body.owner_name || !body.mobile || body.password.length < 8) {
    return showErr('nc-err', 'Fill business name, owner name, mobile and a password of 8+ characters');
  }
  const r = await adminSubmit('nc-btn', 'nc-err', () => api('POST', '/admin/accounts', body));
  if (r) openModal('✅ Customer created', credentialsCard({ login: { name: body.owner_name, mobile: body.mobile, email: body.email }, password: body.password }));
}

function adminEditAccount(id) {
  const a = findAccount(id);
  if (!a) return;
  openModal(`Edit: ${a.business_name}`, `
    <div class="field"><label for="ea-name">Business name</label><input id="ea-name" maxlength="120" value="${h(a.business_name)}" /></div>
    <div class="field-row">
      <div class="field"><label for="ea-plan">Status</label>
        <select id="ea-plan"><option value="trial" ${a.plan === 'trial' ? 'selected' : ''}>Trial</option><option value="active" ${a.plan === 'active' ? 'selected' : ''}>Paid (active)</option></select></div>
      <div class="field"><label for="ea-trial">Trial ends</label><input id="ea-trial" type="date" value="${h(dateOnly(a.trial_ends_at))}" /></div>
    </div>
    <div class="field"><label for="ea-paid">Paid until (last paid day)</label><input id="ea-paid" type="date" value="${h(a.paid_until || '')}" />
      <div class="field-note">Normally set automatically when you record a payment. Leave empty for "no end date".</div></div>
    <div class="field"><label for="ea-notes">Private notes (only super-admins see these)</label><textarea id="ea-notes" rows="3" maxlength="2000">${h(a.admin_notes || '')}</textarea></div>
    <div id="ea-err" class="error-msg hidden"></div>
    <div class="btn-group mt-12"><button class="btn btn-primary" id="ea-btn" onclick="submitEditAccount('${esc(id)}')">Save</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>`);
}
function submitEditAccount(id) {
  return adminSubmit('ea-btn', 'ea-err', () => api('PATCH', `/admin/accounts/${encodeURIComponent(id)}`, {
    business_name: val('ea-name').trim(), plan: val('ea-plan'), trial_ends_at: val('ea-trial') || null,
    paid_until: val('ea-paid') || null, admin_notes: val('ea-notes'),
  }), 'Customer saved');
}

function adminAccountMore(id) {
  const a = findAccount(id);
  if (!a) return;
  openModal(a.business_name, `
    <div class="menu-list">
      <button class="menu-row" onclick="adminExtendTrial('${esc(a.id)}','${esc(a.business_name)}')"><span class="menu-ic">⌛</span><span class="menu-txt"><span class="menu-title">Extend trial</span><span class="menu-sub">Add days to the free trial</span></span></button>
      <button class="menu-row" onclick="adminResetPassword('${esc(a.id)}','${esc(a.owner_name || '')}')"><span class="menu-ic">🔑</span><span class="menu-txt"><span class="menu-title">Reset owner password</span><span class="menu-sub">Set a new password for ${h(a.owner_name || 'the owner')}</span></span></button>
      <button class="menu-row" onclick="adminUsersForAccount('${esc(a.id)}')"><span class="menu-ic">👥</span><span class="menu-txt"><span class="menu-title">Show logins</span><span class="menu-sub">Owner and staff of this business</span></span></button>
      ${a.suspended_at
        ? `<button class="menu-row" onclick="adminUnsuspend('${esc(a.id)}')"><span class="menu-ic">✅</span><span class="menu-txt"><span class="menu-title">Lift suspension</span><span class="menu-sub">Plan and dates stay as they are</span></span></button>`
        : `<button class="menu-row" onclick="adminSuspend('${esc(a.id)}')"><span class="menu-ic">⛔</span><span class="menu-txt"><span class="menu-title">Suspend</span><span class="menu-sub">Blocks every login of this business</span></span></button>`}
      <button class="menu-row" onclick="adminActivate('${esc(a.id)}')"><span class="menu-ic">🔄</span><span class="menu-txt"><span class="menu-title">Restart 30-day trial</span><span class="menu-sub">Also lifts a suspension</span></span></button>
      <button class="menu-row menu-logout" onclick="adminDeleteUser('${esc(a.id)}','${esc(a.owner_name || '')}','${esc(a.business_name || '')}')"><span class="menu-ic">🗑</span><span class="menu-txt"><span class="menu-title">Delete customer and ALL data</span><span class="menu-sub">Cannot be undone · payments to you stay in reports</span></span></button>
    </div>`);
}

function adminExtendTrial(id, name) {
  openModal(`Extend trial: ${name}`, `
    <div class="field"><label for="et-days">Add how many days?</label><input id="et-days" type="number" min="1" max="365" value="15" /></div>
    <div id="et-err" class="error-msg hidden"></div>
    <div class="btn-group mt-12"><button class="btn btn-primary" id="et-btn" onclick="submitExtendTrial('${esc(id)}')">Extend</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>`);
}
function submitExtendTrial(id) {
  return adminSubmit('et-btn', 'et-err', () => api('POST', `/admin/accounts/${encodeURIComponent(id)}/extend-trial`, { days: Number(val('et-days')) }),
    (r) => `Trial now ends ${fmtDate(r.trial_ends_at)}`);
}

/** Super-admin: one customer's overview — business facts and counts only (no guest or money details). */
async function adminViewAccount(id) {
  try {
    const a = await api('GET', `/admin/accounts/${encodeURIComponent(id)}`);
    const roleName = { owner: 'Owner', manager: 'Manager', reception: 'Reception' };
    const yes = (b) => (b ? '✅ Yes' : '— No');
    const props = (a.properties || []).map((p) => `
      <div class="card mt-12">
        <strong>${h(p.name || 'Property')}</strong> <span class="td-small">${h([p.city, p.state].filter(Boolean).join(', '))}</span>
        <dl class="facts mt-12">
          <div><dt>Beds</dt><dd>${p.beds.total} total · ${p.beds.occupied} occupied · ${p.beds.available} free</dd></div>
          <div><dt>Guests staying now</dt><dd>${p.guests.staying_now}</dd></div>
          <div><dt>Guests (all time)</dt><dd>${p.guests.all_time}</dd></div>
          <div><dt>Check-ins, last 30 days</dt><dd>${p.guests.checked_in_last_30_days}</dd></div>
          <div><dt>Payments recorded, last 30 days</dt><dd>${p.payments_recorded_last_30_days}</dd></div>
          <div><dt>Last activity</dt><dd>${p.last_activity_at ? fmtDate(p.last_activity_at) : '—'}</dd></div>
          <div><dt>Address added</dt><dd>${yes(p.setup.address_added)}</dd></div>
          <div><dt>GST</dt><dd>${p.setup.gst_on ? 'On' : 'Off'}${p.setup.gstin_added ? ' · GSTIN added' : ''}</dd></div>
          <div><dt>UPI / bank added</dt><dd>${yes(p.setup.payment_details_added)}</dd></div>
        </dl>
      </div>`).join('') || '<p class="td-small mt-12">No property yet.</p>';
    const roles = Object.entries(a.staff.by_role || {}).map(([r, c]) => `${c} ${roleName[r] || r}`).join(' · ') || '—';
    const pays = (a.subscription_payments || []);
    openModal(a.business_name || 'Account', `
      <dl class="facts">
        <div><dt>Status</dt><dd>${statusBadge(a.status, a.days_left)}</dd></div>
        <div><dt>Plan</dt><dd>${h(a.plan_name || (a.plan === 'active' ? 'Paid' : 'Trial'))}</dd></div>
        <div><dt>${a.plan === 'active' ? 'Paid until' : 'Trial ends'}</dt><dd>${a.plan === 'active' ? (a.paid_until ? fmtDate(a.paid_until) : 'No end date') : fmtDate(a.trial_ends_at)}</dd></div>
        <div><dt>Joined</dt><dd>${fmtDate(a.created_at)}</dd></div>
        <div><dt>Owner</dt><dd>${h(a.owner.name || '—')}</dd></div>
        <div><dt>Owner mobile</dt><dd>${h(a.owner.mobile || '—')}</dd></div>
        <div><dt>Owner email</dt><dd>${h(a.owner.email || '—')}</dd></div>
        <div><dt>Logins</dt><dd>${h(roles)}${a.staff.inactive ? ` · ${a.staff.inactive} switched off` : ''}</dd></div>
        ${a.suspension_reason ? `<div><dt>Suspended because</dt><dd>${h(a.suspension_reason)}</dd></div>` : ''}
        ${a.admin_notes ? `<div><dt>Your notes</dt><dd>${h(a.admin_notes)}</dd></div>` : ''}
      </dl>
      <div class="card mt-12"><strong>Payments to you</strong>
        ${pays.length ? `<div class="table-wrap mt-8"><table><thead><tr><th>Invoice</th><th>Paid on</th><th>Period</th><th>Amount</th></tr></thead><tbody>
          ${pays.map((p) => `<tr class="${p.status === 'void' ? 'struck' : ''}"><td><a href="#" onclick="event.preventDefault();adminInvoice('${esc(p.id)}')">${h(p.invoice_no)}</a></td>
            <td>${fmtDate(p.paid_on)}</td><td>${fmtDate(p.period_start)} – ${fmtDate(p.period_end)}</td><td>${rupees(p.amount_paise)}${p.status === 'void' ? ' (void)' : ''}</td></tr>`).join('')}
          </tbody></table></div>` : '<p class="td-small mt-8">No payments yet.</p>'}
        <button class="btn btn-primary btn-sm mt-8" onclick="adminPaymentModal('${esc(a.id)}')">💳 Record payment</button>
      </div>
      ${props}
      <p class="td-small mt-12">🔒 ${h(a.hidden)}</p>
      <div class="btn-group mt-12"><button class="btn btn-outline" onclick="closeModal()">Close</button></div>`, { wide: true });
  } catch (ex) { toast(ex.message, 'error'); }
}

async function adminActivate(id) {
  if (!confirm('Restart a 30-day trial from today for this customer? This also lifts a suspension.')) return;
  try { await api('PATCH', `/admin/accounts/${encodeURIComponent(id)}/activate`); closeModal(); toast('Trial restarted for 30 days', 'success'); refreshCurrentPage(); }
  catch (ex) { toast(ex.message, 'error'); }
}
async function adminUnsuspend(id) {
  try { await api('PATCH', `/admin/accounts/${encodeURIComponent(id)}/unsuspend`); closeModal(); toast('Suspension lifted', 'success'); refreshCurrentPage(); }
  catch (ex) { toast(ex.message, 'error'); }
}
function adminSuspend(id) {
  openModal('Suspend customer', `
    <div class="warn-banner">⛔ Every login of this business stops working until you lift the suspension.</div>
    <div class="field mt-12"><label for="su-reason">Reason (shown in your records)</label><input id="su-reason" maxlength="300" placeholder="e.g. Payment pending" /></div>
    <div id="su-err" class="error-msg hidden"></div>
    <div class="btn-group mt-12"><button class="btn btn-danger" id="su-btn" onclick="submitSuspend('${esc(id)}')">Suspend</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>`);
}
function submitSuspend(id) {
  return adminSubmit('su-btn', 'su-err', () => api('PATCH', `/admin/accounts/${encodeURIComponent(id)}/suspend`, { reason: val('su-reason').trim() }), 'Customer suspended');
}

function adminResetPassword(id, name) {
  openModal(`Reset password: ${name}`, `
    <div class="field"><label for="arp-pass">New password for the owner</label>${pwInput('arp-pass')}</div>
    <div class="field-note">Type it exactly as the owner should type it. Capital and small letters are different.</div>
    <div id="arp-error" class="error-msg hidden"></div>
    <div class="btn-group mt-12"><button class="btn btn-primary" id="arp-btn" onclick="submitAdminReset('${esc(id)}')">Set password</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>`);
}
async function submitAdminReset(id) {
  hideErr('arp-error');
  const pwd = val('arp-pass').trim();
  if (pwd.length < 8) return showErr('arp-error', 'Password must be at least 8 characters');
  const btn = document.getElementById('arp-btn'); busy(btn, true);
  try {
    const r = await api('POST', `/admin/accounts/${encodeURIComponent(id)}/reset-password`, { new_password: pwd });
    openModal('✅ Password changed', credentialsCard({ ...r, password: r.password || pwd }));
  } catch (ex) { showErr('arp-error', ex.message); busy(btn, false); }
}

function adminDeleteUser(id, name, business) {
  openModal(`Delete customer: ${business || name}`, `
    <div class="warn-banner">⚠️ This permanently deletes <b>${h(business)}</b> (owner ${h(name)}) and ALL their data: guests, payments, ID proofs, staff.
      This cannot be undone. What they paid you stays in your reports.</div>
    <div class="field mt-12"><label for="adel-confirm">Type <b>DELETE</b> to confirm</label><input id="adel-confirm" placeholder="DELETE" autocomplete="off" autocapitalize="characters" /></div>
    <div id="adel-error" class="error-msg hidden"></div>
    <div class="btn-group mt-12">
      <button class="btn btn-danger" id="adel-btn" onclick="submitAdminDelete('${esc(id)}')">Permanently delete</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>`);
}
function submitAdminDelete(id) {
  if (val('adel-confirm') !== 'DELETE') return showErr('adel-error', 'Type DELETE in capitals to confirm.');
  return adminSubmit('adel-btn', 'adel-error', () => api('DELETE', `/admin/accounts/${encodeURIComponent(id)}`), 'Customer and all data deleted');
}

// ── Users ───────────────────────────────────────────────────────
function adminUsersForAccount(accountId) {
  ADMIN.users = { q: '', role: '', status: '', offset: 0, account_id: accountId };
  closeModal();
  navigate('admin_users');
}
async function adminUsers(el) {
  const f = ADMIN.users;
  const q = new URLSearchParams({ limit: '50', offset: String(f.offset || 0) });
  if (f.q) q.set('q', f.q);
  if (f.role) q.set('role', f.role);
  if (f.status) q.set('status', f.status);
  if (f.account_id) q.set('account_id', f.account_id);
  const d = await api('GET', `/admin/users?${q}`);
  STATE.adminUsers = d.rows;
  const acc = f.account_id ? (findAccount(f.account_id) || { business_name: 'one customer' }) : null;
  el.innerHTML = `
    <div class="filters">
      <input id="au-q" type="search" placeholder="Search name, mobile, email, business" value="${h(f.q)}" />
      <select id="au-role"><option value="">All roles</option>${['owner', 'manager', 'reception'].map((r) => `<option ${f.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
      <select id="au-st"><option value="">Any status</option><option value="active" ${f.status === 'active' ? 'selected' : ''}>Active</option>
        <option value="blocked" ${f.status === 'blocked' ? 'selected' : ''}>Blocked</option><option value="locked" ${f.status === 'locked' ? 'selected' : ''}>Locked (wrong tries)</option></select>
    </div>
    ${acc ? `<div class="info-msg mb-12">Showing logins of <b>${h(acc.business_name)}</b> · <a href="#" onclick="event.preventDefault();ADMIN.users.account_id='';refreshCurrentPage()">show all</a></div>` : ''}
    <p class="td-small mb-12">${d.total} login${d.total === 1 ? '' : 's'}${d.total > d.limit ? ` · showing ${d.offset + 1}–${Math.min(d.offset + d.limit, d.total)}` : ''}</p>
    <div class="card table-wrap">
      ${d.rows.length ? `<table>
        <thead><tr><th>Name</th><th>Business</th><th>Role</th><th>Mobile / email</th><th>Status</th><th>Last sign-in</th><th>Actions</th></tr></thead>
        <tbody>${d.rows.map((u) => `<tr>
          <td><div class="td-name">${h(u.name)}</div><div class="td-small">${u.has_mpin ? 'MPIN set' : 'Password'}</div></td>
          <td>${h(u.business_name || '—')}<div class="td-small">${h(u.property_name || '')}</div></td>
          <td><span class="badge badge-purple">${h(u.role)}</span></td>
          <td>${h(u.mobile || '')}<div class="td-small">${h(u.email || '')}</div></td>
          <td>${u.is_active ? (u.locked ? '<span class="badge badge-warning">Locked</span>' : '<span class="badge badge-success">Active</span>') : '<span class="badge badge-danger">Blocked</span>'}</td>
          <td>${u.last_login_at ? fmtDateTime(u.last_login_at) : '—'}</td>
          <td class="actions-cell">
            <button class="btn btn-outline btn-sm" onclick="adminEditUser('${esc(u.id)}')">✏️ Edit</button>
            <button class="btn btn-outline btn-sm" onclick="adminUserPassword('${esc(u.id)}')">🔑 Password</button>
            ${u.locked ? `<button class="btn btn-success btn-sm" onclick="adminUnlockUser('${esc(u.id)}')">🔓 Unlock</button>` : ''}
            <button class="btn ${u.is_active ? 'btn-outline' : 'btn-success'} btn-sm" onclick="adminToggleUser('${esc(u.id)}', ${u.is_active ? 'false' : 'true'})">${u.is_active ? '⛔ Block' : '✅ Unblock'}</button>
            <button class="btn btn-danger btn-sm" onclick="adminRemoveUser('${esc(u.id)}')">🗑</button>
          </td></tr>`).join('')}</tbody></table>` : '<div class="empty-state"><p>No logins match.</p></div>'}
    </div>
    ${d.total > d.limit ? `<div class="pager mt-12">
      <button class="btn btn-outline btn-sm" ${d.offset ? '' : 'disabled'} onclick="ADMIN.users.offset=Math.max(0,ADMIN.users.offset-50);refreshCurrentPage()">‹ Previous</button>
      <button class="btn btn-outline btn-sm" ${d.offset + d.limit < d.total ? '' : 'disabled'} onclick="ADMIN.users.offset+=50;refreshCurrentPage()">Next ›</button></div>` : ''}`;
  let t;
  document.getElementById('au-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); f.offset = 0; adminUsers(el).then(() => { const i = document.getElementById('au-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 350); });
  document.getElementById('au-role').addEventListener('change', (e) => { f.role = e.target.value; f.offset = 0; adminUsers(el); });
  document.getElementById('au-st').addEventListener('change', (e) => { f.status = e.target.value; f.offset = 0; adminUsers(el); });
}
const findUser = (id) => (STATE.adminUsers || []).find((u) => u.id === id) || null;

function adminEditUser(id) {
  const u = findUser(id);
  if (!u) return;
  openModal(`Edit login: ${u.name}`, `
    <div class="field"><label for="eu-name">Name</label><input id="eu-name" maxlength="120" value="${h(u.name)}" /></div>
    <div class="field-row">
      <div class="field"><label for="eu-mobile">Mobile</label><input id="eu-mobile" type="tel" inputmode="numeric" maxlength="14" value="${h(String(u.mobile || '').slice(-10))}" /></div>
      <div class="field"><label for="eu-email">Email</label><input id="eu-email" type="email" maxlength="120" value="${h(u.email || '')}" /></div>
    </div>
    <div class="field"><label for="eu-role">Role</label>
      <select id="eu-role">${['owner', 'manager', 'reception'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
      <div class="field-note">Changing the role signs this person out; they sign in again with the new role.</div></div>
    <div id="eu-err" class="error-msg hidden"></div>
    <div class="btn-group mt-12"><button class="btn btn-primary" id="eu-btn" onclick="submitEditUser('${esc(id)}')">Save</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>`);
}
function submitEditUser(id) {
  const u = findUser(id) || {};
  const body = { name: val('eu-name').trim(), mobile: val('eu-mobile').trim(), email: val('eu-email').trim() };
  if (val('eu-role') !== u.role) body.role = val('eu-role');
  return adminSubmit('eu-btn', 'eu-err', () => api('PATCH', `/admin/users/${encodeURIComponent(id)}`, body), 'Login saved');
}
function adminUserPassword(id) {
  const u = findUser(id);
  if (!u) return;
  openModal(`New password: ${u.name}`, `
    <div class="field"><label for="up-pass">New password</label>${pwInput('up-pass')}</div>
    <div class="field-note">${u.has_mpin ? 'They can also keep using their MPIN.' : ''} Any "too many wrong tries" lock is removed.</div>
    <div id="up-err" class="error-msg hidden"></div>
    <div class="btn-group mt-12"><button class="btn btn-primary" id="up-btn" onclick="submitUserPassword('${esc(id)}')">Set password</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>`);
}
async function submitUserPassword(id) {
  hideErr('up-err');
  const pwd = val('up-pass').trim();
  if (pwd.length < 8) return showErr('up-err', 'Password must be at least 8 characters');
  const btn = document.getElementById('up-btn'); busy(btn, true);
  try {
    const r = await api('POST', `/admin/users/${encodeURIComponent(id)}/reset-password`, { new_password: pwd });
    openModal('✅ Password changed', credentialsCard(r));
    refreshCurrentPage();
  } catch (ex) { showErr('up-err', ex.message); busy(btn, false); }
}
async function adminUnlockUser(id) {
  try { await api('POST', `/admin/users/${encodeURIComponent(id)}/unlock`); toast('Unlocked', 'success'); refreshCurrentPage(); }
  catch (ex) { toast(ex.message, 'error'); }
}
async function adminToggleUser(id, on) {
  const u = findUser(id);
  if (!on && !confirm(`Block ${u ? u.name : 'this login'}? They are signed out at once.`)) return;
  try { await api('PATCH', `/admin/users/${encodeURIComponent(id)}`, { is_active: on }); toast(on ? 'Unblocked' : 'Blocked', on ? 'success' : 'warning'); refreshCurrentPage(); }
  catch (ex) { toast(ex.message, 'error'); }
}
function adminRemoveUser(id) {
  const u = findUser(id);
  if (!u) return;
  openModal(`Delete login: ${u.name}`, `
    <p>Delete <b>${h(u.name)}</b> (${h(u.role)}, ${h(u.business_name || '')})?</p>
    <p class="td-small">If this person has entries in the books (payments, check-ins…), the login is blocked instead, so the history stays correct.</p>
    <div id="ru-err" class="error-msg hidden"></div>
    <div class="btn-group mt-12"><button class="btn btn-danger" id="ru-btn" onclick="submitRemoveUser('${esc(id)}')">Delete</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>`);
}
function submitRemoveUser(id) {
  return adminSubmit('ru-btn', 'ru-err', () => api('DELETE', `/admin/users/${encodeURIComponent(id)}`), (r) => r.message || 'Done');
}

// ── Payments ────────────────────────────────────────────────────
async function adminPayments(el) {
  const f = ADMIN.payments;
  const q = new URLSearchParams({ limit: '200' });
  for (const k of ['q', 'status', 'from', 'to']) if (f[k]) q.set(k, f[k]);
  const d = await api('GET', `/admin/payments?${q}`);
  STATE.adminPayments = d.rows;
  el.innerHTML = `
    <div class="filters">
      <input id="ap-q" type="search" placeholder="Business, invoice no. or reference" value="${h(f.q)}" />
      <input id="ap-from" type="date" value="${h(f.from)}" aria-label="From" />
      <input id="ap-to" type="date" value="${h(f.to)}" aria-label="To" />
      <select id="ap-st"><option value="">Paid + void</option><option value="paid" ${f.status === 'paid' ? 'selected' : ''}>Paid only</option><option value="void" ${f.status === 'void' ? 'selected' : ''}>Void only</option></select>
      <button class="btn btn-primary" onclick="adminPaymentModal()">💳 Record payment</button>
    </div>
    <div class="kpis"><div class="kpi good"><span>Received (shown)</span><strong>${rupees(d.totals.paid_paise)}</strong><em>${d.totals.paid_count} payments</em></div></div>
    <div class="card table-wrap">
      ${d.rows.length ? `<table>
        <thead><tr><th>Invoice</th><th>Paid on</th><th>Business</th><th>Plan / period</th><th>Mode</th><th class="text-right">Amount</th><th>Actions</th></tr></thead>
        <tbody>${d.rows.map((p) => `<tr class="${p.status === 'void' ? 'struck' : ''}">
          <td><div class="td-name">${h(p.invoice_no)}</div>${p.status === 'void' ? `<div class="td-small">VOID: ${h(p.void_reason || '')}</div>` : ''}</td>
          <td>${fmtDate(p.paid_on)}</td>
          <td>${h(p.business_name || '—')}${p.account_deleted ? '<div class="td-small">customer deleted</div>' : ''}</td>
          <td>${h(p.plan_name || '—')}<div class="td-small">${fmtDate(p.period_start)} – ${fmtDate(p.period_end)}</div></td>
          <td>${h(PAY_MODES[p.mode] || p.mode)}${p.reference ? `<div class="td-small">${h(p.reference)}</div>` : ''}</td>
          <td class="text-right"><b>${rupees(p.amount_paise)}</b></td>
          <td class="actions-cell">
            <button class="btn btn-outline btn-sm" onclick="adminInvoice('${esc(p.id)}')">🧾 Invoice</button>
            ${p.status === 'paid' ? `<button class="btn btn-outline btn-sm" onclick="adminEditPayment('${esc(p.id)}')">✏️ Edit</button>
            <button class="btn btn-danger btn-sm" onclick="adminVoidPayment('${esc(p.id)}')">Void</button>` : ''}
          </td></tr>`).join('')}</tbody></table>` : '<div class="empty-state"><p>No payments yet. Record what a PG owner paid you with “Record payment”.</p></div>'}
    </div>`;
  let t;
  document.getElementById('ap-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); adminPayments(el).then(() => { const i = document.getElementById('ap-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 350); });
  for (const [id, k] of [['ap-from', 'from'], ['ap-to', 'to'], ['ap-st', 'status']]) {
    document.getElementById(id).addEventListener('change', (e) => { f[k] = e.target.value; adminPayments(el); });
  }
}

async function adminPaymentModal(accountId) {
  try {
    const [accounts, plans] = await Promise.all([STATE.adminAccounts && STATE.adminAccounts.length ? STATE.adminAccounts : api('GET', '/admin/accounts'), api('GET', '/admin/plans')]);
    STATE.adminAccounts = accounts;
    const active = plans.filter((p) => p.is_active);
    STATE.adminPlans = plans;
    openModal('Record payment', `
      <div class="field"><label for="pm-acc">Customer *</label>
        <select id="pm-acc"><option value="">Choose…</option>${accounts.slice().sort((x, y) => String(x.business_name).localeCompare(String(y.business_name)))
          .map((a) => `<option value="${h(a.id)}" ${a.id === accountId ? 'selected' : ''}>${h(a.business_name)} — ${h(a.owner_name || '')}</option>`).join('')}</select>
        <div class="field-note" id="pm-acc-note"></div></div>
      <div class="field"><label for="pm-plan">Plan</label>
        <select id="pm-plan"><option value="">Custom (type days)</option>${active.map((p) => `<option value="${h(p.id)}">${h(p.name)} — ${rupees(p.price_paise)} / ${p.duration_days} days</option>`).join('')}</select>
        ${active.length ? '' : '<div class="field-note">No plans yet — add them in Plans & Pricing, or type the days below.</div>'}</div>
      <div class="field-row">
        <div class="field"><label for="pm-amt">Amount received (₹) *</label><input id="pm-amt" type="number" min="0" step="0.01" inputmode="decimal" /></div>
        <div class="field"><label for="pm-days">Days covered *</label><input id="pm-days" type="number" min="1" max="3660" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="pm-mode">Mode *</label><select id="pm-mode">${Object.entries(PAY_MODES).map(([k, v]) => `<option value="${k}" ${k === 'upi' ? 'selected' : ''}>${h(v)}</option>`).join('')}</select></div>
        <div class="field"><label for="pm-date">Paid on</label><input id="pm-date" type="date" value="${todayIST()}" max="${todayIST()}" /></div>
      </div>
      <div class="field"><label for="pm-ref">Reference (UPI / cheque / transaction no.)</label><input id="pm-ref" maxlength="120" /></div>
      <div class="field"><label for="pm-notes">Notes</label><input id="pm-notes" maxlength="1000" /></div>
      <div class="info-msg" id="pm-period"></div>
      <div id="pm-err" class="error-msg hidden"></div>
      <div class="btn-group mt-12"><button class="btn btn-primary" id="pm-btn" onclick="adminSubmitPayment()">Save payment</button>
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>`);
    const upd = () => {
      const a = accounts.find((x) => x.id === val('pm-acc'));
      const days = Number(val('pm-days'));
      const note = document.getElementById('pm-acc-note');
      const per = document.getElementById('pm-period');
      if (note) note.innerHTML = a ? `${statusBadge(a.status, a.days_left)} ${a.plan === 'active' && a.paid_until ? `paid until ${fmtDate(a.paid_until)}` : ''}${a.suspended_at ? ' · <b>suspended</b> (lift it separately)' : ''}` : '';
      if (!a || !days) { per.textContent = 'The paid period starts today, or the day after the current paid period ends.'; return; }
      const today = todayIST();
      const start = a.plan === 'active' && a.paid_until && a.paid_until >= today ? addDaysIso(a.paid_until, 1) : today;
      per.textContent = `Covers ${fmtDate(start)} → ${fmtDate(addDaysIso(start, days - 1))}`;
    };
    document.getElementById('pm-plan').addEventListener('change', () => {
      const p = plans.find((x) => x.id === val('pm-plan'));
      if (p) { document.getElementById('pm-amt').value = (p.price_paise / 100).toFixed(2).replace(/\.00$/, ''); document.getElementById('pm-days').value = p.duration_days; }
      upd();
    });
    document.getElementById('pm-acc').addEventListener('change', upd);
    document.getElementById('pm-days').addEventListener('input', upd);
    upd();
  } catch (ex) { toast(ex.message, 'error'); }
}
function addDaysIso(d, n) { return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10); }
async function adminSubmitPayment() {
  const body = { account_id: val('pm-acc'), plan_id: val('pm-plan') || undefined, amount: val('pm-amt'), duration_days: Number(val('pm-days')),
    mode: val('pm-mode'), paid_on: val('pm-date') || undefined, reference: val('pm-ref').trim() || undefined, notes: val('pm-notes').trim() || undefined };
  if (!body.account_id) return showErr('pm-err', 'Choose the customer');
  if (body.amount === '') return showErr('pm-err', 'Type the amount received');
  if (!body.duration_days) return showErr('pm-err', 'Type how many days this payment covers');
  const r = await adminSubmit('pm-btn', 'pm-err', () => api('POST', '/admin/payments', body),
    (x) => `Saved ${x.invoice_no} · paid until ${fmtDate(x.period_end)}`);
  if (r && r.still_suspended) toast('This customer is still suspended — lift the suspension in Customers → More.', 'warning', 7000);
}

function adminEditPayment(id) {
  const p = (STATE.adminPayments || []).find((x) => x.id === id);
  if (!p) return;
  openModal(`Edit ${p.invoice_no}`, `
    <div class="field-row">
      <div class="field"><label for="ep-amt">Amount (₹)</label><input id="ep-amt" type="number" min="0" step="0.01" value="${(p.amount_paise / 100).toFixed(2)}" /></div>
      <div class="field"><label for="ep-date">Paid on</label><input id="ep-date" type="date" value="${h(p.paid_on)}" max="${todayIST()}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label for="ep-mode">Mode</label><select id="ep-mode">${Object.entries(PAY_MODES).map(([k, v]) => `<option value="${k}" ${k === p.mode ? 'selected' : ''}>${h(v)}</option>`).join('')}</select></div>
      <div class="field"><label for="ep-end">Period ends</label><input id="ep-end" type="date" min="${h(p.period_start)}" value="${h(p.period_end)}" /></div>
    </div>
    <div class="field"><label for="ep-ref">Reference</label><input id="ep-ref" maxlength="120" value="${h(p.reference || '')}" /></div>
    <div class="field"><label for="ep-notes">Notes</label><input id="ep-notes" maxlength="1000" value="${h(p.notes || '')}" /></div>
    <div id="ep-err" class="error-msg hidden"></div>
    <div class="btn-group mt-12"><button class="btn btn-primary" id="ep-btn" onclick="submitEditPayment('${esc(id)}')">Save</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>`);
}
function submitEditPayment(id) {
  return adminSubmit('ep-btn', 'ep-err', () => api('PATCH', `/admin/payments/${encodeURIComponent(id)}`, {
    amount: val('ep-amt'), paid_on: val('ep-date'), mode: val('ep-mode'), period_end: val('ep-end'), reference: val('ep-ref'), notes: val('ep-notes'),
  }), 'Payment saved');
}
function adminVoidPayment(id) {
  const p = (STATE.adminPayments || []).find((x) => x.id === id);
  if (!p) return;
  openModal(`Void ${p.invoice_no}?`, `
    <p class="td-small">Money records are never deleted. A void payment stays in the list (struck out), is not counted, and its days are taken back from the customer's paid period.</p>
    <div class="field mt-12"><label for="vp-reason">Why? (required)</label><input id="vp-reason" maxlength="300" placeholder="e.g. Entered twice" /></div>
    <div id="vp-err" class="error-msg hidden"></div>
    <div class="btn-group mt-12"><button class="btn btn-danger" id="vp-btn" onclick="submitVoidPayment('${esc(id)}')">Void payment</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>`);
}
function submitVoidPayment(id) {
  if (!val('vp-reason').trim()) return showErr('vp-err', 'Write why');
  return adminSubmit('vp-btn', 'vp-err', () => api('POST', `/admin/payments/${encodeURIComponent(id)}/void`, { reason: val('vp-reason').trim() }), 'Payment void');
}

async function adminInvoice(id) {
  try {
    const p = await api('GET', `/admin/payments/${encodeURIComponent(id)}`);
    const sup = p.support || {};
    openModal(`Invoice ${p.invoice_no}`, `
      <div class="invoice" id="print-area">
        <div class="inv-head">
          <img src="${h((window.APP_CONFIG && APP_CONFIG.branding && APP_CONFIG.branding.logo_url) || '/brand/logo')}" alt="" width="48" height="48" />
          <div><div class="inv-brand">${h(p.seller || 'DormBook')}</div>
            <div class="td-small">${[sup.phone, sup.email].filter(Boolean).map(h).join(' · ')}</div></div>
          <div class="inv-no"><b>${p.status === 'void' ? 'VOID — ' : ''}RECEIPT</b><div>${h(p.invoice_no)}</div><div class="td-small">${fmtDate(p.paid_on)}</div></div>
        </div>
        <dl class="facts mt-12">
          <div><dt>Billed to</dt><dd>${h(p.business_name || '')}<br>${h(p.owner.name || '')}${p.owner.mobile ? ` · ${h(p.owner.mobile)}` : ''}</dd></div>
          <div><dt>Address</dt><dd>${h([p.property.address, p.property.city, p.property.state].filter(Boolean).join(', ') || '—')}${p.property.gstin ? `<br>GSTIN ${h(p.property.gstin)}` : ''}</dd></div>
        </dl>
        <table class="mt-12"><thead><tr><th>Description</th><th>Period</th><th class="text-right">Amount</th></tr></thead>
          <tbody><tr><td>${h(p.seller || 'DormBook')} subscription — ${h(p.plan_name || '')}</td><td>${fmtDate(p.period_start)} – ${fmtDate(p.period_end)}</td><td class="text-right">${rupees(p.amount_paise)}</td></tr></tbody>
          <tfoot><tr><th colspan="2">Total received</th><th class="text-right">${rupees(p.amount_paise)}</th></tr></tfoot></table>
        <p class="td-small mt-12">Paid by ${h(PAY_MODES[p.mode] || p.mode)}${p.reference ? ` · Ref ${h(p.reference)}` : ''}${p.status === 'void' ? ` · VOID: ${h(p.void_reason || '')}` : ''}</p>
      </div>
      <div class="btn-group mt-12 no-print"><button class="btn btn-primary" onclick="printModal()">🖨 Print / Save PDF</button>
        <button class="btn btn-outline" onclick="closeModal()">Close</button></div>`, { wide: true });
  } catch (ex) { toast(ex.message, 'error'); }
}
function printModal() {
  // Same print mode as guest bills (app.css: body.printing-bill prints only the popup).
  document.body.classList.add('printing-bill');
  const done = () => { document.body.classList.remove('printing-bill'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 1000); }, 50);
}

// ── Plans ───────────────────────────────────────────────────────
async function adminPlans(el) {
  const plans = await api('GET', '/admin/plans');
  STATE.adminPlans = plans;
  el.innerHTML = `
    <div class="btn-group mb-12"><button class="btn btn-primary" onclick="adminPlanModal()">➕ Add plan</button></div>
    <p class="td-small mb-12">Active plans show on the sign-up screen and in “Record payment”. A plan that was ever used is hidden instead of deleted, so old invoices stay correct.</p>
    <div class="card table-wrap">
      ${plans.length ? `<table><thead><tr><th>Plan</th><th class="text-right">Price</th><th>Days</th><th>Bed limit</th><th>Customers</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${plans.map((p) => `<tr>
        <td><div class="td-name">${h(p.name)}</div><div class="td-small">${h(p.description || '')}</div></td>
        <td class="text-right"><b>${rupees(p.price_paise)}</b></td><td>${p.duration_days}</td><td>${p.max_beds || '—'}</td>
        <td>${p.accounts_on_plan} · ${p.payments} paid</td>
        <td>${p.is_active ? '<span class="badge badge-success">Shown</span>' : '<span class="badge badge-gray">Hidden</span>'}</td>
        <td class="actions-cell"><button class="btn btn-outline btn-sm" onclick="adminPlanModal('${esc(p.id)}')">✏️ Edit</button>
          <button class="btn btn-danger btn-sm" onclick="adminDeletePlan('${esc(p.id)}')">🗑</button></td></tr>`).join('')}</tbody></table>`
        : '<div class="empty-state"><p>No plans yet. Add your first plan (e.g. Monthly ₹499 / 30 days).</p></div>'}
    </div>`;
}
function adminPlanModal(id) {
  const p = id ? (STATE.adminPlans || []).find((x) => x.id === id) : null;
  openModal(p ? `Edit plan: ${p.name}` : 'Add plan', `
    <div class="field"><label for="pl-name">Name *</label><input id="pl-name" maxlength="60" value="${h(p ? p.name : '')}" placeholder="Monthly" /></div>
    <div class="field-row">
      <div class="field"><label for="pl-price">Price (₹) *</label><input id="pl-price" type="number" min="0" step="0.01" value="${p ? (p.price_paise / 100) : ''}" /></div>
      <div class="field"><label for="pl-days">Days *</label><input id="pl-days" type="number" min="1" max="3660" value="${p ? p.duration_days : 30}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label for="pl-beds">Bed limit (info)</label><input id="pl-beds" type="number" min="1" value="${p && p.max_beds ? p.max_beds : ''}" placeholder="No limit" /></div>
      <div class="field"><label for="pl-sort">Order</label><input id="pl-sort" type="number" min="0" max="9999" value="${p ? p.sort_order : 0}" /></div>
    </div>
    <div class="field"><label for="pl-desc">Description</label><input id="pl-desc" maxlength="500" value="${h(p ? p.description || '' : '')}" /></div>
    <label class="check-row"><input type="checkbox" id="pl-active" ${!p || p.is_active ? 'checked' : ''} /> Show this plan</label>
    <div id="pl-err" class="error-msg hidden"></div>
    <div class="btn-group mt-12"><button class="btn btn-primary" id="pl-btn" onclick="submitPlan('${esc(id || '')}')">Save</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>`);
}
function submitPlan(id) {
  const body = { name: val('pl-name').trim(), price: val('pl-price'), duration_days: Number(val('pl-days')),
    max_beds: val('pl-beds') ? Number(val('pl-beds')) : null, sort_order: Number(val('pl-sort')) || 0,
    description: val('pl-desc').trim(), is_active: document.getElementById('pl-active').checked };
  if (!body.name || body.price === '') return showErr('pl-err', 'Name and price are required');
  return adminSubmit('pl-btn', 'pl-err', () => (id ? api('PATCH', `/admin/plans/${encodeURIComponent(id)}`, body) : api('POST', '/admin/plans', body)), 'Plan saved');
}
async function adminDeletePlan(id) {
  const p = (STATE.adminPlans || []).find((x) => x.id === id);
  if (!confirm(`Delete plan "${p ? p.name : ''}"?`)) return;
  try { const r = await api('DELETE', `/admin/plans/${encodeURIComponent(id)}`); toast(r.message || 'Plan deleted', r.mode === 'hidden' ? 'warning' : 'success', 5000); refreshCurrentPage(); }
  catch (ex) { toast(ex.message, 'error'); }
}

// ── Reports ─────────────────────────────────────────────────────
async function adminReports(el) {
  const f = ADMIN.reports;
  const q = new URLSearchParams();
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  const d = await api('GET', `/admin/reports?${q}`);
  f.from = d.from; f.to = d.to;
  const max = Math.max(1, ...d.monthly.map((m) => m.revenue_paise));
  const maxS = Math.max(1, ...d.monthly.map((m) => m.signups));
  const mlabel = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  el.innerHTML = `
    <div class="filters">
      <label class="td-small">From <input id="ar-from" type="date" value="${h(d.from)}" /></label>
      <label class="td-small">To <input id="ar-to" type="date" value="${h(d.to)}" /></label>
      <button class="btn btn-outline btn-sm" onclick="adminReportPreset('month')">This month</button>
      <button class="btn btn-outline btn-sm" onclick="adminReportPreset('last')">Last month</button>
      <button class="btn btn-outline btn-sm" onclick="adminReportPreset('year')">Last 12 months</button>
    </div>
    <div class="kpis">
      <div class="kpi good"><span>Revenue</span><strong>${rupees(d.range.revenue_paise)}</strong><em>${fmtDate(d.from)} – ${fmtDate(d.to)}</em></div>
      <div class="kpi"><span>Payments</span><strong>${d.range.payments}</strong><em>from ${d.range.customers} customers</em></div>
      <div class="kpi"><span>New sign-ups</span><strong>${d.range.signups}</strong><em>in this period</em></div>
      <div class="kpi"><span>Paying now</span><strong>${(d.status.active || 0) + (d.status.grace || 0)}</strong><em>${d.status.trial || 0} on trial · ${(d.status.expired || 0) + (d.status.trial_expired || 0)} lapsed</em></div>
    </div>
    <div class="btn-group mb-20">
      <button class="btn btn-outline btn-sm" onclick="adminDownload('payments')">⬇ Payments CSV</button>
      <button class="btn btn-outline btn-sm" onclick="adminDownload('accounts')">⬇ Customers CSV</button>
      <button class="btn btn-outline btn-sm" onclick="adminDownload('users')">⬇ Users CSV</button>
    </div>
    <div class="card mb-20"><strong>Revenue and sign-ups, last 12 months</strong>
      <div class="bars mt-12" role="img" aria-label="Monthly revenue chart">${d.monthly.map((m) => `
        <div class="bar-col" title="${h(mlabel(m.month))}: ${h(rupees(m.revenue_paise))}, ${m.signups} sign-ups">
          <div class="bar-val">${m.revenue_paise ? h(rupees(m.revenue_paise).replace(/\.00$/, '')) : ''}</div>
          <div class="bar" style="height:${Math.round((m.revenue_paise / max) * 100)}%"></div>
          <div class="bar2" style="height:${Math.round((m.signups / maxS) * 30)}px" title="${m.signups} sign-ups"></div>
          <div class="bar-lbl">${h(mlabel(m.month))}</div>
        </div>`).join('')}</div>
      <div class="td-small mt-8"><span class="legend-dot"></span> revenue &nbsp; <span class="legend-dot alt"></span> sign-ups</div>
    </div>
    <div class="admin-grid">
      <div class="card"><strong>By payment mode</strong>${miniTable(d.by_mode.map((r) => [PAY_MODES[r.mode] || r.mode, r.n, rupees(r.amount_paise)]), ['Mode', 'Count', 'Amount'])}</div>
      <div class="card"><strong>By plan</strong>${miniTable(d.by_plan.map((r) => [r.plan, r.n, rupees(r.amount_paise)]), ['Plan', 'Count', 'Amount'])}</div>
      <div class="card"><strong>Renewals due in 30 days</strong>${miniTable(d.renewals_due_30.map((r) => [r.business_name, fmtDate(r.paid_until), { html: statusBadge(r.status, r.days_left) }]), ['Business', 'Paid until', 'Status'])}</div>
      <div class="card"><strong>Top customers (all time)</strong>${miniTable(d.top_customers.map((r) => [r.business_name || '—', r.n, rupees(r.amount_paise)]), ['Business', 'Payments', 'Total'])}</div>
      <div class="card"><strong>Customers by status</strong>${miniTable(Object.entries(d.status).map(([k, v]) => [{ html: statusBadge(k) }, v]), ['Status', 'Customers'])}</div>
      <div class="card"><strong>Active logins by role</strong>${miniTable(d.users_by_role.map((r) => [r.role, r.n]), ['Role', 'Logins'])}</div>
    </div>`;
  document.getElementById('ar-from').addEventListener('change', (e) => { f.from = e.target.value; adminReports(el); });
  document.getElementById('ar-to').addEventListener('change', (e) => { f.to = e.target.value; adminReports(el); });
}
/** Small table. Every cell is escaped, except cells given as { html } (built here from escaped parts). */
function miniTable(rows, head) {
  if (!rows.length) return '<p class="td-small mt-8">Nothing yet.</p>';
  const cell = (c) => (c && typeof c === 'object' && 'html' in c ? c.html : h(c));
  return `<div class="table-wrap mt-8"><table><thead><tr>${head.map((x, i) => `<th class="${i ? 'text-right' : ''}">${h(x)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? 'text-right' : ''}">${cell(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function adminReportPreset(kind) {
  const t = todayIST();
  const f = ADMIN.reports;
  if (kind === 'month') { f.from = `${t.slice(0, 7)}-01`; f.to = t; }
  if (kind === 'last') { const end = addDaysIso(`${t.slice(0, 7)}-01`, -1); f.from = `${end.slice(0, 7)}-01`; f.to = end; }
  if (kind === 'year') { f.from = addDaysIso(t, -365); f.to = t; }
  refreshCurrentPage();
}

// ── Content & branding ──────────────────────────────────────────
async function adminContent(el) {
  const c = await api('GET', '/admin/content');
  STATE.adminContent = c;
  const tab = ADMIN.contentTab;
  el.innerHTML = `
    <div class="sub-tabs" role="tablist">
      ${[['branding', '🎨 Branding'], ['support', '☎️ Support'], ['faq', '❓ FAQ']].map(([k, l]) =>
        `<button role="tab" class="sub-tab ${tab === k ? 'active' : ''}" onclick="ADMIN.contentTab='${k}';refreshCurrentPage()">${l}</button>`).join('')}
    </div>
    <div class="card" id="ct-body"></div>`;
  const body = document.getElementById('ct-body');
  if (tab === 'branding') {
    const b = c.branding;
    body.innerHTML = `
      <div class="field"><label for="cb-name">App name</label><input id="cb-name" maxlength="40" value="${h(b.app_name)}" /></div>
      <div class="field"><label for="cb-tag">Tagline (login screen)</label><input id="cb-tag" maxlength="80" value="${h(b.tagline || '')}" /></div>
      <div class="field"><label>Logo</label>
        <div class="logo-edit"><img id="cb-preview" src="${h(b.logo_data_url || '/brand/logo?v=default')}" alt="Logo preview" width="72" height="72" />
          <div><input id="cb-file" type="file" accept="image/png,image/jpeg,image/webp" />
            <div class="field-note">PNG, JPG or WEBP, square works best, under 400 KB. ${b.logo_data_url ? '' : 'Now showing the built-in DormBook logo.'}</div>
            ${b.logo_data_url ? '<label class="check-row mt-8"><input type="checkbox" id="cb-remove" /> Go back to the built-in logo</label>' : ''}</div></div></div>
      <div id="cb-err" class="error-msg hidden"></div>
      <div class="btn-group mt-12"><button class="btn btn-primary" id="cb-btn" onclick="submitBranding()">Save branding</button></div>`;
    document.getElementById('cb-file').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      hideErr('cb-err');
      if (!file) return;
      try { STATE.newLogo = await shrinkLogo(file); document.getElementById('cb-preview').src = STATE.newLogo; }
      catch (ex) { STATE.newLogo = null; showErr('cb-err', ex.message); }
    });
    STATE.newLogo = null;
  } else if (tab === 'support') {
    const s = c.support;
    body.innerHTML = `
      <p class="td-small mb-12">Shown on the sign-in screen (“Forgot password? Contact support”) and in Help.</p>
      <div class="field-row">
        <div class="field"><label for="cs-phone">Support phone</label><input id="cs-phone" type="tel" maxlength="20" value="${h(s.phone)}" /></div>
        <div class="field"><label for="cs-wa">WhatsApp (with country code)</label><input id="cs-wa" type="tel" maxlength="15" value="${h(s.whatsapp)}" placeholder="9198XXXXXXXX" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="cs-email">Support email</label><input id="cs-email" type="email" maxlength="120" value="${h(s.email)}" /></div>
        <div class="field"><label for="cs-hours">Hours</label><input id="cs-hours" maxlength="80" value="${h(s.hours)}" placeholder="Mon–Sat, 10am–7pm" /></div>
      </div>
      <div class="field"><label for="cs-msg">Message</label><textarea id="cs-msg" rows="2" maxlength="300">${h(s.message)}</textarea></div>
      <div id="cs-err" class="error-msg hidden"></div>
      <div class="btn-group mt-12"><button class="btn btn-primary" id="cs-btn" onclick="submitSupport()">Save support details</button></div>`;
  } else {
    STATE.faqDraft = (c.faq || []).map((x) => ({ ...x }));
    renderFaqEditor();
  }
}
function renderFaqEditor() {
  const body = document.getElementById('ct-body');
  const items = STATE.faqDraft;
  body.innerHTML = `
    <p class="td-small mb-12">Questions shown to PG owners in Help (Settings → My Account). Up to 40.</p>
    ${items.map((x, i) => `<div class="faq-edit">
      <div class="field"><label for="fq-q${i}">Question ${i + 1}</label><input id="fq-q${i}" maxlength="200" value="${h(x.q)}" /></div>
      <div class="field"><label for="fq-a${i}">Answer</label><textarea id="fq-a${i}" rows="2" maxlength="2000">${h(x.a)}</textarea></div>
      <div class="btn-group"><button class="btn btn-outline btn-sm" onclick="faqMove(${i},-1)" ${i ? '' : 'disabled'}>↑</button>
        <button class="btn btn-outline btn-sm" onclick="faqMove(${i},1)" ${i < items.length - 1 ? '' : 'disabled'}>↓</button>
        <button class="btn btn-danger btn-sm" onclick="faqRemove(${i})">Remove</button></div></div>`).join('') || '<p class="td-small">No questions yet.</p>'}
    <div id="fq-err" class="error-msg hidden"></div>
    <div class="btn-group mt-12"><button class="btn btn-outline" onclick="faqAdd()" ${items.length >= 40 ? 'disabled' : ''}>➕ Add question</button>
      <button class="btn btn-primary" id="fq-btn" onclick="submitFaq()">Save FAQ</button></div>`;
}
function faqRead() { STATE.faqDraft = STATE.faqDraft.map((x, i) => ({ q: val(`fq-q${i}`), a: val(`fq-a${i}`) })); }
function faqAdd() { faqRead(); STATE.faqDraft.push({ q: '', a: '' }); renderFaqEditor(); document.getElementById(`fq-q${STATE.faqDraft.length - 1}`)?.focus(); }
function faqRemove(i) { faqRead(); STATE.faqDraft.splice(i, 1); renderFaqEditor(); }
function faqMove(i, d) { faqRead(); const a = STATE.faqDraft; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; renderFaqEditor(); }
async function contentSave(key, body, btnId, errId) {
  hideErr(errId);
  const btn = document.getElementById(btnId); busy(btn, true, 'Saving…');
  try { await api('PUT', `/admin/content/${key}`, body); toast('Saved', 'success'); await loadAppConfig(true); refreshCurrentPage(); }
  catch (ex) { showErr(errId, ex.message); busy(btn, false); }
}
function submitBranding() {
  const body = { app_name: val('cb-name').trim(), tagline: val('cb-tag').trim() };
  if (STATE.newLogo) body.logo_data_url = STATE.newLogo;
  if (document.getElementById('cb-remove')?.checked) body.remove_logo = true;
  return contentSave('branding', body, 'cb-btn', 'cb-err');
}
function submitSupport() {
  return contentSave('support', { phone: val('cs-phone'), whatsapp: val('cs-wa'), email: val('cs-email'), hours: val('cs-hours'), message: val('cs-msg') }, 'cs-btn', 'cs-err');
}
function submitFaq() { faqRead(); return contentSave('faq', { items: STATE.faqDraft.filter((x) => x.q.trim() || x.a.trim()) }, 'fq-btn', 'fq-err'); }
/** Logo → square PNG/JPEG data URL, at most 512 px, under 400 KB. */
function shrinkLogo(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error('Choose a PNG, JPG or WEBP image'));
    if (file.size > 8 * 1024 * 1024) return reject(new Error('Image is too large (max 8 MB before shrinking)'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const side = Math.min(512, Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = side; c.height = side;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, side, side);
        const s = Math.min(side / img.width, side / img.height);
        const w = Math.round(img.width * s), hgt = Math.round(img.height * s);
        ctx.drawImage(img, Math.round((side - w) / 2), Math.round((side - hgt) / 2), w, hgt);
        let out = c.toDataURL('image/png');
        if (out.length > 520000) out = c.toDataURL('image/jpeg', 0.85);
        if (out.length > 520000) throw new Error('Logo is still too large after shrinking — use a simpler image');
        resolve(out);
      } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image this phone can read')); };
    img.src = url;
  });
}

// ── Super-admins ────────────────────────────────────────────────
async function adminAdmins(el) {
  const list = await api('GET', '/admin/admins');
  STATE.adminAdmins = list;
  el.innerHTML = `
    <div class="btn-group mb-12"><button class="btn btn-primary" onclick="adminAdminModal()">➕ Add super-admin</button></div>
    <p class="td-small mb-12">Super-admins sign in with email + password and can see this whole panel. At least one must stay active.
      Locked out? Set <code>SUPERADMIN_RESET=true</code> with <code>SUPERADMIN_EMAIL</code> / <code>SUPERADMIN_PASSWORD</code> in Render → Environment, redeploy, sign in, then remove <code>SUPERADMIN_RESET</code>.</p>
    <div class="card table-wrap"><table>
      <thead><tr><th>Name</th><th>Email</th><th>Mobile</th><th>Status</th><th>Last sign-in</th><th>Actions</th></tr></thead>
      <tbody>${list.map((a) => `<tr>
        <td><div class="td-name">${h(a.name)}${a.is_me ? ' <span class="badge badge-info">you</span>' : ''}</div></td>
        <td>${h(a.email || '')}</td><td>${h(/^0\d{9}$/.test(a.mobile || '') ? '—' : a.mobile || '—')}</td>
        <td>${a.is_active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-danger">Off</span>'}</td>
        <td>${a.last_login_at ? fmtDateTime(a.last_login_at) : '—'}</td>
        <td class="actions-cell"><button class="btn btn-outline btn-sm" onclick="adminAdminModal('${esc(a.id)}')">✏️ Edit</button>
          ${a.is_me ? '' : `<button class="btn btn-danger btn-sm" onclick="adminDeleteAdmin('${esc(a.id)}')">🗑 Delete</button>`}</td></tr>`).join('')}</tbody>
    </table></div>`;
}
function adminAdminModal(id) {
  const a = id ? (STATE.adminAdmins || []).find((x) => x.id === id) : null;
  openModal(a ? `Edit super-admin: ${a.name}` : 'Add super-admin', `
    <div class="field"><label for="ad-name">Name *</label><input id="ad-name" maxlength="120" value="${h(a ? a.name : '')}" /></div>
    <div class="field-row">
      <div class="field"><label for="ad-email">Email * (sign-in)</label><input id="ad-email" type="email" maxlength="120" autocapitalize="off" value="${h(a ? a.email || '' : '')}" /></div>
      <div class="field"><label for="ad-mobile">Mobile</label><input id="ad-mobile" type="tel" inputmode="numeric" maxlength="14" value="${h(a && !/^0\d{9}$/.test(a.mobile || '') ? a.mobile : '')}" /></div>
    </div>
    <div class="field"><label for="ad-pass">${a ? 'New password (leave empty to keep)' : 'Password *'}</label>${pwInput('ad-pass', 'Min 10 characters')}</div>
    ${a && !a.is_me ? `<label class="check-row"><input type="checkbox" id="ad-active" ${a.is_active ? 'checked' : ''} /> Active (can sign in)</label>` : ''}
    <div id="ad-err" class="error-msg hidden"></div>
    <div class="btn-group mt-12"><button class="btn btn-primary" id="ad-btn" onclick="submitAdmin('${esc(id || '')}')">Save</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>`);
}
async function submitAdmin(id) {
  const body = { name: val('ad-name').trim(), email: val('ad-email').trim(), mobile: val('ad-mobile').trim() };
  const pw = val('ad-pass').trim();
  if (pw) body.password = pw;
  if (!id && pw.length < 10) return showErr('ad-err', 'Password must be at least 10 characters');
  if (pw && pw.length < 10) return showErr('ad-err', 'Password must be at least 10 characters');
  const act = document.getElementById('ad-active');
  if (act) body.is_active = act.checked;
  if (!body.mobile) delete body.mobile;
  const r = await adminSubmit('ad-btn', 'ad-err', () => (id ? api('PATCH', `/admin/admins/${encodeURIComponent(id)}`, body) : api('POST', '/admin/admins', body)), 'Super-admin saved');
  // Changed your own password: keep this phone signed in with the fresh session.
  if (r && r.token) setToken(r.token);
}
async function adminDeleteAdmin(id) {
  const a = (STATE.adminAdmins || []).find((x) => x.id === id);
  if (!confirm(`Delete super-admin ${a ? a.name : ''}? They can no longer sign in.`)) return;
  try { await api('DELETE', `/admin/admins/${encodeURIComponent(id)}`); toast('Super-admin removed', 'success'); refreshCurrentPage(); }
  catch (ex) { toast(ex.message, 'error'); }
}

// ── System & backups ────────────────────────────────────────────
async function adminSystem(el, check) {
  const s = await api('GET', `/admin/system${check ? '?check=1' : ''}`);
  const b = s.backups;
  const st = b.status || {};
  const yes = (x) => (x ? '✅ On' : '— Off');
  el.innerHTML = `
    <div class="kpis">
      <div class="kpi"><span>App version</span><strong style="font-size:16px">${h(s.version)}</strong><em>${h(s.platform)} · Node ${h(s.node)}</em></div>
      <div class="kpi"><span>Running for</span><strong>${s.uptime_minutes < 120 ? `${s.uptime_minutes} min` : `${Math.round(s.uptime_minutes / 60)} h`}</strong><em>${s.memory_mb} MB memory</em></div>
      <div class="kpi"><span>Database</span><strong>${(s.database.kb / 1024).toFixed(1)} MB</strong><em>check: ${h(s.database.integrity)}</em></div>
      <div class="kpi"><span>Live connections</span><strong>${s.live.connections}</strong><em>phones / browsers getting live updates</em></div>
    </div>
    <div class="btn-group mb-20">
      <button class="btn btn-primary" id="sys-bk" onclick="adminBackupNow()">💾 Back up now</button>
      <button class="btn btn-outline" id="sys-chk" onclick="adminSystemCheck()">🩺 Check database</button>
      ${b.offsite_configured.length ? `<button class="btn btn-outline" id="sys-sync" onclick="adminSyncUploads()">☁️ Copy all ID files off-site</button>` : ''}
    </div>
    <div class="admin-grid">
      <div class="card"><strong>Off-site backups</strong>
        <dl class="facts mt-12">
          <div><dt>Cloudflare R2</dt><dd>${b.offsite_configured.includes('R2') ? '✅ Connected' : '— Not set up'}</dd></div>
          <div><dt>Supabase Storage</dt><dd>${b.offsite_configured.includes('Supabase') ? '✅ Connected' : '— Not set up'}</dd></div>
          <div><dt>Last copy</dt><dd>${st.last_offsite ? `${h(st.last_offsite.file)}<br>${fmtDateTime(st.last_offsite.at)} · ${h((st.last_offsite.stores || []).join(' + '))}` : '—'}</dd></div>
          ${st.last_offsite_error ? `<div><dt>Last problem</dt><dd class="text-danger">${h(st.last_offsite_error)}</dd></div>` : ''}
        </dl>
        ${b.offsite_configured.length ? '' : '<p class="td-small">Set the R2_… and/or SUPABASE_… values in Render → Environment to copy every backup and ID file off-site.</p>'}
        ${b.offsite.map((o) => `${o.error ? `<p class="text-danger td-small">${h(o.store)}: ${h(o.error)}</p>` : ''}
          ${o.files.length ? miniTable(o.files.slice(0, 8).map((x) => [x.file, `${x.kb} KB`]), [`In ${o.store} (newest first)`, 'Size']) : `<p class="td-small mt-8">${h(o.store)}: no backups yet.</p>`}`).join('')}
      </div>
      <div class="card"><strong>Backups on the server disk</strong>
        <p class="td-small mt-8">Made at every start, every night at 03:15, and when you press “Back up now”. Newest 14 of each kind are kept.</p>
        ${b.local.length ? miniTable(b.local.slice(0, 10).map((x) => [x.file, `${x.kb} KB`]), ['On disk (newest first)', 'Size']) : '<p class="td-small">None yet.</p>'}
      </div>
      <div class="card"><strong>Settings</strong>
        <dl class="facts mt-12">
          <div><dt>OTP / SMS codes</dt><dd>${yes(s.settings.otp_enabled)}</dd></div>
          <div><dt>Payment grace days</dt><dd>${s.settings.grace_days}</dd></div>
          <div><dt>Scheduled jobs</dt><dd>${h(s.settings.scheduler)}</dd></div>
          <div><dt>WhatsApp sending</dt><dd>${yes(s.settings.whatsapp)}</dd></div>
          <div><dt>Database file</dt><dd class="td-small">${h(s.database.path)}</dd></div>
        </dl>
      </div>
    </div>`;
}
async function adminSystemCheck() {
  const btn = document.getElementById('sys-chk'); busy(btn, true, 'Checking…');
  try { await adminSystem(document.getElementById('page-content'), true); toast('Database checked', 'success'); }
  catch (ex) { toast(ex.message, 'error'); busy(btn, false); }
}
async function adminBackupNow() {
  const btn = document.getElementById('sys-bk'); busy(btn, true, 'Backing up…');
  try { const r = await api('POST', '/admin/system/backup'); toast(`Saved ${r.file} · off-site: ${r.offsite}`, r.offsite_ok || r.offsite_skipped ? 'success' : 'warning', 7000); refreshCurrentPage(); }
  catch (ex) { toast(ex.message, 'error'); busy(btn, false); }
}
async function adminSyncUploads() {
  const btn = document.getElementById('sys-sync'); busy(btn, true, 'Copying…');
  try { const r = await api('POST', '/admin/system/sync-uploads'); toast(`Checked ${r.checked} files · copied ${r.uploaded}${r.failed ? ` · ${r.failed} failed` : ''}`, r.failed ? 'warning' : 'success', 6000); busy(btn, false); }
  catch (ex) { toast(ex.message, 'error'); busy(btn, false); }
}

// ── Admin log ───────────────────────────────────────────────────
async function adminAudit(el) {
  const rows = await api('GET', '/admin/audit?limit=300');
  const words = (a) => String(a || '').toLowerCase().replace(/_/g, ' ');
  const detail = (d) => {
    if (!d || typeof d !== 'object') return h(d || '');
    return Object.entries(d).filter(([, v]) => v !== null && v !== undefined && v !== '').slice(0, 6)
      .map(([k, v]) => `${h(k.replace(/_/g, ' '))}: <b>${h(typeof v === 'object' ? JSON.stringify(v) : v)}</b>`).join(' · ');
  };
  el.innerHTML = `
    <p class="td-small mb-12">Every change made in this panel: who, what and when. Newest first (last 300).</p>
    <div class="card table-wrap">${rows.length ? `<table>
      <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${fmtDateTime(r.created_at)}</td><td>${h(r.actor_name || '')}</td>
        <td><span class="badge badge-gray">${h(words(r.action))}</span></td><td class="td-small">${detail(r.details)}</td></tr>`).join('')}</tbody>
    </table>` : '<div class="empty-state"><p>Nothing yet.</p></div>'}</div>`;
}

/** Pages where an automatic refresh never loses typing (lists and reports, not forms). */
const ADMIN_AUTO_REFRESH = new Set(['admin', 'admin_accounts', 'admin_users', 'admin_payments', 'admin_plans', 'admin_reports', 'admin_admins', 'admin_audit']);
