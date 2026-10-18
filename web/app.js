// app.js — tablet side of Tab Command Center: one WebSocket to the Mac, three views
// (bot / clock / media), touch controls that respond on finger-down, and a single rAF loop.

import { Bot } from './bot.js';
import { Viz } from './viz.js';

const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
};
const fmtDur = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

// ------------------------------------------------------------------ state

const S = {
  media: null, activity: { scene: 'default', label: '' }, sys: {}, idle: 0, perm: {},
  volume: null, claude: { state: 'idle', since: 0 }, calendar: null, config: {},
};
let clockOffset = 0;
const serverNow = () => Date.now() + clockOffset;
let mediaRecv = performance.now();
let pausedAt = 0;
let mode = store.get('mode') || 'auto';
let shownView = null;
let connected = false;
let rtt = null;
const keyTimes = [];
let cpuHighSince = 0;

const bot = new Bot($('#bot'));
const viz = new Viz($('#viz'));
viz.style = store.get('vizStyle') || 'bars';
viz.onBeat = (lvl) => bot.onBeat(lvl);

// ------------------------------------------------------------------ connection

let ws = null, lastPong = 0, pingId = 0;
const pingSent = new Map();

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { lastPong = performance.now(); setConnected(true); };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return viz.feed(new Uint8Array(e.data));
    onMessage(JSON.parse(e.data));
  };
  ws.onclose = () => { ws = null; setConnected(false); setTimeout(connect, 600); };
  ws.onerror = () => ws && ws.close();
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

setInterval(() => {
  if (!ws || ws.readyState !== 1) return;
  if (performance.now() - lastPong > 5000) return ws.close(); // dead link → reconnect fast
  const id = ++pingId;
  pingSent.set(id, performance.now());
  send({ t: 'ping', id });
}, 2000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (!ws || ws.readyState > 1)) connect();
  if (!document.hidden) requestWakeLock();
});

function setConnected(ok) {
  connected = ok;
  $('#conn').classList.toggle('hidden', ok || !!demo); // previews work offline
  renderStatus();
}

function onMessage(m) {
  if (m.t === 'hello') {
    const prevCfg = JSON.stringify(S.config);
    Object.assign(S, m.state);
    clockOffset = m.now - Date.now();
    mediaRecv = performance.now();
    if (JSON.stringify(S.config) !== prevCfg) fetchWeather();
    renderMediaMeta(true);
    renderVolume();
    renderPerms();
    renderCalendar();
    renderClaude(null);
  } else if (m.t === 'patch') {
    const prev = S[m.k];
    S[m.k] = m.v;
    onPatch(m.k, prev);
  } else if (m.t === 'pong') {
    const t0 = pingSent.get(m.id);
    pingSent.delete(m.id);
    lastPong = performance.now();
    if (t0) {
      rtt = lastPong - t0;
      clockOffset = m.now - (Date.now() - rtt / 2);
    }
    renderStatus();
  } else if (m.t === 'k') {
    keyTimes.push(performance.now());
    bot.onKey();
  }
}

function onPatch(k, prev) {
  if (k === 'media') {
    mediaRecv = performance.now();
    if (prev && prev.playing && !(S.media && S.media.playing)) pausedAt = performance.now();
    renderMediaMeta(!prev || !S.media || prev.title !== S.media.title || prev.art !== S.media.art);
  } else if (k === 'idle') {
    const c = idleCfg();
    if (prev >= c.sleep && S.idle < 5) {
      bot.react('wake');
      toast(`👋 Welcome back, ${S.config.name || 'friend'}!`);
    }
  } else if (k === 'sys') {
    const wasCharging = prev && prev.batt && prev.batt.plugged;
    if (S.sys.batt && S.sys.batt.plugged && prev && prev.batt && !wasCharging) {
      bot.react('charge');
      toast('⚡ Charging');
    }
  } else if (k === 'claude') renderClaude(prev);
  else if (k === 'volume') renderVolume();
  else if (k === 'perm') renderPerms();
  else if (k === 'calendar') renderCalendar();
  else if (k === 'config') fetchWeather();
}

// ------------------------------------------------------------------ derived state

