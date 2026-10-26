const $ = selector => document.querySelector(selector);
let role = null;
let knownAlertIds = new Set();

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
async function api(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Could not reach the kiosk (HTTP ${response.status}).`);
  return data;
}
function showMessage(message) { $('#appMessage').textContent = message; }
async function refreshLink() {
  try {
    const status = await api('/api/connectivity/status');
    const online = Boolean(status.phone_url && status.lan_ip);
    $('#linkState').textContent = online ? `${status.network_type || 'Local network'} · ${status.lan_ip}` : 'Kiosk link unavailable';
    $('#linkState').className = `link-state ${online ? 'online' : 'offline'}`;
    if (!online) showMessage('The kiosk has no active Wi-Fi phone link. Check that both devices are on the same network.');
  } catch (_) {
    $('#linkState').textContent = 'Kiosk unreachable';
    $('#linkState').className = 'link-state offline';
  }
}
async function refreshAlerts() {
  const data = await api('/api/mobile/alerts');
  const alerts = data.alerts || [];
  const newAlerts = alerts.filter(alert => alert.status !== 'Resolved');
  $('#newCount').textContent = `${newAlerts.length} open`;
  $('#alerts').innerHTML = alerts.length ? alerts.map(alert => {
    const when = new Date(alert.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
    return `<article class="alert"><div class="alert-head"><h3>${alert.is_demo ? 'DEMO · ' : ''}${escapeHtml(alert.alert_type)}</h3><time>${escapeHtml(when)}</time></div><p>${escapeHtml(alert.details || 'No location/details provided.')}</p><div class="alert-head"><span class="alert-status ${alert.status === 'Resolved' ? 'resolved' : ''}">${escapeHtml(alert.status)}</span>${alert.status !== 'Resolved' ? `<button class="resolve" data-resolve="${escapeHtml(alert.id)}">Mark handled</button>` : ''}</div></article>`;
  }).join('') : '<p class="empty">No emergency messages have arrived.</p>';
  for (const alert of newAlerts) {
    if (knownAlertIds.size && !knownAlertIds.has(alert.id)) showMessage(`New emergency message: ${alert.alert_type}`);
  }
  knownAlertIds = new Set(alerts.map(alert => alert.id));
}
async function refreshSessions() {
  const data = await api('/api/staff/sessions');
  const sessions = data.sessions || [];
  $('#sessionsHeading').textContent = data.demo_active ? 'Active locker sessions · Demo' : 'Active locker sessions';
  $('#sessions').innerHTML = sessions.length ? sessions.map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.locker)}</td><td>${escapeHtml(item.started)}</td><td>${item.paid == null ? '—' : `₱${escapeHtml(item.paid)}`}</td><td>${item.minutes ? `${escapeHtml(item.minutes)} min` : '—'}</td><td>${escapeHtml(item.used)}</td><td>${escapeHtml(item.status)}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">No active sessions.</td></tr>';
}
async function refreshOwnerReports() {
  if (role !== 'owner') return;
  $('#reportsPanel').hidden = false;
  const data = await api('/api/owner/reports');
  $('#reports').innerHTML = data.reports.length ? data.reports.map(file => `<a href="/api/owner/reports/file/${encodeURIComponent(file.name)}"><span>${escapeHtml(file.name)}</span><span>${(file.bytes / 1024).toFixed(1)} KB · Download</span></a>`).join('') : '<p class="empty">No report files on the kiosk.</p>';
}
async function refreshAll() {
  await refreshLink();
  try {
    await Promise.all([refreshAlerts(), refreshSessions(), refreshOwnerReports()]);
    if (navigator.onLine) showMessage('Live connection to the kiosk. Updates refresh every five seconds.');
  } catch (error) {
    if (error.message.includes('Sign in')) {
      $('#appPanel').hidden = true;
      $('#loginPanel').hidden = false;
      return;
    }
    showMessage(error.message);
  }
}
async function openForUser(user) {
  role = user.role;
  $('#accountLabel').textContent = `Signed in as ${user.username} · ${role}`;
  $('#loginPanel').hidden = true;
  $('#appPanel').hidden = false;
  knownAlertIds = new Set();
  await refreshAll();
  clearInterval(window.phoneRefreshTimer);
  window.phoneRefreshTimer = setInterval(refreshAll, 5000);
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('#loginError').textContent = '';
  const form = new FormData(event.currentTarget);
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ role: form.get('role'), username: form.get('username'), password: form.get('password') }) });
    const user = await api('/api/me');
    await openForUser(user);
  } catch (error) { $('#loginError').textContent = error.message; }
});
$('#signOut').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  clearInterval(window.phoneRefreshTimer);
  role = null;
  $('#appPanel').hidden = true;
  $('#loginPanel').hidden = false;
});
$('#alerts').addEventListener('click', async event => {
  const button = event.target.closest('[data-resolve]');
  if (!button) return;
  button.disabled = true;
  try {
    await api(`/api/mobile/alerts/${encodeURIComponent(button.dataset.resolve)}/resolve`, { method: 'POST', body: '{}' });
    await refreshAlerts();
  } catch (error) { button.disabled = false; showMessage(error.message); }
});

refreshLink();
api('/api/me').then(openForUser).catch(() => {
  $('#loginPanel').hidden = false;
  $('#appPanel').hidden = true;
});
