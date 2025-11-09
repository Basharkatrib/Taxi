// Arabic Taxi Appointments PWA
(() => {
  const STORAGE_KEYS = {
    appointments: 'appointments',
    lastResetDate: 'lastResetDate'
  };

  const dom = {
    form: document.getElementById('appointmentForm'),
    inputName: document.getElementById('customerName'),
    inputDateTime: document.getElementById('appointmentTime'),
    inputNotes: document.getElementById('notes'),
    list: document.getElementById('appointmentsList'),
    itemTpl: document.getElementById('appointmentItemTpl'),
    clearAllBtn: document.getElementById('clearAllBtn'),
    enableSoundBtn: document.getElementById('enableSoundBtn'),
    enableNotifBtn: document.getElementById('enableNotifBtn')
  };

  const alarmTimersById = new Map();
  let audioContext = null;

  document.addEventListener('DOMContentLoaded', () => {
    ensureDailyReset();
    renderAppointments();
    scheduleAllAlarms();
    registerServiceWorker();
    attachEvents();
    setDefaultDateTime();
  });

  function attachEvents() {
    dom.form.addEventListener('submit', onAddAppointment);
    dom.list.addEventListener('click', onListClick);
    dom.clearAllBtn.addEventListener('click', onClearAll);
    dom.enableSoundBtn.addEventListener('click', enableSoundPlayback);
    dom.enableNotifBtn.addEventListener('click', requestNotifications);
  }

  function setDefaultDateTime() {
    try {
      const now = new Date();
      now.setMinutes(now.getMinutes() + 10);
      const pad = (n) => String(n).padStart(2, '0');
      const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      dom.inputDateTime.value = local;
    } catch {}
  }

  function formatDateKeyLocal(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function ensureDailyReset() {
    const todayKey = formatDateKeyLocal(new Date());
    const last = localStorage.getItem(STORAGE_KEYS.lastResetDate);
    if (last !== todayKey) {
      localStorage.setItem(STORAGE_KEYS.appointments, JSON.stringify([]));
      localStorage.setItem(STORAGE_KEYS.lastResetDate, todayKey);
    }
  }

  function readAppointments() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.appointments);
      if (!raw) return [];
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return [];
      return list;
    } catch {
      return [];
    }
  }

  function writeAppointments(list) {
    localStorage.setItem(STORAGE_KEYS.appointments, JSON.stringify(list));
  }

  function onAddAppointment(e) {
    e.preventDefault();
    const name = (dom.inputName.value || '').trim();
    const dtVal = dom.inputDateTime.value;
    const notes = (dom.inputNotes.value || '').trim();
    if (!name || !dtVal) return;

    const startDate = new Date(dtVal);
    if (Number.isNaN(startDate.getTime())) return;

    const appointment = {
      id: generateId(),
      name,
      startISO: startDate.toISOString(),
      notes
    };
    const list = readAppointments();
    list.push(appointment);
    list.sort((a, b) => new Date(a.startISO) - new Date(b.startISO));
    writeAppointments(list);
    renderAppointments();
    scheduleAlarmFor(appointment);
    dom.form.reset();
    setDefaultDateTime();
    dom.inputName.focus();
  }

  function onListClick(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    const li = e.target.closest('.list-item');
    if (!li) return;
    const id = li.dataset.id;
    const action = btn.dataset.action;
    const list = readAppointments();
    const item = list.find(x => x.id === id);
    if (!item) return;
    if (action === 'delete') {
      cancelAlarmFor(id);
      const next = list.filter(x => x.id !== id);
      writeAppointments(next);
      renderAppointments();
    } else if (action === 'ics') {
      addToCalendar(item);
    } else if (action === 'alarm') {
      openAndroidAlarm(item);
    }
  }

  function onClearAll() {
    const list = readAppointments();
    for (const app of list) cancelAlarmFor(app.id);
    writeAppointments([]);
    renderAppointments();
  }

  function renderAppointments() {
    const list = readAppointments();
    dom.list.innerHTML = '';
    for (const app of list) {
      const li = dom.itemTpl.content.firstElementChild.cloneNode(true);
      li.dataset.id = app.id;
      const titleEl = li.querySelector('.title');
      const subEl = li.querySelector('.sub');
      titleEl.textContent = app.name;
      const start = new Date(app.startISO);
      const dateStr = formatDateReadable(start);
      subEl.textContent = [dateStr, app.notes].filter(Boolean).join(' — ');
      dom.list.appendChild(li);
    }
    if (list.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'list-item';
      empty.textContent = 'لا توجد مواعيد لليوم.';
      dom.list.appendChild(empty);
    }
  }

  function scheduleAllAlarms() {
    const list = readAppointments();
    for (const app of list) scheduleAlarmFor(app);
  }

  function scheduleAlarmFor(app) {
    cancelAlarmFor(app.id);
    const start = new Date(app.startISO);
    const msUntil = start.getTime() - Date.now() - (10 * 60 * 1000);
    if (msUntil <= 0) return;
    const timerId = setTimeout(() => {
      notifyAndRing(app);
      alarmTimersById.delete(app.id);
    }, msUntil);
    alarmTimersById.set(app.id, timerId);
  }

  function cancelAlarmFor(id) {
    const t = alarmTimersById.get(id);
    if (t) {
      clearTimeout(t);
      alarmTimersById.delete(id);
    }
  }

  function notifyAndRing(app) {
    tryShowNotification(`موعد بعد 10 دقائق: ${app.name}`, app);
    playRingtonePattern(10_000);
  }

  function tryShowNotification(title, app) {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      new Notification(title, {
        body: formatDateReadable(new Date(app.startISO)),
        icon: 'assets/icons/icon-192.svg',
        tag: `appt-${app.id}`
      });
    }
  }

  function enableSoundPlayback() {
    if (audioContext && audioContext.state === 'running') return;
    try {
      if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
      // On some browsers, resume is required after a user gesture
      audioContext.resume();
      dom.enableSoundBtn.textContent = 'الصوت مفعّل';
      dom.enableSoundBtn.classList.add('primary');
    } catch {
      // ignore
    }
  }

  function requestNotifications() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') return;
    Notification.requestPermission().then(() => {});
  }

  function playRingtonePattern(durationMs = 10000) {
    if (!audioContext) return;
    const endAt = (audioContext.currentTime + durationMs / 1000);
    const playBeep = (startTime, length = 0.35, freq = 1000) => {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(audioContext.destination);
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.exponentialRampToValueAtTime(0.3, startTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + length);
      osc.start(startTime);
      osc.stop(startTime + length + 0.05);
    };
    const now = audioContext.currentTime;
    let t = now;
    while (t < endAt) {
      playBeep(t, 0.4, 880);
      t += 0.6; // 0.4s beep + 0.2s pause
    }
  }

  function addToCalendar(app) {
    const start = new Date(app.startISO);
    const icsContent = buildIcs({
      title: `إيصال: ${app.name}`,
      notes: app.notes || '',
      startDate: start
    });
    const fileNameDate = app.startISO.slice(0, 16).replace(/[:T]/g, '-');
    const fileName = `موعد-${sanitizeFilePart(app.name)}-${fileNameDate}.ics`;
    const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    // iOS Safari usually opens .ics directly in التقويم عند فتح الرابط
    if (isIOS()) {
      window.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return;
    }

    // Android: حاول المشاركة عبر نظام المشاركة (قد يفتح تطبيق تقويم يدعم .ics مثل Samsung Calendar)
    const file = new File([icsContent], fileName, { type: 'text/calendar' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({
        files: [file],
        title: 'إضافة موعد إلى التقويم',
        text: `إضافة موعد: ${app.name}`
      }).catch(() => {
        // تجاهل إلغاء المشاركة
      }).finally(() => {
        URL.revokeObjectURL(url);
      });
      return;
    }

    // كخيار موثوق على أندرويد (Google Calendar لا يدعم فتح .ics مباشرة): افتح نموذج إضافة حدث
    const gcalUrl = buildGoogleCalendarUrl({
      title: `إيصال: ${app.name}`,
      notes: app.notes || '',
      startDate: start
    });
    const opened = window.open(gcalUrl, '_blank');
    if (!opened) {
      // fallback أخير: نزّل الملف واطلب من المستخدم فتحه يدويًا
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      alert('تم تنزيل ملف التقويم .ics. افتح الملف من التنزيلات لإضافته إلى التقويم.');
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } else {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  function buildIcs({ title, notes, startDate }) {
    const dtStart = toIcsUtc(startDate);
    const dtEnd = toIcsUtc(new Date(startDate.getTime() + 60 * 60 * 1000));
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@taxi-app`;
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Taxi App//AR',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${toIcsUtc(new Date())}`,
      `DTSTART:${dtStart}`,
      `DTEND:${dtEnd}`,
      `SUMMARY:${escapeIcs(title)}`,
      `DESCRIPTION:${escapeIcs(notes)}`,
      'BEGIN:VALARM',
      'TRIGGER:-PT10M',
      'ACTION:DISPLAY',
      'DESCRIPTION:Reminder - 10 minutes before',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR'
    ];
    return lines.join('\r\n');
  }

  function buildGoogleCalendarUrl({ title, notes, startDate }) {
    // استخدم UTC مع ctz لعرضه حسب المنطقة
    const startUtc = toIcsUtc(startDate).replace('Z', '');
    const endUtc = toIcsUtc(new Date(startDate.getTime() + 60 * 60 * 1000)).replace('Z', '');
    const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
    const base = 'https://calendar.google.com/calendar/render';
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: title,
      details: notes,
      dates: `${startUtc}Z/${endUtc}Z`,
      ctz: tz
    });
    return `${base}?${params.toString()}`;
  }

  function isIOS() {
    const ua = navigator.userAgent || navigator.vendor || '';
    const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return iOS;
  }

  function isAndroid() {
    const ua = navigator.userAgent || '';
    return /Android/i.test(ua);
  }

  function openAndroidAlarm(app) {
    if (!isAndroid()) {
      alert('زر المنبّه يعمل على أجهزة أندرويد فقط.');
      return;
    }
    // اجعل المنبّه قبل 10 دقائق من الموعد
    let when = new Date(new Date(app.startISO).getTime() - 10 * 60 * 1000);
    const now = new Date();
    if (when.getTime() <= now.getTime()) {
      // إذا فات الوقت، اضبطه بعد دقيقتين من الآن لتجربة المنبّه بسرعة
      when = new Date(now.getTime() + 2 * 60 * 1000);
    }
    const hour = when.getHours();
    const minutes = when.getMinutes();
    const msg = encodeURIComponent(`موعد إيصال: ${app.name}`);
    // صيغة intent القياسية لفتح تطبيق الساعة مع إعداد ساعة منبّه
    const intentUrl =
      `intent:#Intent;` +
      `action=android.intent.action.SET_ALARM;` +
      `S.android.intent.extra.alarm.MESSAGE=${msg};` +
      `i.android.intent.extra.alarm.HOUR=${hour};` +
      `i.android.intent.extra.alarm.MINUTES=${minutes};` +
      `B.android.intent.extra.alarm.SKIP_UI=false;` +
      `end`;
    try {
      window.location.href = intentUrl;
    } catch {
      alert('تعذر فتح تطبيق الساعة. يرجى إنشاء منبّه يدويًا.');
    }
  }

  function toIcsUtc(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mm = String(date.getUTCMinutes()).padStart(2, '0');
    const ss = String(date.getUTCSeconds()).padStart(2, '0');
    return `${y}${m}${d}T${hh}${mm}${ss}Z`;
  }

  function escapeIcs(s) {
    return String(s || '')
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/,/g, '\\,')
      .replace(/;/g, '\\;');
  }

  function sanitizeFilePart(s) {
    return String(s).replace(/[\\/:*?"<>|]/g, '-').slice(0, 40);
  }

  function formatDateReadable(date) {
    try {
      return new Intl.DateTimeFormat('ar', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }).format(date);
    } catch {
      return date.toLocaleString('ar');
    }
  }

  function generateId() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }
})(); 


