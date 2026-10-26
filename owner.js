const $ = selector => document.querySelector(selector);
let demoActive = false;
let demoViewInitialized = false;
let demoCostOverrides = {};
let demoSnapshot = { reportSessions: [], feedback: [], recoveryAudit: [] };
let demoLiveEnergy = null;
let liveOwnerData = { sessions: [], revenue: 0, count: 0, average: 0, energy_kwh: 0 };
let communicationMode = 'lora';
const demoFinancials = {
  'Today': { revenue: 250, costs: 50, sessions: 2 },
  'This week': { revenue: 1520, costs: 380, sessions: 18 },
  'This month': { revenue: 4820, costs: 1190, sessions: 56 }
};
const demoEnergy = {
  'Today': [0.00, 0.02, 0.03, 0.01, 0.02, 0.05, 0.12, 0.18, 0.23, 0.16, 0.11, 0.14, 0.21, 0.17, 0.12, 0.19, 0.26, 0.31, 0.22, 0.16, 0.14, 0.19, 0.12, 0.06],
  'This week': [2.35, 3.10, 2.80, 4.25, 3.65, 5.10, 4.40],
  'This month': Array.from({ length: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate() }, (_, day) => Number((1.1 + ((day * 7 + 3) % 13) * 0.31 + (day % 4) * 0.12).toFixed(2)))
};

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2800);
}
function esc(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) location.href = '/login';
    throw Error(data.error || `Server returned HTTP ${response.status}. Restart server.py and refresh the page.`);
  }
  return data;
}

