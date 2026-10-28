(() => {
  const button = document.querySelector('#enableSosAlerts');
  if (!button) return;

  const alarmAudio = new Audio('/mobile/IOS_Emergency_Alert_Notification_-_Sound_Effect_HD.wav');
  alarmAudio.preload = 'auto';
  alarmAudio.volume = 0.9;
  let soundEnabled = false;
  let knownAlertIds = null;
  let latestAlerts = [];
  let alarmActive = false;
  let titleTimer = null;
  try {
    if (localStorage.getItem('campconnect-sos-sound-armed') === '1') button.textContent = 'Tap to re-enable SOS sound';
  } catch (_) { /* Local storage may be disabled; sound can still be enabled for this page. */ }

  function playAlertSound() {
    if (!soundEnabled) return;
    alarmAudio.play().catch(() => {
      soundEnabled = false;
      alarmActive = false;
      alarmAudio.loop = false;
      button.textContent = 'Tap to enable SOS sound';
      button.setAttribute('aria-pressed', 'false');
      button.classList.remove('enabled');
    });
  }

  function syncAlarm() {
    const pending = latestAlerts.some(alert => alert.status !== 'Resolved' && !alert.responded_at);
    if (soundEnabled && pending && !alarmActive) {
      alarmActive = true;
      alarmAudio.loop = true;
      playAlertSound();
    } else if ((!soundEnabled || !pending) && alarmActive) {
      alarmActive = false;
      alarmAudio.loop = false;
      alarmAudio.pause();
      alarmAudio.currentTime = 0;
    }
  }

  button.addEventListener('click', async () => {
    try {
      soundEnabled = true;
      syncAlarm();
      if (!alarmActive) playAlertSound();
      if ('Notification' in window && window.isSecureContext && Notification.permission === 'default') {
        try { await Notification.requestPermission(); } catch (_) { /* Sound still works when notifications are denied. */ }
      }
      button.textContent = 'SOS sound enabled';
      button.setAttribute('aria-pressed', 'true');
      button.classList.add('enabled');
      try { localStorage.setItem('campconnect-sos-sound-armed', '1'); } catch (_) { /* This page session remains enabled. */ }
    } catch (_) {
      button.textContent = 'Sound unavailable';
    }
  });

  async function checkForNewAlerts() {
    try {
      const response = await fetch('/api/mobile/alerts', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) return;
      const alerts = (await response.json()).alerts || [];
      latestAlerts = alerts;
      syncAlarm();
      if (knownAlertIds === null) {
        knownAlertIds = new Set(alerts.map(alert => alert.id));
        return;
      }
      const fresh = alerts.filter(alert => !knownAlertIds.has(alert.id));
      knownAlertIds = new Set(alerts.map(alert => alert.id));
      if (!fresh.length) return;
      playAlertSound();
      const alert = fresh[0];
      if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        new Notification('CampConnect SOS alert', {
          body: `${alert.alert_type || 'Emergency'}${alert.details ? ` · ${alert.details}` : ''}`,
          tag: `campconnect-sos-${alert.id}`,
          renotify: true
        });
      }
      const originalTitle = document.title;
      document.title = `SOS ALERT · ${originalTitle}`;
      clearTimeout(titleTimer);
      titleTimer = setTimeout(() => { document.title = originalTitle; }, 10000);
    } catch (_) { /* A short network interruption should not stop future alert checks. */ }
  }

  checkForNewAlerts();
  setInterval(checkForNewAlerts, 2500);
})();
