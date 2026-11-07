const $ = selector => document.querySelector(selector);
let demoMode = false;
let viewerRole = null;
let locker = null, session = null, pickupTarget = null, pin = '', firstPin = '', pinStep = 'create';
let pickupPin = '', coins = 0, chargeTimer = null, paymentTimer = null, paymentSeconds = 15;
const chargeTimers = new Map();
const lockerSessions = new Map();
let toastTimer;
let currentKioskLocation = null, currentTransport = null;
let feedbackRating = 0, feedbackContext = { sessionId: null, demoRecordId: null, locker: null }, feedbackShift = false;
const doorPollTimers = new Map();
let demoSyncInFlight = false;
let lockerStateHydrated = false;
let responderPopupKey = null, responderPopupTimer = null, camperReplyAlertId = null, camperReplyShift = false;
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
function rescueDistance(aLat, aLon, bLat, bLon) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  const meters = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return meters < 1000 ? `About ${Math.round(meters)} m` : `About ${(meters / 1000).toFixed(2)} km`;
}
function showRescueMessage(message) {
  const popup = $('#rescuePopup');
  $('#rescuePopupText').textContent = message;
  popup.hidden = false;
  clearTimeout(responderPopupTimer);
  responderPopupTimer = setTimeout(() => { popup.hidden = true; }, 10000);
}
function renderLiveRescue(data) {
  const panel = $('#liveRescue');
  const alert = data.active_sos;
  panel.hidden = !alert;
  if (!alert) return;
  $('#liveRescueTitle').textContent = alert.alert_type || 'Emergency response';
  $('#liveRescueState').textContent = alert.status || 'SOS active';
  $('#liveRescueDetails').textContent = alert.details || 'No additional details provided.';
  const name = alert.responder_username || (data.responder_alert_id === alert.id ? data.responder_username : null);
  const role = alert.responder_role || (data.responder_alert_id === alert.id ? data.responder_role : null);
  $('#liveRescueResponder').textContent = name ? `${name}${role ? ` · ${role === 'owner' ? 'Owner' : 'Staff'}` : ''}` : role ? `${role === 'owner' ? 'Owner' : 'Staff'} responding` : alert.status === 'Responder en route' ? 'Responder en route' : 'Waiting for response';
  const matchingTelemetry = data.responder_alert_id === alert.id;
  const bLat = alert.responder_latitude ?? (matchingTelemetry ? data.responder_latitude : null);
  const bLon = alert.responder_longitude ?? (matchingTelemetry ? data.responder_longitude : null);
  const updatedAt = alert.responder_location_at || (matchingTelemetry ? data.responder_updated_at : null);
  const fresh = updatedAt && Date.now() - Date.parse(updatedAt) < 120000;
  const validB = fresh && Number.isFinite(Number(bLat)) && Number.isFinite(Number(bLon));
  $('#liveRescueLocation').textContent = validB
    ? `${Number(bLat).toFixed(5)}, ${Number(bLon).toFixed(5)}${(alert.responder_accuracy_m ?? data.responder_accuracy_m) == null ? '' : ` · ±${Math.round(Number(alert.responder_accuracy_m ?? data.responder_accuracy_m))} m`}`
    : updatedAt ? 'Responder GPS fix is stale' : 'Waiting for LoRa GPS';
  $('#liveRescueUpdated').textContent = validB ? `Updated ${new Date(updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
  const aLat = alert.latitude ?? currentKioskLocation?.latitude;
  const aLon = alert.longitude ?? currentKioskLocation?.longitude;
  $('#liveRescueDistance').textContent = validB && Number.isFinite(Number(aLat)) && Number.isFinite(Number(aLon))
    ? rescueDistance(Number(aLat), Number(aLon), Number(bLat), Number(bLon))
    : 'Unavailable until both fresh GPS fixes arrive';
  const message = alert.responder_message || (matchingTelemetry ? data.responder_message : null);
  const messageEl = $('#liveRescueMessage');
  messageEl.hidden = !message;
  messageEl.textContent = message ? `Responder update: ${message}` : '';
  const messageKey = message ? `${alert.id}:${alert.responder_message_at || alert.responded_at || message}` : null;
  if (message && messageKey !== responderPopupKey) {
    responderPopupKey = messageKey;
    showRescueMessage(message);
  }
  const replyButton = $('#camperReplyOpen');
  replyButton.hidden = !message || Boolean(alert.camper_reply_at);
  replyButton.dataset.alertId = alert.id;
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
    renderLiveRescue(data);
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
  if (demoSyncInFlight) return;
  demoSyncInFlight = true;
  if (viewerRole !== 'owner') {
    demoMode = false;
    demoSyncInFlight = false;
    return;
  }
  try {
    const response = await fetch('/api/demo/status', { cache: 'no-store' });
    if (!response.ok) return;
    const { active } = await response.json();
    if (demoMode && !active) {
      resetSession(false);
      for (const [id, record] of lockerSessions) {
        if (!record.demo) continue;
        const timerKey = record.demoRecordId;
        clearInterval(chargeTimers.get(timerKey));
        chargeTimers.delete(timerKey);
        clearInterval(doorPollTimers.get(timerKey));
        doorPollTimers.delete(timerKey);
        setLockerAvailable(id);
        lockerSessions.delete(id);
      }
      sessionStorage.removeItem(demoSessionStorageKey);
      locker = null;
      toast('Owner demo ended. The kiosk returned to normal mode.');
    }
    demoMode = Boolean(active);
    $('#systemDemoBanner').hidden = !demoMode;
    $('#demoCoinButtons').hidden = !demoMode;
    $('#coinHardwareStatus').textContent = demoMode ? 'Owner demo: simulated coin input' : 'Coin slot not connected';
    if (demoMode) {
      const result = await demoApi('/api/owner/demo/sessions');
      await restoreDemoSession(result.sessions);
    } else {
      await syncNormalLockerSessions();
    }
    if (demoMode && session?.demoRecordId) {
      const result = await demoApi('/api/owner/demo/sessions');
      const record = result.sessions.find(item => item.id === session.demoRecordId);
      if (record?.status === 'Awaiting pickup' && session.status === 'charging') {
        stopCharging(session);
        toast('Demo staff ended charging. The locker is waiting for pickup.');
      } else if (record?.status === 'Recovered' && session.status === 'pickup') {
        await openLockerDoor('pickup');
        toast('Staff recovery authorized the locker opening.');
      }
    }
    if (session?.status === 'charging') renderLockerState('charging');
  } catch (_) { /* Keep the regular kiosk view if the service is temporarily unavailable. */ }
  finally { demoSyncInFlight = false; }
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
  const pendingReservation = $('#nameDialog').open && !session;
  const pendingLocker = locker;
  const pickupDialogSession = $('#pickupDialog').open ? (pickupTarget || session) : null;
  const unfinished = (records || []).filter(record => record.status !== 'Completed');
  const activeDemoIds = new Set(unfinished.map(record => record.id));
  for (const [lockerId, prior] of lockerSessions) {
    if (!prior.demo || activeDemoIds.has(prior.demoRecordId)) continue;
    clearInterval(chargeTimers.get(prior.demoRecordId));
    chargeTimers.delete(prior.demoRecordId);
    clearInterval(doorPollTimers.get(prior.demoRecordId));
    doorPollTimers.delete(prior.demoRecordId);
    setLockerAvailable(lockerId);
    lockerSessions.delete(lockerId);
    if (session === prior) session = null;
  }
  const preferredId = sessionStorage.getItem(demoSessionStorageKey);
  let selected = null;
  const states = {
    'Waiting for payment': 'payment', 'Payment received': 'payment', 'Loading gear': 'loading-door',
    'PIN setup': 'pin-setup', Charging: 'charging', 'Awaiting pickup': 'pickup', Recovered: 'pickup', 'Locker open': 'door'
  };
  for (const record of unfinished) {
    const existing = lockerSessions.get(String(record.locker));
    const keepLocalPinStep = existing?.status === 'pin-setup' && ['Waiting for payment', 'Payment received'].includes(record.status);
    const target = existing?.demoRecordId === record.id
      ? Object.assign(existing, record, keepLocalPinStep ? { status: 'PIN setup' } : {})
      : { ...record, demo: true, demoRecordId: record.id, pin: '', status: states[record.status] || 'payment' };
    target.status = record.status === 'Recovered' && target.recoveryOpening
      ? 'door'
      : states[record.status] || target.status;
    lockerSessions.set(String(record.locker), target);
    if (record.status !== 'Charging' && chargeTimers.has(target.demoRecordId)) {
      clearInterval(chargeTimers.get(target.demoRecordId));
      chargeTimers.delete(target.demoRecordId);
    }
    const priorSession = session, priorLocker = locker, priorCoins = coins;
    session = target;
    locker = record.locker;
    coins = Number(record.paid) || 0;
    if (record.status === 'Charging') {
      const key = target.demoRecordId;
      if (!chargeTimers.has(key)) await startCharging(true);
      else renderLockerState('charging');
    } else if (record.status === 'Awaiting pickup') renderLockerState('pickup');
    else if (record.status === 'Recovered' && !target.recoveryOpening) {
      target.recoveryOpening = true;
      await openLockerDoor('pickup');
    }
    else if (record.status === 'Locker open' || record.status === 'Loading gear') renderLockerState('door');
    if (record.id === preferredId || (!selected && ['Waiting for payment', 'Payment received', 'PIN setup', 'Charging', 'Awaiting pickup', 'Recovered', 'Loading gear', 'Locker open'].includes(record.status))) selected = target;
    session = priorSession;
    locker = priorLocker;
    coins = priorCoins;
  }
  if (pendingReservation) {
    // Keep the newly chosen locker while refreshing other occupied lockers.
    // The name form can stay open for several polls before the POST is sent.
    session = null;
    locker = pendingLocker;
  } else if (pickupDialogSession && unfinished.some(item => item.id === pickupDialogSession.demoRecordId)) {
    session = pickupDialogSession;
    locker = pickupDialogSession.locker;
    coins = Number(pickupDialogSession.paid) || 0;
  } else if (selected) {
    session = selected;
    locker = selected.locker;
    coins = Number(selected.paid) || 0;
    sessionStorage.setItem(demoSessionStorageKey, selected.demoRecordId);
    if (['payment'].includes(selected.status)) {
      $('#coinTotal').textContent = `₱${coins}`;
      updatePayment();
      if (!$('#paymentDialog').open) open('paymentDialog');
    } else if (selected.status === 'pin-setup') {
      restorePinSetupDialog();
    }
  } else if (!session?.demoRecordId || !unfinished.some(item => item.id === session.demoRecordId)) {
    session = null;
    if (!unfinished.length) sessionStorage.removeItem(demoSessionStorageKey);
  }
  finishLockerHydration();
}
async function syncNormalLockerSessions() {
  try {
    const response = await fetch('/api/camper/active-sessions', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    if (data.demo_active) {
      // Owner demo state has a single poller (syncDemoState). Avoid applying
      // overlapping snapshots that can temporarily redraw a locker as free.
      if (viewerRole === 'owner') return;
      demoMode = true;
      $('#systemDemoBanner').hidden = false;
      $('#demoCoinButtons').hidden = !(viewerRole === 'owner');
      $('#coinHardwareStatus').textContent = 'Owner demo: simulated coin input';
      await restoreDemoSession(data.sessions || []);
      const demoLockers = new Set((data.sessions || []).filter(record => record.status !== 'Completed').map(record => String(record.locker)));
      for (const reserved of data.reserved_lockers || []) {
        const lockerId = String(reserved);
        if (demoLockers.has(lockerId)) continue;
        const card = document.querySelector(`[data-locker="${lockerId}"]`);
        if (card) {
          card.className = 'locker busy';
          card.removeAttribute('role');
          card.removeAttribute('tabindex');
          card.innerHTML = `<div class="card-head"><b>LOCKER ${lockerId}</b><span class="badge busy-badge">IN USE</span></div><div class="locker-icon">▣</div><h3>Locker reserved</h3><p>There is an active main-system session</p><small>DEMO USES ANOTHER LOCKER</small>`;
        }
      }
      finishLockerHydration();
      return;
    }
    const pendingReservation = $('#nameDialog').open && !session;
    const pendingLocker = locker;
    const sessions = data.sessions || [];
    const activeNormalIds = new Set(sessions.map(record => record.id));
    for (const [lockerId, prior] of lockerSessions) {
      if (prior.demo || activeNormalIds.has(prior.storageId)) continue;
      clearInterval(chargeTimers.get(prior.storageId));
      chargeTimers.delete(prior.storageId);
      clearInterval(doorPollTimers.get(prior.storageId));
      doorPollTimers.delete(prior.storageId);
      setLockerAvailable(lockerId);
      lockerSessions.delete(lockerId);
      if (session === prior) session = null;
    }
    const states = { 'Waiting for payment': 'payment', 'Payment received': 'payment', 'PIN setup': 'pin-setup', 'Loading gear': 'loading-door', 'Locker open': 'door', Charging: 'charging', 'Awaiting pickup': 'pickup' };
    let preferred = null;
    for (const record of sessions) {
      const existing = lockerSessions.get(String(record.locker));
      const keepLocalPinStep = existing?.status === 'pin-setup' && ['Waiting for payment', 'Payment received'].includes(record.status);
      const target = existing?.storageId === record.id
        ? Object.assign(existing, record, keepLocalPinStep ? { status: 'PIN setup' } : {})
        : { ...record, storageId: record.id, demo: false, pin: '', status: states[record.status] || 'payment' };
      target.storageId = record.id;
      target.status = states[record.status] || target.status;
      lockerSessions.set(String(record.locker), target);
      if (record.status !== 'Charging' && chargeTimers.has(record.id)) {
        clearInterval(chargeTimers.get(record.id));
        chargeTimers.delete(record.id);
      }
      const priorSession = session, priorLocker = locker, priorCoins = coins;
      session = target;
      locker = record.locker;
      coins = Number(record.paid) || 0;
      if (record.status === 'Charging') {
        if (!chargeTimers.has(record.id)) await startCharging(true);
        else renderLockerState('charging');
      } else if (record.status === 'Awaiting pickup') renderLockerState('pickup');
      else if (record.status === 'Loading gear' || record.status === 'Locker open') renderLockerState('door');
      else if (record.status === 'PIN setup') renderLockerState('payment');
      else renderLockerState('payment');
      if (record.id === sessionStorage.getItem('campconnect-active-session')) preferred = target;
      session = priorSession;
      locker = priorLocker;
      coins = priorCoins;
    }
    if (pendingReservation) {
      session = null;
      locker = pendingLocker;
    } else if (!session && preferred) {
      session = preferred;
      locker = preferred.locker;
      coins = Number(preferred.paid) || 0;
      if (preferred.status === 'payment') {
        $('#coinTotal').textContent = `₱${coins}`;
        updatePayment();
        open('paymentDialog');
      } else if (preferred.status === 'pin-setup') {
        restorePinSetupDialog();
      }
    }
    finishLockerHydration();
  } catch (_) { /* Leave locker cards as they are while the kiosk service reconnects. */ }
}
function saveDemoSession(updates, target = session) {
  if (viewerRole !== 'owner' || !demoMode || !target?.demoRecordId) return;
  return demoApi(`/api/owner/demo/sessions/${encodeURIComponent(target.demoRecordId)}`, 'PATCH', updates).catch(() => {});
}
function savePersistentSession(updates, target = session) {
  if (!target?.storageId || target.demo) return Promise.resolve(null);
  const pending = fetch(`/api/sessions/${encodeURIComponent(target.storageId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates)
  });
  pending.catch(() => {});
  return pending;
}
function restorePinSetupDialog() {
  if ($('#pinDialog').open) return;
  pin = firstPin = '';
  pinStep = 'create';
  $('#pinError').textContent = '';
  $('#pinTitle').textContent = 'Create your 6-digit PIN';
  $('#pinText').textContent = 'You will need this PIN to open the locker after charging finishes.';
  drawDots('pinDots', '');
  $('#pinNext').disabled = true;
  if ($('#paymentDialog').open) $('#paymentDialog').close();
  open('pinDialog');
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
function finishLockerHydration() {
  if (lockerStateHydrated) return;
  lockerStateHydrated = true;
  $('#lockerGrid').inert = false;
  $('#lockerStatusNote').textContent = 'Tap an available locker to begin.';
  updateAvailableCount();
}
async function recoverOccupiedLockerSelection(message) {
  $('#nameDialog').close();
  $('#camperName').value = '';
  $('#nameError').textContent = '';
  locker = null;
  session = null;
  if (demoMode && viewerRole === 'owner') {
    try {
      const snapshot = await demoApi('/api/owner/demo/sessions');
      await restoreDemoSession(snapshot.sessions);
    } catch (_) { /* The regular sync will refresh the locker list when the service reconnects. */ }
  } else {
    await syncNormalLockerSessions();
  }
  toast(`${message} Select another available locker and enter the camper's name again.`);
}
function resetSession(reopenName = false) {
  clearInterval(paymentTimer);
  paymentTimer = null;
  for (const id of ['nameDialog', 'pinDialog', 'paymentDialog', 'pickupDialog']) {
    const dialog = document.getElementById(id);
    if (dialog.open) dialog.close();
  }
  const oldLocker = locker;
  const oldSession = session;
  const oldSessionKey = oldSession?.demoRecordId || oldSession?.storageId || oldLocker;
  clearInterval(doorPollTimers.get(oldSessionKey));
  doorPollTimers.delete(oldSessionKey);
  if (oldSession?.storageId && sessionStorage.getItem('campconnect-active-session') === oldSession.storageId) {
    sessionStorage.removeItem('campconnect-active-session');
  }
  if (oldSession?.demoRecordId && sessionStorage.getItem(demoSessionStorageKey) === oldSession.demoRecordId) {
    sessionStorage.removeItem(demoSessionStorageKey);
  }
  if (oldSession?.demoRecordId && oldSession.status !== 'completed') {
    demoApi(`/api/owner/demo/sessions/${encodeURIComponent(oldSession.demoRecordId)}`, 'DELETE').catch(() => {});
    lockerSessions.delete(String(oldLocker));
  }
  if (oldSession?.storageId && ['payment', 'pin-setup'].includes(oldSession.status)) {
    fetch(`/api/sessions/${encodeURIComponent(oldSession.storageId)}`, { method: 'DELETE' }).catch(() => {});
    lockerSessions.delete(String(oldLocker));
  }
  session = null;
  pin = firstPin = pickupPin = '';
  coins = 0;
  // Closing a name dialog for a locker that became occupied during the
  // reservation must not redraw that active locker as available.
  if (oldLocker && !lockerSessions.has(String(oldLocker))) setLockerAvailable(oldLocker);
  updateAvailableCount();
  if (reopenName && oldLocker) {
    $('#camperName').value = '';
    $('#nameError').textContent = '';
    setTimeout(() => open('nameDialog'), 180);
  } else locker = null;
}
function renderLockerState(state, target = session) {
  const card = document.querySelector(`[data-locker="${target?.locker ?? locker}"]`);
  if (!card) return;
  if (state === 'payment') {
    card.className = 'locker busy';
    card.innerHTML = `<div class="card-head"><b>LOCKER ${target?.locker ?? locker}</b><span class="badge busy-badge">SESSION IN PROGRESS</span></div><div class="locker-icon">▣</div><h3>Locker reserved</h3><p>Payment or PIN setup is in progress</p><small>CONTINUE THIS SESSION AT THE KIOSK</small>`;
  } else if (state === 'charging') {
    card.className = 'locker busy';
    const canControlDemo = demoMode && viewerRole === 'owner' && target === session;
    card.innerHTML = `<div class="card-head"><b>LOCKER ${target?.locker ?? locker}</b><span class="badge busy-badge">IN USE</span></div><div class="locker-icon">▣</div><h3>Charging your device</h3><p>The locker remains closed</p><small class="remaining">Time remaining</small>${canControlDemo ? '<button class="tiny-demo" data-charge-control type="button">Bypass demo timer · stop charging</button>' : ''}`;
    if (canControlDemo) card.querySelector('[data-charge-control]')?.addEventListener('click', () => stopCharging(target));
  } else if (state === 'pickup') {
    card.className = 'locker busy pickup';
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.innerHTML = `<div class="card-head"><b>LOCKER ${target?.locker ?? locker}</b><span class="badge busy-badge">READY FOR PICKUP</span></div><div class="locker-icon">▣</div><h3>Charging stopped</h3><p>Your items are still locked</p><small>Tap to enter your PIN</small>`;
  } else if (state === 'door') {
    card.className = 'locker busy';
    card.removeAttribute('role');
    card.removeAttribute('tabindex');
    const hasHardware = Boolean(lockerHardware());
    const initialLoad = target?.status === 'loading-door';
    card.innerHTML = `<div class="card-head"><b>LOCKER ${target?.locker ?? locker}</b><span class="badge open-badge">${initialLoad ? 'READY TO LOAD' : 'UNLOCKED'}</span></div><div class="locker-icon">▤</div><h3>${initialLoad ? 'Place your belongings inside' : 'Take your belongings'}</h3><p>${hasHardware ? 'Close the door to continue.' : 'Use the control below to simulate closing the door.'}</p>${hasHardware ? '<small>WAITING FOR DOOR SENSOR</small>' : `<button class="tiny-demo" data-door-action type="button">${initialLoad ? 'Close door · start charging' : 'Close locker'}</button>`}`;
    if (hasHardware) monitorDoorClosure(target);
    else card.querySelector('[data-door-action]')?.addEventListener('click', initialLoad ? () => startCharging(false, target) : () => finishPickup(target));
  } else if (state === 'opening-door') {
    card.className = 'locker busy';
    card.removeAttribute('role');
    card.removeAttribute('tabindex');
    card.innerHTML = `<div class="card-head"><b>LOCKER ${target?.locker ?? locker}</b><span class="badge busy-badge">OPENING</span></div><div class="locker-icon">▣</div><h3>Opening locker</h3><p>Please wait for the door sensor.</p>`;
  }
  updateAvailableCount();
}
async function openLockerDoor(purpose, target = session) {
  if (!target) return;
  const loading = purpose === 'load';
  target.status = loading ? 'loading-door' : 'opening-pickup-door';
  const hardware = lockerHardware();
  if (!hardware) {
    target.status = loading ? 'loading-door' : 'door';
    if (target.demoRecordId) saveDemoSession({ status: loading ? 'Loading gear' : 'Locker open' }, target);
    if (target.storageId) savePersistentSession({ status: loading ? 'Loading gear' : 'Locker open' }, target);
    renderLockerState('door', target);
    return;
  }
  renderLockerState('opening-door', target);
  try {
    await hardware.openLocker(String(target.locker));
    target.status = loading ? 'loading-door' : 'door';
    if (target.demoRecordId) saveDemoSession({ status: loading ? 'Loading gear' : 'Locker open' }, target);
    if (target.storageId) savePersistentSession({ status: loading ? 'Loading gear' : 'Locker open' }, target);
    renderLockerState('door', target);
  } catch (error) {
    target.status = loading ? 'loading-door' : 'pickup';
    if (loading) renderLockerState('door', target);
    else {
      renderLockerState('pickup', target);
      if (session === target) {
        $('#pickupError').textContent = 'The locker could not be opened. Please try again or contact staff.';
        open('pickupDialog');
      }
    }
    toast(error?.message || 'The locker could not be opened. Please contact staff.');
  }
}
function monitorDoorClosure(target = session) {
  if (!target) return;
  const key = target.demoRecordId || target.storageId || target.locker;
  if (doorPollTimers.has(key)) return;
  const hardware = lockerHardware();
  if (!hardware) return;
  let sawOpenDoor = false;
  const timer = setInterval(async () => {
    if (!['loading-door', 'door'].includes(target.status)) {
      clearInterval(timer);
      doorPollTimers.delete(key);
      return;
    }
    try {
      const doorState = await hardware.getDoorState(String(target.locker));
      if (doorState === 'open') {
        sawOpenDoor = true;
        return;
      }
      if (doorState !== 'closed' || !sawOpenDoor) return;
      clearInterval(timer);
      doorPollTimers.delete(key);
      if (target.status === 'loading-door') startCharging(false, target);
      else finishPickup(target);
    } catch (_) { /* Wait for another sensor reading. */ }
  }, 500);
  doorPollTimers.set(key, timer);
}
async function finishPickup(target = session) {
  if (!target || target.status !== 'door') return;
  const key = target.demoRecordId || target.storageId || target.locker;
  clearInterval(doorPollTimers.get(key));
  doorPollTimers.delete(key);
  const finishedLocker = target.locker;
  const finished = { sessionId: target.storageId || null, demoRecordId: target.demoRecordId || null };
  if (target.demoRecordId) {
    target.status = 'completed';
    const usedMinutes = sessionUsedMinutes(target);
    await saveDemoSession({ status: 'Completed', used: `${usedMinutes} min` }, target);
  }
  if (target.storageId) {
    target.status = 'completed';
    const usedMinutes = sessionUsedMinutes(target);
    await savePersistentSession({ status: 'Completed', usedMinutes }, target).catch(() => null);
  }
  lockerSessions.delete(String(finishedLocker));
  if (finished.storageId) {
    if (sessionStorage.getItem('campconnect-active-session') === finished.storageId) sessionStorage.removeItem('campconnect-active-session');
  }
  if (finished.demoRecordId && sessionStorage.getItem(demoSessionStorageKey) === finished.demoRecordId) sessionStorage.removeItem(demoSessionStorageKey);
  setLockerAvailable(finishedLocker);
  if (session === target) {
    resetSession(false);
    locker = null;
    showFeedback({ ...finished, locker: finishedLocker });
  }
  updateAvailableCount();
  toast('Locker closed. The kiosk is ready for the next camper.');
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
function sessionUsedMinutes(target) {
  const saved = Number.parseInt(String(target?.used || '0'), 10) || 0;
  const elapsed = Number.isFinite(target?.startedEpoch) ? Math.ceil((Date.now() - target.startedEpoch) / 60000) : saved;
  return Math.max(1, saved, elapsed);
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
async function beginPinSetup() {
  if (!chargingMinutes(coins)) return;
  clearInterval(paymentTimer);
  paymentTimer = null;
  pin = firstPin = '';
  pinStep = 'create';
  session.status = 'pin-setup';
  try {
    if (session.demoRecordId) await demoApi(`/api/owner/demo/sessions/${encodeURIComponent(session.demoRecordId)}`, 'PATCH', { status: 'PIN setup' });
    else if (session.storageId) {
      const response = await savePersistentSession({ status: 'PIN setup' }, session);
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(result.error || 'Could not save PIN setup.');
    }
  } catch (error) {
    session.status = 'payment';
    $('#paymentStatus').textContent = error.message;
    return;
  }
  $('#pinError').textContent = '';
  $('#pinTitle').textContent = 'Create your 6-digit PIN';
  $('#pinText').textContent = 'You will need this PIN to open the locker after charging finishes.';
  drawDots('pinDots', '');
  $('#pinNext').disabled = true;
  $('#paymentDialog').close();
  open('pinDialog');
}
async function startCharging(resumeDemo = false, target = session) {
  resumeDemo = resumeDemo === true;
  const chargingSession = target;
  if (!chargingSession) return;
  const minutes = chargingMinutes(chargingSession.paid ?? coins);
  chargingSession.paid = Number(chargingSession.paid ?? coins);
  if (resumeDemo) {
    const savedStart = chargingSession.started_at ? Date.parse(chargingSession.started_at) : NaN;
    const savedUsed = Number.parseInt(String(chargingSession.used || '0'), 10) || 0;
    chargingSession.startedEpoch = Number.isFinite(savedStart) ? savedStart : Date.now() - savedUsed * 60000;
    chargingSession.lastReportedUsed = Math.max(savedUsed, Math.floor((Date.now() - chargingSession.startedEpoch) / 60000));
  } else {
    chargingSession.startedEpoch = Date.now();
    chargingSession.lastReportedUsed = 0;
  }
  chargingSession.status = 'charging';
  lockerSessions.set(String(chargingSession.locker), chargingSession);
  if (!resumeDemo) {
    // Persist the door-closed transition before leaving the loading-door step.
    // Otherwise a quick dashboard switch can restore the older "Loading gear" state.
    if (chargingSession.demoRecordId) {
      try {
        await demoApi(`/api/owner/demo/sessions/${encodeURIComponent(chargingSession.demoRecordId)}`, 'PATCH', {
          status: 'Charging', paid: chargingSession.paid, minutes, used: '0 min'
        });
      } catch (error) {
        toast(error?.message || 'Charging started, but the demo session could not be saved.');
      }
    }
    savePersistentSession({ status: 'Charging', paid: chargingSession.paid, minutes, usedMinutes: 0 }, chargingSession);
  }
  const expiresAt = chargingSession.startedEpoch + minutes * 60 * 1000;
  renderLockerState('charging', chargingSession);
  if (expiresAt <= Date.now()) { stopCharging(chargingSession); return; }
  const timer = setInterval(() => {
    const left = Math.max(0, expiresAt - Date.now());
    const usedMinutes = Math.floor((Date.now() - chargingSession.startedEpoch) / 60000);
    if (usedMinutes > chargingSession.lastReportedUsed) {
      chargingSession.lastReportedUsed = usedMinutes;
      saveDemoSession({ used: `${usedMinutes} min` }, chargingSession);
      savePersistentSession({ usedMinutes }, chargingSession);
    }
    const card = document.querySelector(`[data-locker="${chargingSession.locker}"]`);
    const remaining = card?.querySelector('.remaining');
    if (remaining) {
      const mins = Math.floor(left / 60000);
      const secs = Math.ceil((left % 60000) / 1000);
      remaining.textContent = `${mins}:${String(secs).padStart(2, '0')} remaining`;
    }
    if (left <= 0) stopCharging(chargingSession);
  }, 500);
  const key = chargingSession.demoRecordId || chargingSession.storageId || chargingSession.locker;
  chargeTimers.set(key, timer);
  chargeTimer = timer;
  toast(`Charging started for ${minutes} minutes. The locker stays locked.`);
}
function stopCharging(chargingSession = session) {
  if (!chargingSession || chargingSession.status !== 'charging') return;
  const key = chargingSession.demoRecordId || chargingSession.storageId || chargingSession.locker;
  const timer = chargeTimers.get(key);
  clearInterval(timer);
  chargeTimers.delete(key);
  if (chargeTimer === timer) chargeTimer = null;
  chargingSession.status = 'pickup';
  lockerSessions.set(String(chargingSession.locker), chargingSession);
  const usedMinutes = Math.max(1, Math.ceil((Date.now() - chargingSession.startedEpoch) / 60000));
  saveDemoSession({ status: 'Awaiting pickup', used: `${usedMinutes} min` }, chargingSession);
  savePersistentSession({ status: 'Awaiting pickup', usedMinutes }, chargingSession);
  renderLockerState('pickup', chargingSession);
  toast('Charging stopped. The locker remains locked until the PIN is entered.');
}

document.querySelectorAll('[data-coin]').forEach(button => button.addEventListener('click', () => {
  if (viewerRole === 'owner' && demoMode) acceptCoin(Number(button.dataset.coin));
}));

$('#lockerGrid').addEventListener('click', event => {
  if (!lockerStateHydrated) return;
  const card = event.target.closest('[data-locker]');
  if (!card) return;
  const id = card.dataset.locker;
  if (card.classList.contains('available')) {
    locker = id;
    coins = 0;
    session = null;
    $('#camperName').value = '';
    $('#nameError').textContent = '';
    $('#nameLockerPrompt').textContent = `Locker ${id} selected. Enter your name, then insert coins to select charging time.`;
    open('nameDialog');
  } else if ((lockerSessions.get(String(id)) || session)?.status === 'pickup'
    && (lockerSessions.get(String(id))?.locker === id || session?.locker === id)) {
    pickupTarget = lockerSessions.get(String(id)) || session;
    session = pickupTarget;
    locker = id;
    if (pickupTarget.demoRecordId) sessionStorage.setItem(demoSessionStorageKey, pickupTarget.demoRecordId);
    if (pickupTarget.storageId) sessionStorage.setItem('campconnect-active-session', pickupTarget.storageId);
    pickupPin = '';
    drawDots('pickupDots', '');
    $('#pickupError').textContent = '';
    $('#unlock').disabled = true;
    $('#pickupTitle').textContent = `Open locker ${id}`;
    open('pickupDialog');
  } else if ((lockerSessions.get(String(id)) || session)?.status === 'charging') {
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
      lockerSessions.set(String(locker), session);
      sessionStorage.setItem(demoSessionStorageKey, session.demoRecordId);
    } catch (error) {
      session = null;
      if (/^Locker \d+ is already occupied/i.test(error.message)) {
        await recoverOccupiedLockerSelection(error.message);
        return;
      }
      $('#nameError').textContent = error.message;
      toast(error.message);
      return;
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
      lockerSessions.set(String(locker), session);
      sessionStorage.setItem('campconnect-active-session', session.storageId);
    } catch (error) {
      session = null;
      if (/^Locker \d+ is already occupied/i.test(error.message)) {
        await recoverOccupiedLockerSelection(error.message);
        return;
      }
      $('#nameError').textContent = error.message;
      toast(error.message);
      return;
    }
  }
  renderLockerState('payment');
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
  } else if (session.storageId) {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.storageId)}/pin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(result.error || 'Could not save the PIN verifier.');
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
  const target = pickupTarget || session;
  if (!target || pickupPin.length !== 6) return;
  let validPin = pickupPin === target.pin;
  if (target.demoRecordId && demoMode) {
    try {
      const result = await demoApi(`/api/owner/demo/sessions/${encodeURIComponent(target.demoRecordId)}/verify-pin`, 'POST', { pin: pickupPin });
      validPin = Boolean(result.valid);
    } catch (error) {
      $('#pickupError').textContent = error.message;
      return;
    }
  } else if (target.storageId) {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(target.storageId)}/verify-pin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: pickupPin })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(result.error || 'Could not verify the PIN.');
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
  target.status = 'door';
  session = target;
  $('#pickupDialog').close();
  openLockerDoor('pickup', target);
});

