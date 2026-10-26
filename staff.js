const normalSessions = [];
let activeSessions = normalSessions;
let demoActive = false;
let demoViewInitialized = false;
let viewerRole = 'staff';
let selected = null;
const $ = selector => document.querySelector(selector);

function safe(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3500);
}
function render(rows = activeSessions) {
  $('#sessionRows').innerHTML = rows.map(record => `
    <tr>
      <td>${safe(record.name)}</td><td>${safe(record.locker)}</td>
      <td>${safe(record.started)}</td><td>${record.paid == null ? '—' : `₱${safe(record.paid)}`}</td><td>${record.minutes ? `${safe(record.minutes)} min` : '—'}</td><td>${safe(record.used)}</td><td><span class="status">${safe(record.status)}</span></td>
      <td>${record.status === 'Awaiting pickup'
        ? `<button class="action" data-review="${safe(record.id)}">Review recovery</button>`
        : demoActive && viewerRole === 'owner' && record.status === 'Charging'
          ? `<button class="action" data-end-demo="${safe(record.id)}">End demo charge</button>`
          : `<button class="action" disabled>${safe(record.status)}</button>`}</td>
  </tr>`).join('') || '<tr><td colspan="8" style="text-align:center">No active camper sessions are available.</td></tr>';
}

render();
$('#search').addEventListener('input', event => {
  const query = event.target.value.toLowerCase();
  render(activeSessions.filter(record => [record.name, record.locker].some(value => String(value).toLowerCase().includes(query))));
});
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));

$('#sessionRows').addEventListener('click', async event => {
  const endDemoButton = event.target.closest('[data-end-demo]');
  if (endDemoButton && demoActive && viewerRole === 'owner') {
    const record = activeSessions.find(item => item.id === endDemoButton.dataset.endDemo);
    if (record?.status === 'Charging') {
      try {
        await updateDemoSession(record.id, { status: 'Awaiting pickup' });
        await syncDemoView();
      } catch (error) { toast(error.message); return; }
      toast('Demo charge ended. The locker stays locked until pickup is authorized.');
    }
    return;
  }
  const button = event.target.closest('[data-review]');
  if (!button || button.disabled) return;
  selected = activeSessions.find(item => item.id === button.dataset.review);
  if (!selected) return;
  $('#recordReview').innerHTML = `Saved camper: <b>${safe(selected.name)}</b><br>Locker: <b>${safe(selected.locker)}</b> · Started: <b>${safe(selected.started)}</b><br>Paid: <b>₱${safe(selected.paid ?? 0)}</b> · Time paid: <b>${safe(selected.minutes ?? 0)} min</b> · Time used: <b>${safe(selected.used)}</b><br>Status: <b>${safe(selected.status)}</b><br><span>PIN is never shown.</span>`;
  $('#identityConfirmed').checked = false;
  $('#identityHint').textContent = 'Compare the camper and session details with this saved record.';
  $('#identityHint').className = 'verify-hint';
  $('#overrideDialog').showModal();
});

$('#overrideForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!selected || selected.status !== 'Awaiting pickup') {
    toast('Recovery is available after charging has ended.'); return;
  }
  if (!$('#identityConfirmed').checked) return;
  try {
    const response = await fetch(`/api/staff/sessions/${encodeURIComponent(selected.id)}/recover`, { method: 'POST' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(result.error || 'Could not record the recovery.');
  } catch (error) { toast(error.message); return; }
  $('#identityHint').textContent = 'Name and session details verified.';
  $('#identityHint').className = 'verify-hint valid';
  $('#overrideDialog').close();
  toast(demoActive
    ? 'Demo recovery recorded temporarily. The camper kiosk will open the locker.'
    : 'Recovery recorded locally. Connect the locker controller to operate the lock.');
  await Promise.all([loadLiveSessions(), loadAudit()]);
});