const idleCfg = () => Object.assign({ bored: 90, sleep: 300 }, S.config.idle || {});

function idleState() {
  if (S.media && S.media.playing) return 'active'; // watching/listening is not idle
  const c = idleCfg();
  return S.idle >= c.sleep ? 'sleep' : S.idle >= c.bored ? 'bored' : 'active';
}

function mediaElapsed() {
  const m = S.media;
  if (!m) return 0;
  const e = m.elapsed + (m.playing ? ((performance.now() - mediaRecv) / 1000) * (m.rate || 1) : 0);
  return m.duration ? Math.min(e, m.duration) : e;
}

function kpm() {
  const cutoff = performance.now() - 60000;
  while (keyTimes.length && keyTimes[0] < cutoff) keyTimes.shift();
  return keyTimes.length;
}

// Preview any scene without switching apps: http://<mac>:8765/?demo=focus (surf, funtime, code, music, chat, sleep)
const params = new URLSearchParams(location.search);
const demo = params.get('demo');
if (params.has('still')) document.documentElement.classList.add('still'); // screenshots: no CSS fades
const DEMO_LABELS = { focus: 'LeetCode', funtime: 'Netflix', surf: 'Chrome', code: 'Cursor', music: 'Spotify', chat: 'WhatsApp' };
const demoSince = Date.now() - 754000;
if (demo === 'media') {
  const fake = () => {
    if (S.media) return;
    S.media = { title: 'Lofi beats to code to', artist: 'Lofi Girl', album: '', app: 'Chrome', playing: true, duration: 3600, elapsed: 754, rate: 1, art: null };
    mediaRecv = performance.now();
    if (shownView) renderMediaMeta(true);
  };
  fake();
  setInterval(fake, 200);
}
const activity = () => (demo && demo !== 'media'
  ? { scene: demo, label: DEMO_LABELS[demo] || '', app: 'Demo', host: demo === 'surf' ? 'github.com' : '', since: demoSince + clockOffset }
  : S.activity || {});

function botState() {
  let scene = activity().scene || 'default';
  const idle = idleState();
  const m = S.media;
  if (idle === 'sleep' || demo === 'sleep') scene = 'sleep';
  else if (m && m.playing && /Spotify|Music|Podcasts/.test(m.app) && scene !== 'focus' && scene !== 'funtime') scene = 'music';
  const cpu = S.sys.cpu || 0;
  if (cpu >= 85) cpuHighSince = cpuHighSince || performance.now();
  else cpuHighSince = 0;
  const b = S.sys.batt;
  return {
    scene,
    bored: idle === 'bored',
    stress: cpuHighSince > 0 && performance.now() - cpuHighSince > 6000,
    lowBatt: !!(b && b.pct <= 20 && !b.plugged),
    claude: S.claude.state,
    playing: !!(m && m.playing),
  };
}

function autoView() {
  const m = S.media;
  if (m && (m.playing || performance.now() - pausedAt < 25000)) return 'media';
  if (idleState() === 'sleep') return 'clock';
  return 'bot';
}

const currentView = () => (mode === 'auto' ? autoView() : mode === 'media' && !S.media ? 'bot' : mode);

// ------------------------------------------------------------------ views

function applyView(v) {
  const first = shownView === null;
  shownView = v;
  document.body.dataset.view = v;
  bot.setView(v, first);
  if (v === 'media') requestAnimationFrame(() => viz.resize(dpr()));
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 22 ? 'Good evening' : 'Good night';
}

