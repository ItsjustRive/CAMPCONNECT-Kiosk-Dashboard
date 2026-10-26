const $ = selector => document.querySelector(selector);
let demoMode = false;
let viewerRole = null;
let locker = null, session = null, pin = '', firstPin = '', pinStep = 'create';
let pickupPin = '', coins = 0, expiry = 0, chargeTimer = null, paymentTimer = null, paymentSeconds = 15;
let toastTimer;
let currentKioskLocation = null, currentTransport = null;
let feedbackRating = 0, feedbackContext = { sessionId: null, demoRecordId: null, locker: null }, feedbackShift = false;
let doorPollTimer = null;
const demoSessionStorageKey = 'campconnect-active-demo-session';

// The locker bridge may expose this adapter before camper.js loads.
function lockerHardware() {
  const hardware = window.kioskLockerHardware;
  return hardware?.detected === true
    && typeof hardware.openLocker === 'function'
    && typeof hardware.getDoorState === 'function' ? hardware : null;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
function updateKioskGps(data) {
  const fresh = data.gps_fix && Number.isFinite(Number(data.latitude)) && Number.isFinite(Number(data.longitude))
    && data.gps_updated_at && Date.now() - Date.parse(data.gps_updated_at) < 120000;
  currentKioskLocation = fresh ? {
    latitude: Number(data.latitude), longitude: Number(data.longitude), accuracy: data.gps_accuracy_m
  } : null;
  const gpsBadge = $('#gpsStatus');
  gpsBadge.className = `status ${fresh ? 'gps-fix' : 'neutral gps-no-fix'}`;
  gpsBadge.innerHTML = `<i></i> ${fresh ? `GPS fix${data.gps_accuracy_m == null ? '' : ` ±${Math.round(Number(data.gps_accuracy_m))} m`}` : 'GPS unavailable'}`;
  $('#sosLocationStatus').textContent = fresh
    ? `Kiosk GPS fix · ${Number(data.latitude).toFixed(5)}, ${Number(data.longitude).toFixed(5)}${data.gps_accuracy_m == null ? '' : ` · accuracy ±${Math.round(Number(data.gps_accuracy_m))} m`}`
    : 'Kiosk GPS unavailable · SOS can still include typed location details.';
}
async function refreshTransportStatus() {
  try {
    const response = await fetch('/api/connectivity/status', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    const activeLink = data.active_link;
    currentTransport = activeLink;
    $('#loraStatus').hidden = !activeLink;
    if (activeLink) {
      $('#loraStatus').className = 'status';
      $('#loraStatus').innerHTML = `<i></i> ${activeLink === 'wifi' ? 'Wi-Fi connected' : activeLink === 'lan' ? 'Ethernet LAN connected' : 'LoRa connected'}`;
    }
    const batteryAvailable = data.battery_detected && Number.isFinite(Number(data.battery_percent));
    $('#solarStatus').className = batteryAvailable ? 'status' : 'status neutral';
    $('#solarStatus').innerHTML = `<i class="battery"></i> ${batteryAvailable ? `Battery ${Math.round(Number(data.battery_percent))}%` : 'Battery unavailable'}`;
    updateKioskGps(data);
    if (viewerRole === 'owner' && demoMode) {
      $('#sosStatus').textContent = activeLink === 'lora'
        ? 'Demo SOS will be sent through the LoRa bridge and appear on the local phone inbox.'
        : activeLink || data.phone_url ? 'Demo SOS will appear on the local phone inbox.'
          : 'No phone or radio link is currently available.';
    } else {
      $('#sosStatus').textContent = activeLink
        ? activeLink === 'wifi'
          ? 'Wi-Fi is connected. SOS messages will appear on the staff phone page on this network.'
          : activeLink === 'lan'
            ? 'Ethernet is connected to the local network. Phones on this router can receive SOS messages over Wi-Fi.'
          : 'LoRa is connected. SOS can queue for the radio bridge; Point B phone delivery still needs the bridge and phone app.'
        : 'No communication link is connected. The SOS cannot be sent right now.';
    }
  } catch (_) { /* Keep the last shown connection status if the local service is briefly unavailable. */ }
}
async function syncDemoState() {
  if (viewerRole !== 'owner') {
    demoMode = false;
    return;
  }
  try {
    const response = await fetch('/api/demo/status', { cache: 'no-store' });
    if (!response.ok) return;
    const { active } = await response.json();
    if (demoMode && !active) {
      resetSession(false);
      locker = null;
      toast('Owner demo ended. The kiosk returned to normal mode.');
    }
    demoMode = Boolean(active);
    $('#systemDemoBanner').hidden = !demoMode;
    $('#demoCoinButtons').hidden = !demoMode;
    $('#coinHardwareStatus').textContent = demoMode ? 'Owner demo: simulated coin input' : 'Coin slot not connected';
    if (demoMode && !session) {
      const result = await demoApi('/api/owner/demo/sessions');
      await restoreDemoSession(result.sessions);
    }
    if (demoMode && session?.demoRecordId) {
      const result = await demoApi('/api/owner/demo/sessions');
      const record = result.sessions.find(item => item.id === session.demoRecordId);
      if (record?.status === 'Awaiting pickup' && session.status === 'charging') {
        clearInterval(chargeTimer);
        chargeTimer = null;
        session.status = 'pickup';
        renderLockerState('pickup');
        toast('Demo staff ended charging. The locker is waiting for pickup.');
      } else if (record?.status === 'Recovered' && session.status === 'pickup') {
        await openLockerDoor('pickup');
        toast('Staff recovery authorized the locker opening.');
      }
    }
    if (session?.status === 'charging') renderLockerState('charging');
  } catch (_) { /* Keep the regular kiosk view if the service is temporarily unavailable. */ }
}
async function demoApi(path, method = 'GET', payload = null) {
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    headers: payload ? { 'Content-Type': 'application/json' } : {},
    body: payload ? JSON.stringify(payload) : undefined
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(result.error || 'Demo update could not be saved.');
  return result;
}
async function restoreDemoSession(records) {
  const unfinished = (records || []).filter(record => record.status !== 'Completed');
  if (!unfinished.length) {
    sessionStorage.removeItem(demoSessionStorageKey);
    return;
  }
  const preferredId = sessionStorage.getItem(demoSessionStorageKey);
  const record = unfinished.find(item => item.id === preferredId)
    || [...unfinished].reverse().find(item => ['Charging', 'Awaiting pickup', 'Recovered', 'Locker open', 'Loading gear'].includes(item.status))
    || unfinished[unfinished.length - 1];
  locker = record.locker;
  const states = {
    'Waiting for payment': 'payment', 'Payment received': 'payment', 'Loading gear': 'loading-door',
    Charging: 'charging', 'Awaiting pickup': 'pickup', Recovered: 'pickup', 'Locker open': 'door'
  };
  session = { ...record, demo: true, demoRecordId: record.id, pin: '', status: states[record.status] || 'payment' };
  sessionStorage.setItem(demoSessionStorageKey, record.id);
  coins = Number(record.paid) || 0;
  if (record.status === 'Charging') startCharging(true);
  else if (record.status === 'Awaiting pickup') renderLockerState('pickup');
  else if (record.status === 'Recovered') await openLockerDoor('pickup');
  else if (record.status === 'Locker open' || record.status === 'Loading gear') renderLockerState('door');
  else {
    $('#coinTotal').textContent = `₱${coins}`;
    updatePayment();
    open('paymentDialog');
  }
}
function saveDemoSession(updates) {
  if (viewerRole !== 'owner' || !demoMode || !session?.demoRecordId) return;
  return demoApi(`/api/owner/demo/sessions/${encodeURIComponent(session.demoRecordId)}`, 'PATCH', updates).catch(() => {});
}
function savePersistentSession(updates) {
  if (!session?.storageId || session.demo) return Promise.resolve(null);
  const pending = fetch(`/api/sessions/${encodeURIComponent(session.storageId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates)
  });
  pending.catch(() => {});
  return pending;
}
function open(id) { document.getElementById(id).showModal(); }
function drawDots(hostId, value) {
  const host = document.getElementById(hostId);
  host.replaceChildren();
  for (let i = 0; i < 6; i++) {
    const dot = document.createElement('span');
    dot.className = `dot ${i < value.length ? 'full' : ''}`;
    host.append(dot);
  }
}
function buildNameKeys() {
  const host = $('#nameKeyboard');
  ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'].forEach((letters, rowIndex) => {
    const row = document.createElement('div');
    row.className = 'key-row';
    if (rowIndex === 2) addNameKey(row, 'Clear', 'clear');
    [...letters].forEach(letter => addNameKey(row, letter, 'letter'));
    if (rowIndex === 2) addNameKey(row, '⌫', 'back');
    host.append(row);
  });
  const row = document.createElement('div');
  row.className = 'key-row';
  addNameKey(row, 'Space', 'space');
  host.append(row);
}
function addNameKey(row, label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `key ${['clear', 'back'].includes(action) ? 'wide' : ''} ${action === 'space' ? 'space' : ''}`;
  button.textContent = label;
  button.addEventListener('click', () => {
    let value = $('#camperName').value;
    if (action === 'letter' && value.length < 40) value += label;
    if (action === 'space' && value && value.length < 40 && !value.endsWith(' ')) value += ' ';
    if (action === 'clear') value = '';
    if (action === 'back') value = value.slice(0, -1);
    $('#camperName').value = value;
    $('#nameError').textContent = '';
  });
  row.append(button);
}
function buildPinPad(hostId, callback) {
  const host = document.getElementById(hostId);
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'].forEach(key => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `digit ${['clear', 'back'].includes(key) ? 'utility' : ''}`;
    button.textContent = key === 'clear' ? 'Clear' : key === 'back' ? '⌫' : key;
    button.addEventListener('click', () => callback(key));
    host.append(button);
  });
}
function editCreatePin(key) {
  $('#pinError').textContent = '';
  if (key === 'clear') pin = '';
  else if (key === 'back') pin = pin.slice(0, -1);
  else if (pin.length < 6) pin += key;
  drawDots('pinDots', pin);
  $('#pinNext').disabled = pin.length !== 6;
}
function editPickupPin(key) {
  $('#pickupError').textContent = '';
  if (key === 'clear') pickupPin = '';
  else if (key === 'back') pickupPin = pickupPin.slice(0, -1);
  else if (pickupPin.length < 6) pickupPin += key;
  drawDots('pickupDots', pickupPin);
  $('#unlock').disabled = pickupPin.length !== 6;
}
function setLockerAvailable(id) {
  const card = document.querySelector(`[data-locker="${id}"]`);
  if (!card) return;
  card.className = 'locker available';
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  card.innerHTML = `<div class="card-head"><b>LOCKER ${id}</b><span class="badge open-badge">AVAILABLE</span></div><div class="locker-icon">▤</div><h3>Ready for your gear</h3><p>Tap to start a locker session</p><small>SELECT LOCKER →</small>`;
}
function updateAvailableCount() {
  const count = document.querySelectorAll('.locker.available').length;
  $('#availableCount').textContent = `${count} locker${count === 1 ? '' : 's'} available`;
}
function resetSession(reopenName = false) {
  clearInterval(paymentTimer);
  clearInterval(chargeTimer);
  clearInterval(doorPollTimer);
  doorPollTimer = null;
  paymentTimer = chargeTimer = null;
  for (const id of ['nameDialog', 'pinDialog', 'paymentDialog', 'pickupDialog']) {
    const dialog = document.getElementById(id);
    if (dialog.open) dialog.close();
  }
  const oldLocker = locker;
  const oldSession = session;
  if (oldSession?.demoRecordId && sessionStorage.getItem(demoSessionStorageKey) === oldSession.demoRecordId) {
    sessionStorage.removeItem(demoSessionStorageKey);
  }
  if (oldSession?.demoRecordId && oldSession.status !== 'completed') {
    demoApi(`/api/owner/demo/sessions/${encodeURIComponent(oldSession.demoRecordId)}`, 'DELETE').catch(() => {});
  }
  if (oldSession?.storageId && ['payment', 'pin-setup'].includes(oldSession.status)) {
    fetch(`/api/sessions/${encodeURIComponent(oldSession.storageId)}`, { method: 'DELETE' }).catch(() => {});
  }
  session = null;
  pin = firstPin = pickupPin = '';
  coins = 0;
  if (oldLocker) setLockerAvailable(oldLocker);
  updateAvailableCount();
  if (reopenName && oldLocker) {
    $('#camperName').value = '';
    $('#nameError').textContent = '';
    setTimeout(() => open('nameDialog'), 180);
  } else locker = null;
}
function renderLockerState(state) {
  const card = document.querySelector(`[data-locker="${locker}"]`);
  if (!card) return;
  if (state === 'charging') {
    card.className = 'locker busy';
    const canControlDemo = demoMode && viewerRole === 'owner';
    card.innerHTML = `<div class="card-head"><b>LOCKER ${locker}</b><span class="badge busy-badge">IN USE</span></div><div class="locker-icon">▣</div><h3>Charging your device</h3><p>The locker remains closed</p><small id="remaining">Time remaining</small>${canControlDemo ? '<button class="tiny-demo" id="endDemoCharge" type="button">Bypass demo timer · stop charging</button>' : ''}`;
    if (canControlDemo) $('#endDemoCharge').addEventListener('click', stopCharging);
  } else if (state === 'pickup') {
    card.className = 'locker busy pickup';
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.innerHTML = `<div class="card-head"><b>LOCKER ${locker}</b><span class="badge busy-badge">READY FOR PICKUP</span></div><div class="locker-icon">▣</div><h3>Charging stopped</h3><p>Your items are still locked</p><small>Tap to enter your PIN</small>`;
  } else if (state === 'door') {
    card.className = 'locker busy';
    card.removeAttribute('role');
    card.removeAttribute('tabindex');
    const hasHardware = Boolean(lockerHardware());
    const initialLoad = session?.status === 'loading-door';
    card.innerHTML = `<div class="card-head"><b>LOCKER ${locker}</b><span class="badge open-badge">${initialLoad ? 'READY TO LOAD' : 'UNLOCKED'}</span></div><div class="locker-icon">▤</div><h3>${initialLoad ? 'Place your belongings inside' : 'Take your belongings'}</h3><p>${hasHardware ? 'Close the door to continue.' : 'Use the control below to simulate closing the door.'}</p>${hasHardware ? '<small>WAITING FOR DOOR SENSOR</small>' : `<button class="tiny-demo" id="finishDoor" type="button">${initialLoad ? 'Close door · start charging' : 'Close locker'}</button>`}`;
    if (hasHardware) monitorDoorClosure();
    else $('#finishDoor').addEventListener('click', initialLoad ? () => startCharging() : () => finishPickup());
  } else if (state === 'opening-door') {
    card.className = 'locker busy';
    card.removeAttribute('role');
    card.removeAttribute('tabindex');
    card.innerHTML = `<div class="card-head"><b>LOCKER ${locker}</b><span class="badge busy-badge">OPENING</span></div><div class="locker-icon">▣</div><h3>Opening locker</h3><p>Please wait for the door sensor.</p>`;
  }
  updateAvailableCount();
}
async function openLockerDoor(purpose) {
  const loading = purpose === 'load';
  session.status = loading ? 'loading-door' : 'opening-pickup-door';
  const hardware = lockerHardware();
  if (!hardware) {
    session.status = loading ? 'loading-door' : 'door';
    if (session.demoRecordId) saveDemoSession({ status: loading ? 'Loading gear' : 'Locker open' });
    renderLockerState('door');
    return;
  }
  renderLockerState('opening-door');
  try {
    await hardware.openLocker(String(locker));
    session.status = loading ? 'loading-door' : 'door';
    if (session.demoRecordId) saveDemoSession({ status: loading ? 'Loading gear' : 'Locker open' });
    renderLockerState('door');
  } catch (error) {
    session.status = loading ? 'loading-door' : 'pickup';
    if (loading) renderLockerState('door');
    else {
      renderLockerState('pickup');
      $('#pickupError').textContent = 'The locker could not be opened. Please try again or contact staff.';
      open('pickupDialog');
    }
    toast(error?.message || 'The locker could not be opened. Please contact staff.');
  }
}
function monitorDoorClosure() {
  clearInterval(doorPollTimer);
  const hardware = lockerHardware();
  if (!hardware) return;
  let sawOpenDoor = false;
  doorPollTimer = setInterval(async () => {
    if (!session || !['loading-door', 'door'].includes(session.status)) {
      clearInterval(doorPollTimer);
      doorPollTimer = null;
      return;
    }
    try {
      const doorState = await hardware.getDoorState(String(locker));
      if (doorState === 'open') {
        sawOpenDoor = true;
        return;
      }
      if (doorState !== 'closed' || !sawOpenDoor) return;
      clearInterval(doorPollTimer);
      doorPollTimer = null;
      if (session.status === 'loading-door') startCharging();
      else finishPickup();
    } catch (_) { /* Wait for another sensor reading. */ }
  }, 500);
}
async function finishPickup() {
  if (!session || session.status !== 'door') return;
  clearInterval(doorPollTimer);
  doorPollTimer = null;
  const finishedLocker = locker;
  const finished = { sessionId: session.storageId || null, demoRecordId: session.demoRecordId || null };
  if (session.demoRecordId) {
    session.status = 'completed';
    const usedMinutes = Math.max(1, Math.ceil((Date.now() - session.started) / 60000));
    await saveDemoSession({ status: 'Completed', used: `${usedMinutes} min` });
  }
  if (session.storageId) {
    session.status = 'completed';
    const usedMinutes = Math.max(1, Math.ceil((Date.now() - session.started) / 60000));
    await savePersistentSession({ status: 'Completed', usedMinutes }).catch(() => null);
  }
  resetSession(false);
  locker = null;
  toast('Locker closed. The kiosk is ready for the next camper.');
  showFeedback({ ...finished, locker: finishedLocker });
}
function startPaymentTimer() {
  clearInterval(paymentTimer);
  paymentSeconds = 15;
  updatePayment();
  paymentTimer = setInterval(() => {
    if (coins > 0) { clearInterval(paymentTimer); paymentTimer = null; return; }
    paymentSeconds -= 1;
    if (paymentSeconds <= 0) {
      clearInterval(paymentTimer);
      paymentTimer = null;
      resetSession(true);
      setTimeout(() => { $('#nameError').textContent = 'No coin was detected. Enter your name to try again.'; }, 220);
      return;
    }
    $('#paymentStatus').textContent = `Waiting for a coin… ${paymentSeconds} seconds`;
  }, 1000);
}
function chargingMinutes(total) {
  return Number.isInteger(total) && total >= 10 && total <= 100 && total % 10 === 0
    ? (total / 10) * 30
    : 0;
}
function updatePayment() {
  const minutes = chargingMinutes(coins);
  $('#coinTotal').textContent = `₱${coins}`;
  const nextTotal = coins + 5;
  const nextMinutes = chargingMinutes(nextTotal);
  $('#chargeTime').textContent = minutes
    ? `Charging time: ${minutes} minutes`
    : coins > 0 && nextMinutes
      ? `${nextMinutes} minutes after ₱${nextTotal} total`
      : 'Charging time: 0 minutes';
  $('#continuePin').disabled = !minutes;
  if (coins >= 100) {
    $('#paymentStatus').textContent = `Maximum ₱100 received. Continue to create your PIN for ${minutes} minutes.`;
  } else if (minutes) {
    $('#paymentStatus').textContent = `₱${coins} accepted for ${minutes} minutes. Insert more coins for longer charging, or continue to create your PIN.`;
  } else if (coins > 0) {
    $('#paymentStatus').textContent = `Insufficient payment. Insert ₱5 more to reach ₱${nextTotal} before continuing.`;
  } else {
    $('#paymentStatus').textContent = `Waiting for a coin… ${paymentSeconds} seconds`;
  }
}
function acceptCoin(amount) {
  if (!session || session.status !== 'payment' || ![5, 10, 20].includes(Number(amount))) return false;
  amount = Number(amount);
  if (coins + amount > 100) {
    $('#paymentStatus').textContent = coins < 100
      ? `Maximum payment is ₱100. Add no more than ₱${100 - coins}, or continue if your total is accepted.`
      : 'Maximum ₱100 received. Continue to create your PIN.';
    return false;
  }
  coins += amount;
  clearInterval(paymentTimer);
  paymentTimer = null;
  updatePayment();
  const paymentUpdate = { paid: coins, minutes: chargingMinutes(coins), status: chargingMinutes(coins) ? 'Payment received' : 'Waiting for payment' };
  saveDemoSession({ ...paymentUpdate, used: '0 min' });
  savePersistentSession(paymentUpdate);
  return true;
}
// The GPIO coin-slot adapter can call this when a coin pulse is detected.
window.acceptKioskCoin = acceptCoin;
function beginPinSetup() {
  if (!chargingMinutes(coins)) return;
  clearInterval(paymentTimer);
  paymentTimer = null;
  pin = firstPin = '';
  pinStep = 'create';
  session.status = 'pin-setup';
  $('#pinError').textContent = '';
  $('#pinTitle').textContent = 'Create your 6-digit PIN';
  $('#pinText').textContent = 'You will need this PIN to open the locker after charging finishes.';
  drawDots('pinDots', '');
  $('#pinNext').disabled = true;
  $('#paymentDialog').close();
  open('pinDialog');
}
async function startCharging(resumeDemo = false) {
  resumeDemo = resumeDemo === true;
  const minutes = chargingMinutes(coins);
  session.paid = coins;
  if (resumeDemo) {
    const savedStart = session.started_at ? Date.parse(session.started_at) : NaN;
    const savedUsed = Number.parseInt(String(session.used || '0'), 10) || 0;
    session.started = Number.isFinite(savedStart) ? savedStart : Date.now() - savedUsed * 60000;
    session.lastReportedUsed = Math.max(savedUsed, Math.floor((Date.now() - session.started) / 60000));
  } else {
    session.started = Date.now();
    session.lastReportedUsed = 0;
  }
  session.status = 'charging';
  if (!resumeDemo) {
    // Persist the door-closed transition before leaving the loading-door step.
    // Otherwise a quick dashboard switch can restore the older "Loading gear" state.
    if (session.demoRecordId) {
      try {
        await demoApi(`/api/owner/demo/sessions/${encodeURIComponent(session.demoRecordId)}`, 'PATCH', {
          status: 'Charging', paid: session.paid, minutes, used: '0 min'
        });
      } catch (error) {
        toast(error?.message || 'Charging started, but the demo session could not be saved.');
      }
    }
    savePersistentSession({ status: 'Charging', paid: session.paid, minutes, usedMinutes: 0 });
  }
  expiry = session.started + minutes * 60 * 1000;
  renderLockerState('charging');
  if (expiry <= Date.now()) { stopCharging(); return; }
  chargeTimer = setInterval(() => {
    const left = Math.max(0, expiry - Date.now());
    const usedMinutes = Math.floor((Date.now() - session.started) / 60000);
    if (usedMinutes > session.lastReportedUsed) {
      session.lastReportedUsed = usedMinutes;
      saveDemoSession({ used: `${usedMinutes} min` });
    savePersistentSession({ usedMinutes });
    }
    const remaining = $('#remaining');
    if (remaining) {
      const mins = Math.floor(left / 60000);
      const secs = Math.ceil((left % 60000) / 1000);
      remaining.textContent = `${mins}:${String(secs).padStart(2, '0')} remaining`;
    }
    if (left <= 0) stopCharging();
  }, 500);
  toast(`Charging started for ${minutes} minutes. The locker stays locked.`);
}
function stopCharging() {
  if (!session || session.status !== 'charging') return;
  clearInterval(chargeTimer);
  chargeTimer = null;
  session.status = 'pickup';
  const usedMinutes = Math.max(1, Math.ceil((Date.now() - session.started) / 60000));
  saveDemoSession({ status: 'Awaiting pickup', used: `${usedMinutes} min` });
  savePersistentSession({ status: 'Awaiting pickup', usedMinutes });
  renderLockerState('pickup');
  toast('Charging stopped. The locker remains locked until the PIN is entered.');
}

document.querySelectorAll('[data-coin]').forEach(button => button.addEventListener('click', () => {
  if (viewerRole === 'owner' && demoMode) acceptCoin(Number(button.dataset.coin));
}));

$('#lockerGrid').addEventListener('click', event => {
  const card = event.target.closest('[data-locker]');
  if (!card) return;
  const id = card.dataset.locker;
  if (card.classList.contains('available')) {
    locker = id;
    $('#camperName').value = '';
    $('#nameError').textContent = '';
    open('nameDialog');
  } else if (session?.status === 'pickup' && session.locker === id) {
    pickupPin = '';
    drawDots('pickupDots', '');
    $('#pickupError').textContent = '';
    $('#unlock').disabled = true;
    $('#pickupTitle').textContent = `Open locker ${id}`;
    open('pickupDialog');
  } else if (session?.status === 'charging') {
    toast('Charging is active. The locker remains locked.');
  }
});
$('#lockerGrid').addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-locker][role="button"]')) {
    event.preventDefault();
    event.target.click();
  }
});

$('#nameForm').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('#camperName').value.trim();
  if (!name) { $('#nameError').textContent = 'Enter your name using the on-screen keyboard.'; return; }
  session = { locker, name, pin: '', status: 'payment', demo: demoMode && viewerRole === 'owner' };
  if (session.demo) {
    try {
      const result = await demoApi('/api/owner/demo/sessions', 'POST', { name, locker });
      session.demoRecordId = result.session.id;
      sessionStorage.setItem(demoSessionStorageKey, session.demoRecordId);
    } catch (error) {
      session.demo = false;
      demoMode = false;
      $('#systemDemoBanner').hidden = true;
      $('#demoCoinButtons').hidden = true;
      toast(error.message);
    }
  } else {
    try {
      const response = await fetch('/api/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, locker })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(result.error || 'Could not save this session on the kiosk.');
      session.storageId = result.id;
    } catch (error) {
      session = null;
      $('#nameError').textContent = error.message;
      return;
    }
  }
  $('#nameDialog').close();
  $('#paymentStatus').textContent = '';
  $('#continuePin').disabled = true;
  open('paymentDialog');
  startPaymentTimer();
});
$('#continuePin').addEventListener('click', beginPinSetup);
$('#pinNext').addEventListener('click', async () => {
  if (pin.length !== 6) return;
  if (pinStep === 'create') {
    firstPin = pin;
    pin = '';
    pinStep = 'confirm';
    $('#pinError').textContent = '';
    $('#pinTitle').textContent = 'Confirm your 6-digit PIN';
    $('#pinText').textContent = 'Enter the same six digits again.';
    drawDots('pinDots', '');
    $('#pinNext').disabled = true;
    return;
  }
  if (pin !== firstPin) {
    pin = '';
    drawDots('pinDots', '');
    $('#pinNext').disabled = true;
    $('#pinError').textContent = 'PINs did not match. Please enter your PIN again.';
    return;
  }
  if (session.demoRecordId) {
    try {
      await demoApi(`/api/owner/demo/sessions/${encodeURIComponent(session.demoRecordId)}/pin`, 'POST', { pin });
    } catch (error) {
      $('#pinError').textContent = error.message;
      return;
    }
  }
  session.pin = pin;
  $('#pinDialog').close();
  openLockerDoor('load');
});
$('#unlock').addEventListener('click', async () => {
  if (!session || pickupPin.length !== 6) return;
  let validPin = pickupPin === session.pin;
  if (session.demoRecordId && demoMode) {
    try {
      const result = await demoApi(`/api/owner/demo/sessions/${encodeURIComponent(session.demoRecordId)}/verify-pin`, 'POST', { pin: pickupPin });
      validPin = Boolean(result.valid);
    } catch (error) {
      $('#pickupError').textContent = error.message;
      return;
    }
  }
  if (!validPin) {
    pickupPin = '';
    drawDots('pickupDots', '');
    $('#unlock').disabled = true;
    $('#pickupError').textContent = 'Incorrect PIN. Please try again.';
    return;
  }
  session.status = 'door';
  $('#pickupDialog').close();
  openLockerDoor('pickup');
});

document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => {
  const dialog = button.closest('dialog');
  if (['nameDialog', 'pinDialog', 'paymentDialog'].includes(dialog.id)) resetSession(false);
  dialog.close();
}));
for (const id of ['nameDialog', 'pinDialog', 'paymentDialog']) {
  document.getElementById(id).addEventListener('cancel', () => resetSession(false));
}

$('#sosOpen').addEventListener('click', () => open('sosDialog'));
const sosDetails = $('#sosDetails');
const sosDetailsCounter = $('#sosDetailsCounter');
const sosKeyboard = $('#sosKeyboard');
const updateSosDetailsCounter = () => {
  const length = [...sosDetails.value].length;
  sosDetailsCounter.textContent = length >= 120
    ? `${length} / 120 characters · limit reached`
    : `${length} / 120 characters`;
  sosDetailsCounter.classList.toggle('limit-reached', length >= 120);
};
sosDetails.addEventListener('input', updateSosDetailsCounter);
updateSosDetailsCounter();
let sosShift = false;
const sosKeyboardRows = [
  [...'qwertyuiop'],
  [...'asdfghjkl'],
  [['shift', 'Shift'], ...'zxcvbnm'.split(''), ['backspace', '⌫']],
  [['clear', 'Clear'], ['space', 'Space'], ['.', '.'], [',', ','], ['done', 'Done']]
];
sosKeyboardRows.forEach(keys => {
  const row = document.createElement('div');
  row.className = 'key-row';
  keys.forEach(key => {
    const [value, label] = Array.isArray(key) ? key : [key, key];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `key text-key${['shift', 'backspace', 'clear', 'space', 'done'].includes(value) ? ` text-key-${value}` : ''}`;
    button.dataset.key = value;
    button.textContent = label;
    if (value === 'shift') button.setAttribute('aria-pressed', 'false');
    row.append(button);
  });
  sosKeyboard.append(row);
});
const setSosKeyboardOpen = isOpen => {
  sosKeyboard.hidden = !isOpen;
};
sosDetails.addEventListener('click', () => setSosKeyboardOpen(true));
sosDetails.addEventListener('focus', () => setSosKeyboardOpen(true));
$('#sosDialog').addEventListener('close', () => setSosKeyboardOpen(false));
sosKeyboard.addEventListener('click', event => {
  const button = event.target.closest('button[data-key]');
  if (!button) return;
  const key = button.dataset.key;
  if (key === 'done') { setSosKeyboardOpen(false); return; }
  if (key === 'shift') {
    sosShift = !sosShift;
    button.setAttribute('aria-pressed', String(sosShift));
    button.textContent = sosShift ? 'Shift on' : 'Shift';
    return;
  }
  if (key === 'clear') sosDetails.value = '';
  else if (key === 'backspace') sosDetails.value = [...sosDetails.value].slice(0, -1).join('');
  else {
    const character = key === 'space' ? ' ' : key;
    if ([...sosDetails.value].length >= 120) return;
    sosDetails.value += sosShift && /^[a-z]$/.test(character) ? character.toUpperCase() : character;
    if (sosShift && /^[a-z]$/.test(character)) {
      sosShift = false;
      const shiftButton = sosKeyboard.querySelector('[data-key="shift"]');
      shiftButton.setAttribute('aria-pressed', 'false');
      shiftButton.textContent = 'Shift';
    }
  }
  sosDetails.dispatchEvent(new Event('input', { bubbles: true }));
});
$('#sosForm').addEventListener('submit', async event => {
  event.preventDefault();
  if ([...sosDetails.value].length > 120) {
    $('#sosStatus').textContent = 'Please keep the details to 120 characters or fewer.';
    return;
  }
  const sendButton = $('#sendSos');
  sendButton.disabled = true;
  $('#sosStatus').textContent = currentTransport === 'lora'
    ? 'Queueing SOS for the LoRa bridge…'
    : 'Sending emergency message over the local network…';
  try {
    const form = new FormData(event.currentTarget);
    const response = await fetch('/api/emergency', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: form.get('type'), details: sosDetails.value.trim(),
        latitude: currentKioskLocation?.latitude ?? null,
        longitude: currentKioskLocation?.longitude ?? null,
        gps_accuracy_m: currentKioskLocation?.accuracy ?? null
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'The emergency message could not be sent.');
    $('#sosDialog').close();
    event.currentTarget.reset();
    updateSosDetailsCounter();
    toast(result.queued
      ? `SOS ${result.demo ? 'demo ' : ''}alert is queued for LoRa; the phone inbox also shows it locally.`
      : `Emergency message ${result.demo ? 'demo ' : ''}sent to the local phone inbox.`);
  } catch (error) {
    $('#sosStatus').textContent = error.message;
  } finally {
    sendButton.disabled = false;
  }
});

const feedbackDialog = $('#feedbackDialog');
const feedbackForm = $('#feedbackForm');
const feedbackComment = $('#feedbackComment');
const feedbackKeyboard = $('#feedbackKeyboard');
const feedbackCounter = $('#feedbackCounter');
const updateFeedbackCounter = () => {
  const length = [...feedbackComment.value].length;
  feedbackCounter.textContent = `${length} / 100 characters`;
  feedbackCounter.classList.toggle('limit-reached', length >= 100);
};
const feedbackKeyboardRows = [
  [...'qwertyuiop'],
  [...'asdfghjkl'],
  [['shift', 'Shift'], ...'zxcvbnm'.split(''), ['backspace', '⌫']],
  [['clear', 'Clear'], ['space', 'Space'], ['.', '.'], [',', ','], ['done', 'Done']]
];
feedbackKeyboardRows.forEach(keys => {
  const row = document.createElement('div');
  row.className = 'key-row';
  keys.forEach(key => {
    const [value, label] = Array.isArray(key) ? key : [key, key];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `key text-key${['shift', 'backspace', 'clear', 'space', 'done'].includes(value) ? ` text-key-${value}` : ''}`;
    button.dataset.key = value;
    button.textContent = label;
    if (value === 'shift') button.setAttribute('aria-pressed', 'false');
    row.append(button);
  });
  feedbackKeyboard.append(row);
});
function showFeedback(context) {
  feedbackContext = context;
  feedbackRating = 0;
  feedbackShift = false;
  feedbackComment.value = '';
  $('#feedbackError').textContent = '';
  $('#feedbackRatingLabel').textContent = 'Tap a star rating';
  $('#submitFeedback').disabled = true;
  $('#submitFeedback').textContent = 'Submit feedback';
  feedbackKeyboard.hidden = true;
  feedbackKeyboard.querySelectorAll('[data-key="shift"]').forEach(button => {
    button.textContent = 'Shift';
    button.setAttribute('aria-pressed', 'false');
  });
  renderFeedbackStars();
  updateFeedbackCounter();
  feedbackDialog.showModal();
}
function renderFeedbackStars() {
  $('#feedbackStars').querySelectorAll('[data-rating]').forEach(button => {
    const value = Number(button.dataset.rating);
    button.classList.toggle('selected', value <= feedbackRating);
    button.setAttribute('aria-pressed', String(value === feedbackRating));
  });
}
function closeFeedback() {
  if (feedbackDialog.open) feedbackDialog.close();
}
$('#feedbackStars').addEventListener('click', event => {
  const button = event.target.closest('[data-rating]');
  if (!button) return;
  feedbackRating = Number(button.dataset.rating);
  $('#feedbackRatingLabel').textContent = `${feedbackRating} out of 5 stars`;
  $('#submitFeedback').disabled = false;
  renderFeedbackStars();
});
feedbackComment.addEventListener('click', () => { feedbackKeyboard.hidden = false; });
feedbackComment.addEventListener('focus', () => { feedbackKeyboard.hidden = false; });
feedbackComment.addEventListener('input', updateFeedbackCounter);
feedbackDialog.addEventListener('close', () => {
  feedbackKeyboard.hidden = true;
  if (feedbackContext.locker) setLockerAvailable(feedbackContext.locker);
  updateAvailableCount();
  feedbackForm.reset();
  feedbackContext = { sessionId: null, demoRecordId: null, locker: null };
  feedbackRating = 0;
  renderFeedbackStars();
  updateFeedbackCounter();
});
feedbackKeyboard.addEventListener('click', event => {
  const button = event.target.closest('button[data-key]');
  if (!button) return;
  const key = button.dataset.key;
  if (key === 'done') { feedbackKeyboard.hidden = true; return; }
  if (key === 'shift') {
    feedbackShift = !feedbackShift;
    button.setAttribute('aria-pressed', String(feedbackShift));
    button.textContent = feedbackShift ? 'Shift on' : 'Shift';
    return;
  }
  if (key === 'clear') feedbackComment.value = '';
  else if (key === 'backspace') feedbackComment.value = [...feedbackComment.value].slice(0, -1).join('');
  else if ([...feedbackComment.value].length < 100) {
    const character = key === 'space' ? ' ' : key;
    feedbackComment.value += feedbackShift && /^[a-z]$/.test(character) ? character.toUpperCase() : character;
    if (feedbackShift && /^[a-z]$/.test(character)) {
      feedbackShift = false;
      const shiftButton = feedbackKeyboard.querySelector('[data-key="shift"]');
      shiftButton.setAttribute('aria-pressed', 'false');
      shiftButton.textContent = 'Shift';
    }
  }
  feedbackComment.dispatchEvent(new Event('input', { bubbles: true }));
});
$('#skipFeedback').addEventListener('click', () => {
  closeFeedback();
  toast('Ready for the next camper. Tap any available locker to begin.');
});
$('#closeFeedback').addEventListener('click', () => {
  closeFeedback();
  toast('Ready for the next camper. Tap any available locker to begin.');
});
feedbackDialog.addEventListener('cancel', event => { event.preventDefault(); closeFeedback(); });
feedbackForm.addEventListener('submit', async event => {
  event.preventDefault();
  const comment = [...feedbackComment.value].slice(0, 100).join('').trim();
  if (feedbackRating < 1 || feedbackRating > 5) {
    $('#feedbackError').textContent = 'Tap a star rating, or skip feedback.';
    return;
  }
  const submitButton = $('#submitFeedback');
  submitButton.disabled = true;
  submitButton.textContent = 'Saving…';
  $('#feedbackError').textContent = '';
  try {
    if (feedbackContext.demoRecordId && viewerRole === 'owner' && demoMode) {
      await demoApi(`/api/owner/demo/sessions/${encodeURIComponent(feedbackContext.demoRecordId)}`, 'PATCH', { rating: feedbackRating, feedback: comment });
      closeFeedback();
      toast('Demo feedback recorded temporarily. Ready for the next camper.');
    } else {
      const response = await fetch('/api/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: feedbackContext.sessionId, rating: feedbackRating, comment })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not save your feedback.');
      closeFeedback();
      toast('Thank you. Your feedback was saved. Ready for the next camper.');
    }
  } catch (error) {
    $('#feedbackError').textContent = error.message;
    submitButton.disabled = false;
    submitButton.textContent = 'Submit feedback';
  }
});

buildNameKeys();
buildPinPad('pinKeys', editCreatePin);
buildPinPad('pickupKeys', editPickupPin);
updateAvailableCount();
const setClock = () => $('#clock').textContent = `Local time · ${new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(new Date())}`;
setClock();
setInterval(setClock, 30000);

const accountAction = $('#accountAction');
const dashboardReturn = $('#dashboardReturn');
fetch('/api/me').then(response => {
  if (!response.ok) throw new Error('Signed out');
  return response.json();
}).then(user => {
  accountAction.textContent = 'Sign out';
  accountAction.href = '#';
  accountAction.addEventListener('click', async event => {
    event.preventDefault();
    await fetch('/api/logout', { method: 'POST' });
    location.reload();
  });
  dashboardReturn.hidden = false;
  dashboardReturn.href = user.role === 'owner' ? '/owner.html' : '/staff.html';
  dashboardReturn.textContent = `Return to ${user.role === 'owner' ? 'owner' : 'staff'} dashboard`;
  viewerRole = user.role;
  if (viewerRole === 'owner') {
    syncDemoState();
    setInterval(syncDemoState, 2000);
  }
  if (session?.status === 'charging') renderLockerState('charging');
}).catch(() => {});
refreshTransportStatus();
setInterval(refreshTransportStatus, 10000);