function setDemoView(active, sessions = null) {
  const nextActive = Boolean(active);
  const changed = !demoViewInitialized || nextActive !== demoActive;
  demoActive = nextActive;
  demoViewInitialized = true;
  activeSessions = demoActive && Array.isArray(sessions) ? sessions : normalSessions;
  $('#staffNotice').innerHTML = demoActive
    ? '<b>OWNER DEMO ACTIVE</b> · Showing the temporary camper sessions created during this demo. Recovery records are temporary.'
    : '<b>Staff dashboard</b> · Revenue and profit are visible only to the owner.';
  $('#solarValue').textContent = 'Unavailable';
  $('#solarDetail').textContent = 'Sensor not connected';
  $('#voltageValue').textContent = 'Unavailable';
  $('#voltageDetail').textContent = 'Sensor not connected';
  $('#currentValue').textContent = 'Unavailable';
  $('#currentDetail').textContent = 'Sensor not connected';
  $('.updated').innerHTML = demoActive ? '<i></i> Temporary demo sessions' : '<i></i> Waiting for live telemetry';
  if (changed) {
    $('#auditLog').replaceChildren();
    $('#auditEmpty').hidden = false;
    $('.audit-panel .badge').textContent = 'No overrides recorded';
    selected = null;
  }
  render();
}
async function updateDemoSession(id, updates) {
  const response = await fetch(`/api/owner/demo/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(result.error || 'Could not update the demo session.');
  return result.session;
}
async function syncDemoView() {
  if (viewerRole !== 'owner') return;
  try {
    const response = await fetch('/api/demo/status', { cache: 'no-store' });
    if (!response.ok) return;
    const state = await response.json();
    if (state.active) {
      syncTransportStatus();
      const sessionsResponse = await fetch('/api/owner/demo/sessions', { cache: 'no-store' });
      if (sessionsResponse.ok) {
        const data = await sessionsResponse.json();
        setDemoView(true, data.sessions);
        await loadAudit();
      }
    } else {
      setDemoView(false);
      syncTransportStatus();
      await loadLiveSessions();
      await loadAudit();
    }
  } catch (_) { /* Preserve the current view during a brief local-service interruption. */ }
}
async function loadLiveSessions() {
  try {
    const response = await fetch('/api/staff/sessions', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    setDemoView(Boolean(data.demo_active), data.sessions || []);
    activeSessions = data.sessions || [];
    render(activeSessions.filter(record => [record.name, record.locker].some(value => String(value).toLowerCase().includes($('#search').value.toLowerCase()))));
  } catch (_) { /* Keep the last records visible if the local service briefly disconnects. */ }
}
async function syncTransportStatus() {
  try {
    const response = await fetch('/api/connectivity/status', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    $('#solarValue').textContent = data.battery_detected && data.battery_percent != null ? `${Math.round(data.battery_percent)}%` : 'Unavailable';
    $('#solarDetail').textContent = data.battery_detected ? 'Live battery sensor reading' : 'Battery sensor not connected';
    $('#loraValue').textContent = data.active_link === 'wifi' ? 'Wi-Fi connected' : data.active_link === 'lan' ? 'Ethernet LAN connected' : data.active_link === 'lora' ? 'LoRa connected' : 'Unavailable';
    $('#loraDetail').textContent = data.active_link ? 'Active communication link' : 'No connection detected';
  } catch (_) { /* Show the last saved connection choice if the service briefly disconnects. */ }
}
async function loadAudit() {
  try {
    const response = await fetch('/api/staff/audit', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    $('#auditLog').innerHTML = (data.entries || []).map(entry => {
      const when = new Date(entry.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      return `<div class="audit-row"><b>${safe(entry.action)}</b> · ${safe(entry.username || 'Unknown staff')} · ${safe(entry.subject)} · ${safe(when)}</div>`;
    }).join('');
    $('#auditEmpty').hidden = Boolean(data.entries?.length);
    $('.audit-panel .badge').textContent = `${data.entries?.length || 0} recovery record${data.entries?.length === 1 ? '' : 's'}${data.demo_active ? ' · demo' : ''}`;
  } catch (_) { /* Leave the last audit view visible during a brief service interruption. */ }
}
$('#exportAudit').addEventListener('click', async () => {
  const button = $('#exportAudit');
  button.disabled = true;
  try {
    const response = await fetch('/api/staff/audit/export', { method: 'POST' });
    if (!response.ok) throw Error('Could not export the recovery audit.');
    const blob = await response.blob();
    const name = response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)"?/i)?.[1] || 'recovery-audit.csv';
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    URL.revokeObjectURL(link.href);
    toast('Recovery audit saved on the kiosk and downloaded.');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

fetch('/api/me').then(response => { if (!response.ok) throw new Error(); return response.json(); })
  .then(user => {
    viewerRole = user.role;
    $('#staffName').textContent = user.username;
    if (viewerRole === 'owner') {
      syncDemoView();
      setInterval(syncDemoView, 2500);
    } else {
      setDemoView(false);
      syncTransportStatus();
      loadLiveSessions();
      loadAudit();
      setInterval(loadLiveSessions, 2500);
      setInterval(loadAudit, 5000);
      setInterval(syncTransportStatus, 10000);
    }
  })
  .catch(() => { location.href = '/login'; });
$('#staffLogout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/camper.html';
});