let bannerKey = '';
function renderBanner(st) {
  const a = activity();
  const name = S.config.name || 'friend';
  let head = '', sub = '', cls = '', badge = false;
  if (st.scene === 'sleep') {
    head = 'Shh… sleeping';
    sub = `Idle for ${fmtDur(S.idle)}`;
  } else if (st.bored) {
    head = 'Anyone there?';
    sub = `Idle for ${fmtDur(S.idle)}`;
  } else {
    switch (st.scene) {
      case 'surf': head = 'Surfing the web'; sub = a.host ? a.host.replace(/^www\./, '') : a.app; break;
      case 'focus': head = 'FOCUS MODE'; badge = true; cls = 'focus'; sub = `${a.label} · ${fmtTime((serverNow() - a.since) / 1000)}`; break;
      case 'funtime': head = 'Fun time!'; cls = 'fun'; sub = a.label + (st.playing ? ' · enjoy the show 🍿' : ''); break;
      case 'code': { const k = kpm(); head = 'In the zone'; sub = a.label + (k ? ` · ${k} keys/min` : ''); break; }
      case 'music': head = 'Vibing'; sub = (S.media && S.media.title) || a.label; break;
      case 'chat': head = 'Chatting'; sub = a.label; break;
      default: head = `${greeting()}, ${name}`; sub = a.app ? `On ${a.app}` : '';
    }
  }
  if (S.claude.state === 'thinking' && st.scene !== 'sleep' && !sub) sub = 'Claude is working…';
  const key = head + '|' + cls;
  const el = $('#banner');
  if (key !== bannerKey) {
    bannerKey = key;
    el.className = 'banner ' + cls;
    void el.offsetWidth;
    el.classList.add('in');
    $('#b-head').textContent = head;
    $('#b-badge').classList.toggle('hidden', !badge);
  }
  const subEl = $('#b-sub');
  if (subEl.textContent !== sub) subEl.textContent = sub;
}

function renderStats(st) {
  const chips = [];
  if (S.sys.cpu != null) chips.push([`CPU <b>${S.sys.cpu}%</b>`, st.stress]);
  const b = S.sys.batt;
  if (b) chips.push([`${b.plugged ? '⚡' : '🔋'} <b>${b.pct}%</b>`, st.lowBatt]);
  if (st.scene === 'code' || st.scene === 'focus') chips.push([`⌨ <b>${kpm()}</b>/min`, false]);
  const html = chips.map(([h, w]) => `<span class="chip${w ? ' warn' : ''}">${h}</span>`).join('');
  const el = $('#b-stats');
  if (el.innerHTML !== html) el.innerHTML = html;
}

// ------------------------------------------------------------------ clock & weather & calendar

let lastSecond = -1;
function renderClock() {
  const d = new Date();
  const s = d.getSeconds();
  if (s === lastSecond) return;
  lastSecond = s;
  const h24 = d.getHours();
  const use24 = !!S.config.clock24;
  const h = use24 ? pad(h24) : String(h24 % 12 || 12);
  const hm = `${h}:${pad(d.getMinutes())}`;
  const ampm = use24 ? '' : h24 >= 12 ? 'PM' : 'AM';
  $('#b-hm').textContent = hm;
  $('#b-ampm').textContent = ampm;
  $('#b-date').textContent = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  const digits = [...hm].map((c) => (c === ':' ? '<span class="colon">:</span>' : `<span class="d">${c}</span>`)).join('');
  const cHm = $('#c-hm');
  if (cHm.dataset.v !== hm) {
    cHm.dataset.v = hm;
    cHm.innerHTML = digits;
  }
  $('#c-ampm').textContent = ampm;
  $('#c-date').textContent = d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  const bar = $('#c-sec');
  if (s === 0) {
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(0)';
    void bar.offsetWidth;
    bar.style.transition = '';
  } else bar.style.transform = `scaleX(${s / 59})`;
  if (s % 30 === 0) renderCalendar();
}

const WMO = {
  0: ['☀️', 'Clear sky'], 1: ['🌤️', 'Mostly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Overcast'],
  45: ['🌫️', 'Foggy'], 48: ['🌫️', 'Foggy'], 51: ['🌦️', 'Light drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌧️', 'Heavy drizzle'],
  61: ['🌧️', 'Light rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'], 71: ['🌨️', 'Light snow'], 73: ['🌨️', 'Snow'],
  75: ['❄️', 'Heavy snow'], 80: ['🌦️', 'Showers'], 81: ['🌧️', 'Showers'], 82: ['⛈️', 'Violent showers'],
  95: ['⛈️', 'Thunderstorm'], 96: ['⛈️', 'Thunderstorm'], 99: ['⛈️', 'Thunderstorm'],
};
const AQI = [[50, '#5CF0A0', 'Good'], [100, '#FFD166', 'Moderate'], [150, '#FF9F45', 'Unhealthy (sensitive)'],
  [200, '#FF5C5C', 'Unhealthy'], [300, '#B57CFF', 'Very unhealthy'], [1e9, '#A0404F', 'Hazardous']];