$('#pickupDialog').addEventListener('close', () => { pickupTarget = null; });

document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => {
  const dialog = button.closest('dialog');
  if (['nameDialog', 'pinDialog', 'paymentDialog'].includes(dialog.id)) resetSession(false);
  dialog.close();
}));
for (const id of ['nameDialog', 'pinDialog', 'paymentDialog']) {
  document.getElementById(id).addEventListener('cancel', () => resetSession(false));
}

const camperReplyField = $('#camperReplyText');
function updateCamperReplyCounter() {
  const length = [...camperReplyField.value].length;
  $('#camperReplyCount').textContent = `${length} / 100 characters`;
  $('#sendCamperReply').disabled = length === 0 || length > 100;
}
function buildCamperReplyKeyboard() {
  const host = $('#camperReplyKeyboard');
  ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '.,!?-'].forEach(keys => {
    const row = document.createElement('div');
    row.className = 'reply-key-row';
    [...keys].forEach(key => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'reply-key';
      button.dataset.replyKey = key; button.textContent = key;
      row.append(button);
    });
    host.append(row);
  });
  const controls = document.createElement('div');
  controls.className = 'reply-key-row reply-key-controls';
  [['shift', 'Shift'], ['space', 'Space'], ['back', '⌫'], ['clear', 'Clear']].forEach(([key, label]) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'reply-key utility';
    button.dataset.replyKey = key; button.textContent = label;
    controls.append(button);
  });
  host.append(controls);
}
$('#camperReplyOpen').addEventListener('click', event => {
  camperReplyAlertId = event.currentTarget.dataset.alertId;
  camperReplyField.value = '';
  camperReplyShift = false;
  $('#camperReplyStatus').textContent = '';
  updateCamperReplyCounter();
  $('#camperReplyDialog').showModal();
});
$('#camperReplyKeyboard').addEventListener('click', event => {
  const button = event.target.closest('[data-reply-key]');
  if (!button) return;
  const key = button.dataset.replyKey;
  let value = [...camperReplyField.value];
  if (key === 'shift') { camperReplyShift = !camperReplyShift; button.classList.toggle('selected', camperReplyShift); return; }
  if (key === 'back') value.pop();
  else if (key === 'clear') value = [];
  else if (key === 'space' && value.length < 100 && value.length) value.push(' ');
  else if (key.length === 1 && value.length < 100) { value.push(camperReplyShift ? key.toUpperCase() : key); camperReplyShift = false; $('#camperReplyKeyboard [data-reply-key="shift"]').classList.remove('selected'); }
  camperReplyField.value = value.join('');
  updateCamperReplyCounter();
});
$('#camperReplyForm').addEventListener('submit', async event => {
  event.preventDefault();
  const message = camperReplyField.value.trim();
  if (!camperReplyAlertId || !message || [...message].length > 100) return;
  const send = $('#sendCamperReply');
  send.disabled = true; send.textContent = 'Sending…';
  $('#camperReplyStatus').textContent = '';
  try {
    const response = await fetch(`/api/camper/alerts/${encodeURIComponent(camperReplyAlertId)}/reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Could not send the message.');
    $('#camperReplyDialog').close();
    camperReplyAlertId = null;
    $('#camperReplyOpen').hidden = true;
    toast('Message sent. The responder cannot reply to this message.');
    refreshTransportStatus();
  } catch (error) { $('#camperReplyStatus').textContent = error.message; }
  finally { send.textContent = 'Send reply'; updateCamperReplyCounter(); }
});
buildCamperReplyKeyboard();

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
$('#lockerGrid').inert = true;
$('#lockerStatusNote').textContent = 'Checking saved locker sessions…';
$('#availableCount').textContent = 'Checking lockers…';
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
syncNormalLockerSessions();
setInterval(syncNormalLockerSessions, 2500);
refreshTransportStatus();
setInterval(refreshTransportStatus, 5000);