function peso(value) {
  const amount = Math.abs(Number(value)).toLocaleString('en-PH', { maximumFractionDigits: 0 });
  return Number(value) < 0 ? `−₱${amount}` : `₱${amount}`;
}
function estimateKey(period) { return `campconnect-cost-estimate-${period.toLowerCase().replace(/ /g, '-')}`; }
function savedCost(period) { return Math.max(0, Number(localStorage.getItem(estimateKey(period))) || 0); }
function niceBound(value) {
  const raw = Math.max(value, 100);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const scaled = raw / magnitude;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * magnitude;
}
function fmtHour(h) { return h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`; }
function renderFinancialChart(revenue, costs, result, period) {
  // Waterfall: revenue, minus expenses, equals operating result
  const W = 820, H = 310, L = 74, R = 24, T = 40, B = 46, pw = W - L - R, ph = H - T - B;
  const top = niceBound(Math.max(revenue, costs, result, 1)), step = top / 4;
  const lo = result < 0 ? -Math.ceil(-result / step) * step : 0;
  const y = v => T + ph * (1 - (v - lo) / (top - lo));
  let grid = '';
  for (let v = lo; v <= top + 1e-6; v += step) grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="chart-grid ${v === 0 ? 'zero' : ''}"/><text x="${L - 10}" y="${y(v) + 4}" text-anchor="end" class="chart-tick">${v === 0 ? '₱0' : peso(v)}</text>`;
  const slot = pw / 3, bw = Math.min(124, slot * .52), cx = i => L + slot * (i + .5);
  const bars = [
    { label: 'Revenue', from: 0, to: revenue, fill: 'gRev', text: peso(revenue) },
    { label: 'Expenses', from: revenue, to: revenue - costs, fill: 'gExp', text: costs ? `−${peso(costs)}` : '₱0' },
    { label: 'Operating result', from: 0, to: result, fill: result < 0 ? 'gLoss' : 'gGain', text: peso(result) }
  ];
  const shapes = bars.map((b, i) => {
    const yTop = y(Math.max(b.from, b.to)), h = Math.abs(y(b.from) - y(b.to)), hh = h === 0 ? 0 : Math.max(3, h);
    const below = i === 2 && result < 0;
    const ly = below ? yTop + hh + 18 : yTop - 9;
    return `<g><rect x="${cx(i) - bw / 2}" y="${yTop}" width="${bw}" height="${hh}" rx="8" fill="url(#${b.fill})" class="wf-bar ${i === 1 ? 'drop' : ''}" style="animation-delay:${i * 160}ms"><title>${b.label}: ${b.text}</title></rect><text x="${cx(i)}" y="${ly}" text-anchor="middle" class="chart-value big" style="animation-delay:${i * 160 + 400}ms">${b.text}</text><text x="${cx(i)}" y="${H - 16}" text-anchor="middle" class="chart-label">${b.label}</text></g>`;
  }).join('');
  const link = (i, v) => `<line x1="${cx(i) + bw / 2}" x2="${cx(i + 1) - bw / 2}" y1="${y(v)}" y2="${y(v)}" class="wf-link"/>`;
  const links = link(0, revenue) + link(1, revenue - costs);
  const chip = revenue > 0 ? `<g class="wf-chip"><rect x="${W - R - 168}" y="4" width="168" height="26" rx="13"/><text x="${W - R - 84}" y="22" text-anchor="middle">${Math.round(result / revenue * 100)}% of revenue kept</text></g>` : '';
  const desc = `${period}: revenue ${peso(revenue)}, expenses ${peso(costs)}, estimated operating result ${peso(result)}.`;
  $('#financialChart').innerHTML = `<svg class="financial-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${desc}"><title>${desc}</title><defs>
    <linearGradient id="gRev" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3fd0c6"/><stop offset="1" stop-color="#0c6f73"/></linearGradient>
    <linearGradient id="gExp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd35e"/><stop offset="1" stop-color="#f29a1a"/></linearGradient>
    <linearGradient id="gGain" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8ee0a3"/><stop offset="1" stop-color="#2f9a5a"/></linearGradient>
    <linearGradient id="gLoss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff8c82"/><stop offset="1" stop-color="#d9362b"/></linearGradient></defs>${grid}${links}${shapes}${chip}</svg>`;
  $('#chartNote').textContent = `${period} · money in, money out, what's left (₱)`;
}
function renderEnergyChart(period) {
  const days = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const size = period === 'Today' ? 24 : period === 'This week' ? 7 : days;
  const readings = demoActive
    ? demoLiveEnergy == null ? demoEnergy[period] : (() => { const live = Array(size).fill(0); live[period === 'Today' ? new Date().getHours() : period === 'This week' ? (new Date().getDay() + 6) % 7 : new Date().getDate() - 1] = Number(demoLiveEnergy); return live; })()
    : Array(size).fill(0);
  const names = period === 'Today' ? readings.map((_, h) => fmtHour(h)) : period === 'This week' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : readings.map((_, d) => String(d + 1));
  const full = period === 'Today' ? names : period === 'This week' ? names : names.map(n => `Day ${n}`);
  const total = readings.reduce((s, v) => s + v, 0), peak = Math.max(0, ...readings), avg = total / readings.length;
  const peakAt = readings.indexOf(peak);
  const axisMax = niceBound(Math.max(peak * 1.15, 0.1)) === 0 ? 1 : (() => { const m = Math.max(peak * 1.15, 0.1), p = 10 ** Math.floor(Math.log10(m)); return Math.ceil(m / p * 2) / 2 * p; })();
  const W = 840, H = 290, L = 56, R = 18, T = 28, B = 42, pw = W - L - R, ph = H - T - B;
  const y = v => T + ph * (1 - v / axisMax);
  const grid = [0, .25, .5, .75, 1].map(f => `<line x1="${L}" x2="${W - R}" y1="${y(axisMax * f)}" y2="${y(axisMax * f)}" class="chart-grid ${f === 0 ? 'zero' : ''}"/><text x="${L - 8}" y="${y(axisMax * f) + 4}" text-anchor="end" class="energy-tick">${(axisMax * f).toFixed(2)}</text>`).join('') + `<text x="${L - 8}" y="14" text-anchor="end" class="energy-tick unit">kWh</text>`;
  const slot = pw / readings.length, bw = Math.max(4, slot * .64);
  const bars = readings.map((v, i) => {
    const h = v === 0 ? 0 : Math.max(3, (v / axisMax) * ph), x = L + slot * i + (slot - bw) / 2;
    const show = period === 'This week' || (period === 'Today' ? i % 3 === 0 : i % 5 === 0 || i === readings.length - 1);
    const lab = show ? `<text x="${L + slot * i + slot / 2}" y="${H - 16}" text-anchor="middle" class="energy-tick">${names[i]}</text>` : '';
    return `<rect x="${x}" y="${y(v)}" width="${bw}" height="${h}" rx="${Math.min(5, bw / 2)}" class="energy-bar ${total > 0 && i === peakAt ? 'peak' : ''}" fill="${total > 0 && i === peakAt ? 'url(#gPeak)' : 'url(#gEn)'}" style="animation-delay:${i * 22}ms"><title>${full[i]}: ${v.toFixed(2)} kWh</title></rect>${lab}`;
  }).join('');
  const markers = total > 0 ? `<line x1="${L}" x2="${W - R}" y1="${y(avg)}" y2="${y(avg)}" class="avg-line"/><text x="${W - R}" y="${y(avg) - 6}" text-anchor="end" class="avg-label">average ${avg.toFixed(2)}</text><text x="${Math.min(Math.max(L + slot * peakAt + slot / 2, L + 40), W - R - 40)}" y="${y(peak) - 8}" text-anchor="middle" class="peak-label">peak ${peak.toFixed(2)} · ${full[peakAt]}</text>` : `<text x="${W / 2}" y="${T + ph / 2}" text-anchor="middle" class="chart-empty">No meter readings yet</text>`;
  const description = `${period} energy use: total ${total.toFixed(2)} kilowatt-hours, peak ${peak.toFixed(2)} kilowatt-hours.`;
  $('#energyChart').innerHTML = `<svg class="energy-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${description}"><title>${description}</title><defs><linearGradient id="gEn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3fd0c6"/><stop offset="1" stop-color="#0c6f73"/></linearGradient><linearGradient id="gPeak" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd35e"/><stop offset="1" stop-color="#f29a1a"/></linearGradient></defs>${grid}${bars}${markers}</svg>`;
  $('#energyPeriodNote').textContent = `${period} · ${period === 'Today' ? 'hour by hour' : 'day by day'} · kilowatt-hours (kWh)`;
  $('#energyTotal').textContent = `${total.toFixed(2)} kWh total`;
  $('#energyCaption').textContent = demoActive
    ? demoLiveEnergy != null ? 'Live energy meter reading reported by the connected hardware.' : 'Sample demo energy readings are temporary; new sessions show meter data when a meter is connected.'
    : 'No energy meter readings yet. Connect an energy meter to record camper charging consumption.';
}
function renderFinancials() {
  const period = $('#period').value;
  const demo = demoFinancials[period];
  const createdDemoRows = demoActive ? demoRowsForPeriod(period).filter(row => !row.demo_sample) : [];
  const revenue = demoActive ? demo.revenue + createdDemoRows.reduce((sum, row) => sum + (Number(row.paid) || 0), 0) : liveOwnerData.revenue;
  const costs = demoActive ? (demoCostOverrides[period] ?? demo.costs) : savedCost(period);
  const result = revenue - costs;
  $('#revenue').textContent = peso(revenue);
  $('#revenueNote').textContent = demoActive ? 'Temporary demo values · not saved' : liveOwnerData.count ? 'Completed paid sessions stored on this kiosk' : 'No completed payment records yet';
  $('#costs').textContent = peso(costs);
  $('#costCardNote').textContent = demoActive ? 'Temporary demo estimate' : 'Owner-entered estimate';
  $('#profit').textContent = peso(result);
  const sessionCount = demo.sessions + createdDemoRows.length;
  $('#sessionCount').textContent = demoActive ? String(sessionCount) : String(liveOwnerData.count);
  $('#averagePayment').textContent = demoActive ? peso(sessionCount ? revenue / sessionCount : 0) : peso(liveOwnerData.average);
  $('#refunds').textContent = '₱0';
  $('#financialNote').textContent = demoActive ? 'Temporary simulated figures for the selected period; not stored.' : 'Completed camper sessions and payments are read from the kiosk database.';
  $('#costNote').textContent = demoActive ? 'Demo cost changes disappear when demo mode stops.' : 'This estimate is saved in this browser for the selected period.';
  $('#costInput').value = costs;
  $('#chartMode').textContent = demoActive ? 'DEMO DATA' : 'LIVE DATA';
  $('#chartCaption').textContent = demoActive
    ? 'Sample figures are temporary and disappear when demo mode stops.'
    : 'Revenue and completed sessions come from locally stored records. Expenses use your saved estimate.';
  renderFinancialChart(revenue, costs, result, period);
  renderEnergyChart(period);
}
function demoRowsForPeriod(period) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'This week') {
    const weekday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - weekday);
  } else if (period === 'This month') start.setDate(1);
  return (demoSnapshot.reportSessions || []).filter(row => {
    const stamp = row.returned_at || row.created_at;
    if (!stamp) return false;
    const date = new Date(stamp);
    return date >= start && date <= now;
  });
}
function renderDemo(active, snapshot = null) {
  const nextActive = Boolean(active);
  if (snapshot) demoSnapshot = snapshot;
  const changed = !demoViewInitialized || nextActive !== demoActive;
  if (changed && nextActive) demoCostOverrides = {};
  if (changed && !nextActive) { demoCostOverrides = {}; demoSnapshot = { reportSessions: [], feedback: [], recoveryAudit: [] }; demoLiveEnergy = null; }
  demoActive = nextActive;
  demoViewInitialized = true;
  $('#demoToggle').textContent = demoActive ? 'Stop demo' : 'Start demo';
  $('#demoToggle').classList.toggle('demo-running', demoActive);
  $('#demoNotice').hidden = !demoActive;
  $('#staffDemoLink').hidden = !demoActive;
  const rows = demoActive ? demoRowsForPeriod($('#period').value) : [];
  $('#ownerRows').innerHTML = rows.length
    ? rows.map(row => `<tr><td>${esc(row.name)}</td><td>${esc(row.locker)}</td><td>${peso(row.paid)}</td><td>${esc(row.minutes ?? '—')} min</td><td>${esc(row.used)}</td><td>${row.energy == null ? 'Meter needed' : `${Number(row.energy).toFixed(3)} kWh`}</td><td>${esc(row.returned || '—')}</td></tr>`).join('')
    : '<tr><td colspan="7" class="muted-cell">No completed sessions in this period.</td></tr>';
  $('#sessionEmptyNote').textContent = demoActive ? 'Temporary demonstration rows · not saved' : 'No completed sessions recorded.';
  renderFinancials();
}
function renderConnectivity(mode, status = {}) {
  communicationMode = mode === 'wifi' ? 'wifi' : 'lora';
  const wifi = communicationMode === 'wifi';
  $('#wifiMode').setAttribute('aria-pressed', String(wifi));
  $('#loraMode').setAttribute('aria-pressed', String(!wifi));
  $('#connectionModeBadge').textContent = wifi ? status.ethernet_connected && !status.wifi_connected ? 'Local network selected' : 'Wi-Fi selected' : 'LoRa selected';
  $('#connectionStatus').textContent = wifi
    ? status.wifi_connected
      ? `Wi-Fi connected${status.lan_ip ? ` · Kiosk address: ${status.lan_ip}` : ''}. Phone access is ready on this network.`
      : status.ethernet_connected
        ? `The kiosk is connected by Ethernet${status.lan_ip ? ` · Kiosk address: ${status.lan_ip}` : ''}. A phone on this router's Wi-Fi can use the local link.`
      : status.active_link === 'lora'
        ? 'Wi-Fi is disconnected; the system is using the connected LoRa link.'
        : status.wifi_adapter_available === false
          ? 'No Wi-Fi adapter was detected and Ethernet is not connected. Add a Wi-Fi adapter or connect the kiosk to the router with Ethernet.'
          : 'Wi-Fi is selected but not connected. Choose a detected network below and enter its password.'
    : status.lora_connected
      ? 'LoRa is selected and the radio link is connected.'
      : 'LoRa is selected, but the radio is unavailable. No communication link is active.';
  $('#connectionHelp').textContent = wifi
    ? status.ethernet_connected
      ? 'The kiosk can use its Ethernet connection to the router while the phone uses Wi-Fi from that same router. Open the phone address below. Scanning Wi-Fi networks requires a Wi-Fi adapter.'
      : 'Scan for a network and enter its password to connect this kiosk. Then join the phone to the same Wi-Fi and open the address below. Local alerts and records work without internet.'
    : status.phone_url
      ? 'SOS alerts can use the LoRa bridge, and a phone on the kiosk’s local network can also read them from the phone inbox.'
      : 'Both endpoints need LoRa radios for remote radio delivery. Point B also needs a gateway or controller to pass messages to the phone.';
  $('#wifiSetup').hidden = !wifi || status.wifi_adapter_available === false;
  const phoneAccess = $('#phoneAccess');
  phoneAccess.hidden = !status.phone_url;
  if (status.phone_url) {
    $('#phoneAccessLink').href = status.phone_url;
    $('#phoneAccessLink').textContent = status.phone_url;
  }
}
async function loadConnectivity() {
  const [data, status] = await Promise.all([api('/api/owner/connectivity'), api('/api/connectivity/status')]);
  demoLiveEnergy = status.energy_meter_detected && Number.isFinite(Number(status.energy_kwh)) ? Number(status.energy_kwh) : null;
  renderConnectivity(data.mode, status);
  if (demoActive) renderFinancials();
  if (data.mode === 'wifi' && status.wifi_adapter_available) await scanWifiNetworks();
}
async function refreshConnectivityStatus() {
  try {
    const status = await api('/api/connectivity/status');
    demoLiveEnergy = status.energy_meter_detected && Number.isFinite(Number(status.energy_kwh)) ? Number(status.energy_kwh) : null;
    renderConnectivity(communicationMode, status);
    if (demoActive) renderFinancials();
  } catch (_) { /* Keep the last hardware status visible during a brief interruption. */ }
}
async function chooseConnectivity(mode) {
  $('#wifiMode').disabled = $('#loraMode').disabled = true;
  try {
    const data = await api('/api/owner/connectivity', { method: 'PUT', body: JSON.stringify({ mode }) });
    const status = await api('/api/connectivity/status');
    renderConnectivity(data.mode, status);
    toast(data.mode === 'wifi' ? 'Wi-Fi selected and saved on this kiosk.' : 'LoRa selected and saved on this kiosk.');
    if (data.mode === 'wifi' && status.wifi_adapter_available) await scanWifiNetworks();
  } catch (error) { toast(error.message); }
  finally { $('#wifiMode').disabled = $('#loraMode').disabled = false; }
}