let weather = null;

async function fetchWeather() {
  const L = S.config.location;
  if (!L) return;
  const q = `latitude=${L.lat}&longitude=${L.lon}&timezone=auto`;
  try {
    const [w, a] = await Promise.all([
      fetch(`https://api.open-meteo.com/v1/forecast?${q}&current=temperature_2m,apparent_temperature,weather_code,is_day,relative_humidity_2m&daily=temperature_2m_max,temperature_2m_min&forecast_days=1`).then((r) => r.json()),
      fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}&current=us_aqi,pm2_5`).then((r) => r.json()).catch(() => null),
    ]);
    const c = w.current;
    weather = {
      place: L.name, temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature),
      code: c.weather_code, day: c.is_day, hum: c.relative_humidity_2m,
      hi: Math.round(w.daily.temperature_2m_max[0]), lo: Math.round(w.daily.temperature_2m_min[0]),
      aqi: a && a.current ? Math.round(a.current.us_aqi) : null,
    };
    renderWeather();
  } catch {
    /* offline — keep the last reading */
  }
}
setInterval(fetchWeather, 15 * 60 * 1000);

function renderWeather() {
  if (!weather) return;
  const w = weather;
  let [ic, cond] = WMO[w.code] || ['🌡️', ''];
  if (!w.day && w.code <= 1) ic = '🌙';
  const aq = w.aqi != null ? AQI.find((x) => w.aqi <= x[0]) : null;
  const aqiChip = aq ? `<span class="aqi" style="background:${aq[1]}">AQI ${w.aqi}</span>` : '';
  const chip = $('#b-weather');
  chip.innerHTML = `<span>${ic}</span><b>${w.temp}°</b><span class="muted">${w.place}</span>${aqiChip}`;
  chip.classList.remove('hidden');
  const card = $('#c-weather');
  card.innerHTML = `<div class="w-top"><div class="w-ic">${ic}</div><div><div class="w-temp">${w.temp}°</div><div class="w-cond">${cond} · ${w.place}</div></div></div>
    <div class="w-row"><span>H <b>${w.hi}°</b> · L <b>${w.lo}°</b></span><span>Feels <b>${w.feels}°</b></span><span>💧 <b>${w.hum}%</b></span></div>
    ${aq ? `<div class="w-row"><span>Air quality</span><span><span class="aqi" style="background:${aq[1]}">${w.aqi} · ${aq[2]}</span></span></div>` : ''}`;
  card.classList.remove('hidden');
}

const remindedEvents = new Set();
function renderCalendar() {
  const card = $('#c-cal');
  const now = Date.now();
  const evs = (S.calendar || []).filter((e) => e.end > now && !e.allDay);
  if (!evs.length) return card.classList.add('hidden');
  const e = evs[0];
  const mins = Math.round((e.start - now) / 60000);
  const at = new Date(e.start).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: !S.config.clock24 });
  const when = mins <= 0 ? 'Happening now' : mins < 60 ? `In ${mins} min` : mins < 24 * 60 ? `Today · ${at}` : at;
  const more = evs[1] ? `Then ${evs[1].title}` : '';
  card.innerHTML = `<div class="cal-when">${when}</div><div class="cal-title"></div><div class="cal-more"></div>`;
  card.querySelector('.cal-title').textContent = e.title || 'Event';
  card.querySelector('.cal-more').textContent = more;
  card.classList.remove('hidden');
  const key = e.title + e.start;
  if (mins > 0 && mins <= 5 && !remindedEvents.has(key)) {
    remindedEvents.add(key);
    toast(`⏰ ${e.title} in ${mins} min`);
    bot.react('greet');
  }
}

// ------------------------------------------------------------------ media

let artUrl = null;
function renderMediaMeta(full) {
  const m = S.media;
  document.body.classList.toggle('playing', !!(m && m.playing));
  $('#v-media').classList.toggle('playing', !!(m && m.playing));
  if (!full) return;
  $('#m-title').textContent = m ? m.title : 'Nothing playing';
  $('#m-artist').textContent = m ? m.artist || m.album : '';
  $('#m-app').textContent = m ? m.app : '';
  $('#m-dur').textContent = m && m.duration ? fmtTime(m.duration) : '';
  loadArt(m && m.art);
}

function loadArt(url) {
  if (url === artUrl) return;
  artUrl = url;
  const wrap = $('#m-artwrap'), img = $('#m-art');
  if (!url) {
    wrap.classList.add('empty');
    wrap.classList.remove('wide');
    setAccent([92, 242, 255]);
    return;
  }
  const im = new Image();
  im.onload = () => {
    if (artUrl !== url) return;
    img.src = url;
    wrap.classList.remove('empty');
    wrap.classList.toggle('wide', im.naturalWidth / im.naturalHeight > 1.25);
    setAccent(extractAccent(im));
  };
  im.src = url;
}

function extractAccent(im) {
  const c = document.createElement('canvas');
  c.width = c.height = 24;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(im, 0, 0, 24, 24);
  const d = x.getImageData(0, 0, 24, 24).data;
  const px = [];
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    px.push([(mx - mn) * mx, r, g, b]);
  }
  px.sort((a, b) => b[0] - a[0]);
  const top = px.slice(0, 40);
  let r = 0, g = 0, b = 0;
  for (const p of top) { r += p[1]; g += p[2]; b += p[3]; }
  r /= top.length; g /= top.length; b /= top.length;
  const mx = Math.max(r, g, b, 1);
  if (top[0][0] < 2500) return [92, 242, 255]; // grey artwork → default accent
  const k = 235 / mx;
  return [r, g, b].map((v) => Math.round(Math.min(255, v * k)));
}

function setAccent(c) {
  document.documentElement.style.setProperty('--acc', c.join(','));
  // second colour: same hue family, rotated toward pink for a lively gradient
  const c2 = [Math.min(255, c[2] * 0.4 + 200), Math.round(c[0] * 0.35 + 70), Math.min(255, c[1] * 0.5 + 150)];
  viz.setColors(c, c2.map(Math.round));
}

let seekDrag = null;
let lastTimeText = '';
function renderProgress() {
  const m = S.media;
  if (!m || shownView !== 'media') return;
  const el = seekDrag != null ? seekDrag * (m.duration || 0) : mediaElapsed();
  const r = m.duration ? Math.min(1, el / m.duration) : 0;
  $('#m-fill').style.transform = `translateY(-50%) scaleX(${r})`;
  $('#m-knob').style.left = `${r * 100}%`;
  const txt = fmtTime(el);
  if (txt !== lastTimeText) {
    lastTimeText = txt;
    $('#m-el').textContent = txt;
  }
}

function optimistic(fn) {
  if (!S.media) return;
  const el = mediaElapsed();
  S.media = Object.assign({}, S.media, { elapsed: el });
  fn(S.media);
  mediaRecv = performance.now();
  renderMediaMeta(false);
}

const actions = {
  toggle() {
    const wasPlaying = S.media && S.media.playing;
    optimistic((m) => { m.playing = !m.playing; m.rate = m.playing ? 1 : 0; });
    if (wasPlaying) pausedAt = performance.now();
    send({ t: 'cmd', a: 'toggle' });
  },
  prev() { send({ t: 'cmd', a: 'prev' }); },
  next() { send({ t: 'cmd', a: 'next' }); },
  back() { optimistic((m) => { m.elapsed = Math.max(0, m.elapsed - 10); }); send({ t: 'cmd', a: 'skip', v: -10 }); },
  fwd() { optimistic((m) => { m.elapsed = Math.min(m.duration || 1e9, m.elapsed + 10); }); send({ t: 'cmd', a: 'skip', v: 10 }); },
  mute() {
    const muted = !(S.volume && S.volume.muted);
    S.volume = Object.assign({ level: 50 }, S.volume, { muted });
    renderVolume();
    send({ t: 'cmd', a: 'mute', v: muted });
  },
};

// Buttons fire on finger-DOWN for zero perceived delay.
document.querySelectorAll('[data-act]').forEach((b) => {
  b.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    b.classList.add('down');
    actions[b.dataset.act]();
    showDock(false);
  });
  const up = () => b.classList.remove('down');
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
  b.addEventListener('pointerleave', up);
});

function slider(el, onMove, onEnd) {
  const ratio = (e) => {
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    el.classList.add('drag');
    onMove(ratio(e));
  });
  el.addEventListener('pointermove', (e) => { if (el.classList.contains('drag')) onMove(ratio(e)); });
  const end = (e) => {
    if (!el.classList.contains('drag')) return;
    el.classList.remove('drag');
    onEnd(ratio(e));
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

slider($('#m-bar'), (r) => { seekDrag = r; }, (r) => {
  seekDrag = null;
  if (!S.media || !S.media.duration) return;
  const v = r * S.media.duration;
  optimistic((m) => { m.elapsed = v; });
  send({ t: 'cmd', a: 'seek', v });
});

let volDragging = false, volSentAt = 0, volTimer = null;
function sendVol(level) {
  clearTimeout(volTimer);
  const wait = 60 - (performance.now() - volSentAt);
  if (wait <= 0) {
    volSentAt = performance.now();
    send({ t: 'cmd', a: 'vol', v: level });
  } else volTimer = setTimeout(() => sendVol(level), wait);
}
slider($('#m-vol'), (r) => {
  volDragging = true;
  S.volume = { level: Math.round(r * 100), muted: false };
  renderVolume(true);
  sendVol(S.volume.level);
}, (r) => {
  volDragging = false;
  sendVol(Math.round(r * 100));
});

function renderVolume(force) {
  if (volDragging && !force) return;
  const v = S.volume;
  const r = v ? (v.muted ? 0 : v.level / 100) : 0;
  const el = $('#m-vol');
  el.querySelector('.fill').style.transform = `translateY(-50%) scaleX(${r})`;
  el.querySelector('.knob').style.left = `${r * 100}%`;
  $('.m-volume').classList.toggle('muted-vol', !!(v && v.muted));
}

$('#viz').addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  const style = viz.cycle();
  store.set('vizStyle', style);
  const hint = $('#viz-hint');
  hint.textContent = `Style: ${style}`;
  clearTimeout(hint._t);
  hint._t = setTimeout(() => (hint.textContent = ''), 1500);
});

// ------------------------------------------------------------------ overlay: claude, toast, dock, hints

let claudeTimer = null;
function renderClaude(prev) {
  const el = $('#claude');
  const c = S.claude;
  clearTimeout(claudeTimer);
  el.className = 'claude';
  if (c.state === 'thinking') {
    el.innerHTML = '<span class="sp">✻</span><span>Claude is cooking… <b class="ct"></b></span>';
  } else if (c.state === 'attention') {
    el.classList.add('attention');
    el.innerHTML = '<span>✋</span><span>Claude needs you</span>';
    if (prev && prev.state !== 'attention') bot.react('greet');
  } else if (c.state === 'done' && serverNow() - c.since < 10000) {
    el.classList.add('done');
    el.innerHTML = '<span>✓</span><span>Claude finished</span>';
    if (prev && prev.state === 'thinking') bot.react('celebrate');
    claudeTimer = setTimeout(() => el.classList.add('hidden'), 8000);
  } else {
    el.classList.add('hidden');
  }
}

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

let dockTimer = null;
function showDock(sticky) {
  $('#dock').classList.add('show');
  clearTimeout(dockTimer);
  dockTimer = setTimeout(() => $('#dock').classList.remove('show'), sticky ? 8000 : 4000);
}

function renderDock() {
  document.querySelectorAll('.dock [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
}

document.querySelectorAll('.dock [data-mode]').forEach((b) => {
  b.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    b.classList.add('down');
    mode = b.dataset.mode;
    store.set('mode', mode);
    renderDock();
    showDock(false);
  });
  b.addEventListener('pointerup', () => b.classList.remove('down'));
  b.addEventListener('pointerleave', () => b.classList.remove('down'));
});

function renderStatus() {
  const el = $('#status');
  el.classList.toggle('ok', connected);
  el.querySelector('span').textContent = connected ? (rtt != null ? `${Math.round(rtt)} ms` : 'live') : 'offline';
}

function renderPerms() {
  const p = S.perm, hints = [];
  if (p.audio === false) hints.push('🎧 Live equalizer off: allow Terminal in Screen & System Audio Recording');
  if (p.url === false) hints.push('🌐 Allow Terminal to control your browser (Automation) for site reactions');
  if (p.keys === false) hints.push('⌨ Allow Terminal in Input Monitoring for typing reactions');
  if (p.media === false) hints.push('🎵 Install media-control on the Mac');
  $('#hints').innerHTML = hints.map((h) => `<div>${h}</div>`).join('');
}

// ------------------------------------------------------------------ global touch: poke the bot, swipe views

let touchStart = null;
document.addEventListener('pointerdown', (e) => {
  enterFullscreen();
  touchStart = { x: e.clientX, y: e.clientY, t: performance.now() };
  showDock(true);
  if (bot.hit(e.clientX, e.clientY)) bot.poke();
});
document.addEventListener('pointerup', (e) => {
  if (!touchStart) return;
  const dx = e.clientX - touchStart.x, dy = e.clientY - touchStart.y;
  if (Math.abs(dx) > 90 && Math.abs(dy) < 70 && performance.now() - touchStart.t < 600) {
    const order = S.media ? ['bot', 'clock', 'media'] : ['bot', 'clock'];
    const i = order.indexOf(shownView);
    mode = order[(i + (dx < 0 ? 1 : order.length - 1)) % order.length];
    store.set('mode', mode);
    renderDock();
  }
  touchStart = null;
});

function enterFullscreen() {
  const standalone = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
  if (!standalone && !document.fullscreenElement && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }
  requestWakeLock();
}

let wakeLock = null;
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || (wakeLock && !wakeLock.released)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* needs secure context */ }
}

// ------------------------------------------------------------------ loop

const dpr = () => Math.min(window.devicePixelRatio || 1, S.config.dpr || 2);
function resize() {
  bot.resize(window.innerWidth, window.innerHeight, dpr());
  viz.resize(dpr());
}
window.addEventListener('resize', resize);

let last = performance.now();
let lastSlow = -Infinity;
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const st = botState();
  const view = currentView();
  if (view !== shownView) applyView(view);
  document.body.dataset.bg = view === 'media' ? 'media' : view === 'clock' ? 'sleep' : st.scene;

  bot.setState(st);
  bot.frame(dt);
  bot.draw();
  viz.update(dt, now / 1000, !!(S.media && S.media.playing));
  if (shownView === 'media') {
    viz.draw(now / 1000);
    renderProgress();
  }

  if (now - lastSlow > 250) {
    lastSlow = now;
    renderClock();
    renderBanner(st);
    renderStats(st);
    const ct = document.querySelector('#claude .ct');
    if (ct) ct.textContent = fmtTime((serverNow() - S.claude.since) / 1000);
  }
  if (tickMode) setTimeout(() => loop(performance.now()), 16);
  else requestAnimationFrame(loop);
}
const tickMode = params.has('tick'); // headless screenshots: drive frames with timers instead of rAF

resize();
for (let i = 0, n = +params.get('warm') * 60 || 0; i < n; i++) { bot.setState(botState()); bot.frame(1 / 60); }
renderDock();
renderStatus();
renderClock();
if (S.media) renderMediaMeta(true);
connect();
requestAnimationFrame(loop);
if (window.isSecureContext && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (params.has('debug')) setInterval(() => { document.body.dataset.debug = JSON.stringify({ view: shownView, W: bot.W, H: bot.H, X: [bot.sp.X.x | 0, bot.sp.X.t | 0], Y: [bot.sp.Y.x | 0, bot.sp.Y.t | 0], S: [+bot.sp.Sc.x.toFixed(2), +bot.sp.Sc.t.toFixed(2)], frames: bot.t.toFixed(2), mode, media: !!S.media, cur: currentView(), auto: autoView() }); }, 300);