async function scanWifiNetworks() {
  const button = $('#scanWifi');
  const status = $('#wifiSetupStatus');
  button.disabled = true;
  status.textContent = 'Scanning nearby Wi-Fi networks…';
  try {
    const data = await api('/api/owner/wifi/networks');
    const select = $('#wifiNetworks');
    select.replaceChildren();
    if (!data.networks.length) {
      select.add(new Option('No visible networks found', ''));
      status.textContent = 'No network was detected. Check the Wi-Fi adapter and scan again.';
      return;
    }
    select.add(new Option('Choose a Wi-Fi network', ''));
    data.networks.forEach(network => {
      const option = new Option(`${network.ssid} · ${network.signal}% · ${network.security}`, network.ssid);
      option.dataset.security = network.security;
      select.add(option);
    });
    status.textContent = `${data.networks.length} nearby network${data.networks.length === 1 ? '' : 's'} detected. The operating system keeps its Wi-Fi profile after connecting.`;
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
}

async function connectSelectedWifi() {
  const ssid = $('#wifiNetworks').value;
  const password = $('#wifiPassword').value;
  const security = $('#wifiNetworks').selectedOptions[0]?.dataset.security || 'Open';
  const status = $('#wifiSetupStatus');
  if (!ssid) { status.textContent = 'Choose a detected Wi-Fi network first.'; return; }
  if (security !== 'Open' && !password) { status.textContent = 'Enter the password for this Wi-Fi network.'; return; }
  const button = $('#connectWifi');
  button.disabled = true;
  status.textContent = `Connecting this kiosk to ${ssid}…`;
  try {
    const result = await api('/api/owner/wifi/connect', { method: 'POST', body: JSON.stringify({ ssid, password }) });
    $('#wifiPassword').value = '';
    status.textContent = result.message;
    toast('Wi-Fi connection started. Waiting for the network status to update.');
    setTimeout(refreshConnectivityStatus, 3000);
    setTimeout(refreshConnectivityStatus, 8000);
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
}
async function loadOwnerSessions() {
  if (demoActive) return;
  try {
    const data = await api(`/api/owner/sessions?period=${encodeURIComponent($('#period').value)}`);
    liveOwnerData = data;
    $('#ownerRows').innerHTML = data.sessions.length
      ? data.sessions.map(item => `<tr><td>${esc(item.name)}</td><td>${esc(item.locker)}</td><td>${peso(item.paid)}</td><td>${esc(item.minutes)} min</td><td>${esc(item.used)}</td><td>${item.energy == null ? 'Meter needed' : `${Number(item.energy).toFixed(3)} kWh`}</td><td>${esc(item.returned)}</td></tr>`).join('')
      : '<tr><td colspan="7" class="muted-cell">No completed sessions in this period.</td></tr>';
    $('#sessionEmptyNote').textContent = data.count ? `${data.count} completed session${data.count === 1 ? '' : 's'} · stored locally` : 'No completed sessions recorded for this period.';
    renderFinancials();
  } catch (error) { toast(error.message); }
}
async function loadFeedback() {
  try {
    const period = $('#period').value;
    const data = await api(`/api/owner/feedback?period=${encodeURIComponent(period)}`);
    $('#feedbackRows').innerHTML = data.feedback.length
      ? data.feedback.map(item => `<tr><td>${new Date(item.created_at).toLocaleString()}</td><td>${esc(item.locker)}</td><td aria-label="${item.rating} out of 5 stars">${'★'.repeat(item.rating)}${'☆'.repeat(5 - item.rating)}</td><td>${esc(item.comment || '')}</td></tr>`).join('')
      : '<tr><td colspan="4" class="muted-cell">No camper feedback for this period.</td></tr>';
    $('#feedbackTotal').textContent = String(data.total);
    $('#feedbackSatisfied').textContent = String(data.satisfied);
    $('#feedbackNeedsImprovement').textContent = String(data.needs_improvement);
    renderFeedbackChart(data.satisfied, data.needs_improvement, period);
  } catch (error) { toast(error.message); }
}
function renderFeedbackChart(satisfied, needsImprovement, period) {
  const total = satisfied + needsImprovement;
  const cx = 105, cy = 105, radius = 76;
  const point = angle => [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  const wedge = (value, start, color) => {
    if (!value || !total) return '';
    const end = start + (value / total) * Math.PI * 2;
    const [x1, y1] = point(start), [x2, y2] = point(end);
    const large = end - start > Math.PI ? 1 : 0;
    return `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z" fill="${color}" stroke="#0f2a3a" stroke-width="2"><title>${value} ${color === '#19a7a0' ? 'satisfied' : 'needs improvement'}</title></path>`;
  };
  const chart = total
    ? `${wedge(satisfied, -Math.PI / 2, '#19a7a0')}${wedge(needsImprovement, -Math.PI / 2 + satisfied / total * Math.PI * 2, '#ffbe2e')}`
    : `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="#e8efec" stroke="#0f2a3a" stroke-width="2"/>`;
  const description = `${period}: ${satisfied} satisfied responses and ${needsImprovement} responses needing improvement.`;
  $('#feedbackChart').innerHTML = `<svg class="feedback-pie" viewBox="0 0 430 210" role="img" aria-label="${description}"><title>${description}</title>${chart}<g transform="translate(220 62)"><circle cx="8" cy="8" r="8" fill="#19a7a0"/><text x="26" y="13">Satisfied · 4–5 stars · ${satisfied}</text><circle cx="8" cy="42" r="8" fill="#ffbe2e"/><text x="26" y="47">Needs improvement · 1–3 stars · ${needsImprovement}</text><text x="0" y="88" class="feedback-pie-total">${total} response${total === 1 ? '' : 's'} · ${period}</text></g></svg>`;
  $('#feedbackChartCaption').textContent = total
    ? 'Ratings of 4–5 stars count as satisfied; ratings of 1–3 stars count as needing improvement.'
    : `No camper feedback was submitted ${period.toLowerCase()}.`;
}
async function syncDemoState() {
  try {
    const status = await api('/api/demo/status');
    if (status.active) {
      const snapshot = await api('/api/owner/demo/sessions');
      renderDemo(true, snapshot);
      await loadFeedback();
    } else {
      renderDemo(false);
      await loadOwnerSessions();
      await loadFeedback();
    }
  } catch (_) { /* Leave the last known owner view in place during a brief connection issue. */ }
}

$('#demoToggle').addEventListener('click', async () => {
  const endpoint = demoActive ? '/api/owner/demo/stop' : '/api/owner/demo/start';
  try {
    const status = await api(endpoint, { method: 'POST' });
    renderDemo(status.active);
    toast(status.active ? 'Owner demo started. Temporary controls are available on the camper and staff screens.' : 'Owner demo stopped. Temporary demo controls are off.');
  } catch (error) { toast(error.message); }
});

$('#wifiMode').addEventListener('click', () => chooseConnectivity('wifi'));
$('#loraMode').addEventListener('click', () => chooseConnectivity('lora'));
$('#scanWifi').addEventListener('click', scanWifiNetworks);
$('#connectWifi').addEventListener('click', connectSelectedWifi);
$('#wifiNetworks').addEventListener('change', () => {
  const openNetwork = $('#wifiNetworks').selectedOptions[0]?.dataset.security === 'Open';
  $('#wifiPassword').disabled = openNetwork;
  $('#wifiPassword').placeholder = openNetwork ? 'No password needed for this network' : 'Enter the network password';
  if (openNetwork) $('#wifiPassword').value = '';
});

$('#saveCosts').addEventListener('click', () => {
  const cost = Math.max(0, Number($('#costInput').value) || 0);
  const period = $('#period').value;
  if (demoActive) demoCostOverrides[period] = cost;
  else localStorage.setItem(estimateKey(period), String(cost));
  renderFinancials();
  toast(demoActive ? 'Temporary demo estimate updated.' : 'Operating cost estimate saved for this browser.');
});
$('#period').addEventListener('change', () => { renderDemo(demoActive, demoSnapshot); renderFinancials(); loadOwnerSessions(); loadFeedback(); });

$('#exportOwnerReport').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/owner/reports/export', { method: 'POST' });
    if (!response.ok) {
      if (response.status === 401) location.href = '/login';
      throw Error('Could not create the report.');
    }
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const name = disposition.match(/filename="?([^";]+)"?/i)?.[1] || 'sessions.csv';
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    URL.revokeObjectURL(link.href);
    toast(demoActive ? 'Demo system report saved on the kiosk and downloaded.' : 'Saved session report exported from the kiosk database.');
    await loadReports();
  } catch (error) { toast(error.message); }
});

async function loadStaff() {
  const data = await api('/api/owner/staff');
  $('#staffRows').replaceChildren();
  if (!data.staff.length) {
    $('#staffRows').innerHTML = '<tr><td colspan="4" class="muted-cell">No staff accounts yet.</td></tr>';
    return;
  }
  for (const user of data.staff) {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${esc(user.username)}</td><td>${new Date(user.created_at).toLocaleDateString()}</td><td>${user.active ? 'Active' : 'Access removed'}</td><td>${user.active ? `<button data-remove="${user.id}" data-name="${esc(user.username)}">Remove access</button>` : '<span class="muted-cell">Disabled</span>'}</td>`;
    $('#staffRows').append(row);
  }
}
async function loadReports() {
  const data = await api('/api/owner/reports');
  $('#reportPolicy').textContent = `Automatic report retention: ${data.retention_days} days`;
  $('#reportRows').replaceChildren();
  if (!data.reports.length) {
    $('#reportRows').innerHTML = '<tr><td colspan="4" class="muted-cell">No saved report files found.</td></tr>';
    return;
  }
  for (const report of data.reports) {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${esc(report.name)}</td><td>${new Date(report.modified).toLocaleString()}</td><td>${(report.bytes / 1024).toFixed(1)} KB</td><td><button data-report="${encodeURIComponent(report.name)}">Delete file</button></td>`;
    $('#reportRows').append(row);
  }
}

$('#staffForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/owner/staff', { method: 'POST', body: JSON.stringify({ username: $('#staffUsername').value, password: $('#staffPassword').value }) });
    $('#staffForm').reset();
    toast('Staff account created.');
    await loadStaff();
  } catch (error) { toast(error.message); }
});
$('#staffRows').addEventListener('click', async event => {
  const button = event.target.closest('[data-remove]');
  if (!button) return;
  if (!confirm(`Remove dashboard access for ${button.dataset.name}? Their audit history will be kept.`)) return;
  try {
    await api(`/api/owner/staff/${button.dataset.remove}`, { method: 'DELETE' });
    toast('Staff access removed.');
    await loadStaff();
  } catch (error) { toast(error.message); }
});
$('#reportRows').addEventListener('click', async event => {
  const button = event.target.closest('[data-report]');
  if (!button) return;
  const filename = decodeURIComponent(button.dataset.report);
  if (!confirm(`Permanently delete ${filename}? This cannot be undone.`)) return;
  try {
    await api(`/api/owner/reports/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    toast('Report file deleted.');
    await loadReports();
  } catch (error) { toast(error.message); }
});
$('#refreshReports').addEventListener('click', () => loadReports().catch(error => toast(error.message)));
$('#refreshFeedback').addEventListener('click', () => loadFeedback());
$('#exportFeedback').addEventListener('click', () => {
  const period = encodeURIComponent($('#period').value);
  location.href = `/api/owner/feedback.csv?period=${period}`;
});
$('#logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/camper.html';
});
api('/api/me').then(user => { $('#ownerName').textContent = user.username; }).catch(() => { location.href = '/login'; });
loadConnectivity().catch(error => toast(error.message));
setInterval(refreshConnectivityStatus, 10000);
syncDemoState();
setInterval(syncDemoState, 2500);
loadStaff().catch(error => toast(error.message));
loadReports().catch(error => toast(error.message));
loadFeedback();
setInterval(loadFeedback, 30000);
