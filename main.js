/* main.js — UI, map, walking, audio graph for Fes Designer */
(function () {
'use strict';
const A = window.Acoustics, S = window.Sounds;
const $ = id => document.getElementById(id);
const KEY = 'fes-designer';
const WALK = 1.3; // m/s

// ------------------------------------------------------------------ state
const defaults = {
  venue: 'fes', system: 'lineL', ground: 'grass', region: 'tokyo', month: 7, tod: 'evening', weather: 'sunny',
  windDir: 'toAudience', headMode: 'auto', progress: 0, speed: 3, volume: 0, comp: 0.5,
  heat: true, amb: true, steps: true, dark: true, bypass: false, source: 'demo', pos: {},
};
let st;
try { st = Object.assign({}, defaults, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { st = Object.assign({}, defaults); }
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* storage unavailable */ } }, 200);
}
document.documentElement.classList.toggle('dark', st.dark);

// ------------------------------------------------------------------ selects
function fill(id, table, fmt) {
  const el = $(id);
  el.innerHTML = '';
  for (const [k, v] of Object.entries(table)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = fmt ? fmt(k, v) : v.name;
    el.appendChild(o);
  }
}
fill('venue', A.VENUES); fill('system', A.SYSTEMS); fill('ground', A.GROUNDS, (k, v) => `${v.name} (σ=${v.sigma})`);
fill('region', A.REGIONS); fill('tod', A.TIMES); fill('weather', A.WEATHER); fill('windDir', A.WIND_DIRS);
fill('month', Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, { name: `${i + 1}月` }])));
const sceneKeys = ['venue', 'system', 'ground', 'region', 'month', 'tod', 'weather', 'windDir'];
for (const k of sceneKeys) {
  const el = $(k);
  el.value = st[k];
  if (el.value === '') { st[k] = defaults[k]; el.value = st[k]; }
  el.addEventListener('change', () => { st[k] = k === 'month' ? +el.value : el.value; save(); rebuild(); });
}
$('headMode').value = st.headMode;
$('headMode').addEventListener('change', e => { st.headMode = e.target.value; save(); });
$('speed').value = st.speed;
$('speed').addEventListener('change', e => { st.speed = +e.target.value; save(); });
$('volume').value = st.volume;
$('volume').addEventListener('input', e => { st.volume = +e.target.value; save(); applyMaster(); });
$('bypass').checked = st.bypass;
$('bypass').addEventListener('change', e => { st.bypass = e.target.checked; save(); applyBypass(); });

// menu
const menu = $('menu');
$('menuBtn').addEventListener('click', e => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
  $('menuBtn').setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
$('optDark').checked = st.dark;
$('optDark').addEventListener('change', e => { st.dark = e.target.checked; document.documentElement.classList.toggle('dark', st.dark); save(); drawMap(); drawFR(); });
$('optHeat').checked = st.heat;
$('optHeat').addEventListener('change', e => { st.heat = e.target.checked; save(); requestMap(); drawMap(); });
$('optAmb').checked = st.amb;
$('optAmb').addEventListener('change', e => { st.amb = e.target.checked; save(); updateAmbient(); });
$('optSteps').checked = st.steps;
$('optSteps').addEventListener('change', e => { st.steps = e.target.checked; save(); });
$('optComp').value = st.comp;
const showComp = () => { $('compVal').textContent = Number(st.comp).toFixed(2); };
showComp();
$('optComp').addEventListener('input', e => { st.comp = +e.target.value; showComp(); save(); updateLevel(); });

// ------------------------------------------------------------------ scene & route
let scene = null, sceneVersion = 0, sr = 48000;
let route = [], routeLen = 1, cum = [0];
const listener = { x: 0, y: 0, heading: -Math.PI / 2 };
let irInfo = null;

const irWorker = new Worker('ir-worker.js');
const mapWorker = new Worker('ir-worker.js');

function defaultStart(sc) { const [, , x1, y1] = sc.bbox; return [x1 + 230, y1 + 170]; }
function defaultSeat(sc) { return [10, Math.max(14, sc.venue.foh * 0.8)]; }
function validStart(sc, p) { return p && !A.insideVenue(sc, p[0], p[1]) && Math.hypot(p[0], p[1]) < 2500; }
function validSeat(sc, p) { return p && A.inAudience(sc, p[0], p[1]); }

function rebuild() {
  scene = A.buildScene(st, sr);
  sceneVersion++;
  const pv = st.pos[st.venue] || {};
  if (!validStart(scene, pv.start)) pv.start = defaultStart(scene);
  if (!validSeat(scene, pv.seat)) pv.seat = defaultSeat(scene);
  st.pos[st.venue] = pv;
  irWorker.postMessage({ type: 'scene', scene });
  mapWorker.postMessage({ type: 'scene', scene });
  computeRoute();
  heat = null;
  fitView();
  requestMap();
  updateClimate();
  irDirty = true;
  requestIR();
  drawMap();
  save();
}

function crosses(a, b) { return A.segCrossesPoly(scene.poly, a[0], a[1], b[0], b[1]); }
function computeRoute() {
  const { start, seat } = st.pos[st.venue];
  const corners = scene.poly.map(p => {
    const dx = p[0] - scene.center[0], dy = p[1] - scene.center[1], d = Math.hypot(dx, dy);
    return [p[0] + dx / d * 20, p[1] + dy / d * 20];
  });
  let best = null;
  for (const g of scene.gates) {
    const out = [g.x + g.nx * 12, g.y + g.ny * 12], inn = [g.x - g.nx * 12, g.y - g.ny * 12];
    let path = [start];
    if (crosses(start, out)) {
      let bc = null, bl = Infinity;
      for (const c of corners) {
        if (crosses(start, c) || crosses(c, out)) continue;
        const l = Math.hypot(c[0] - start[0], c[1] - start[1]) + Math.hypot(out[0] - c[0], out[1] - c[1]);
        if (l < bl) { bl = l; bc = c; }
      }
      if (!bc) continue;
      path.push(bc);
    }
    path.push(out, inn, seat);
    let len = 0;
    for (let i = 1; i < path.length; i++) len += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    if (!best || len < best.len) best = { path, len };
  }
  if (!best) best = { path: [start, seat], len: Math.hypot(seat[0] - start[0], seat[1] - start[1]) };
  route = best.path;
  cum = [0];
  for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]));
  routeLen = cum[cum.length - 1] || 1;
  placeListener(true);
}

function routePoint(s) {
  const d = s * routeLen;
  let i = 1;
  while (i < route.length - 1 && cum[i] < d) i++;
  const a = route[i - 1], b = route[i], seg = cum[i] - cum[i - 1] || 1;
  const u = Math.min(1, Math.max(0, (d - cum[i - 1]) / seg));
  return { x: a[0] + (b[0] - a[0]) * u, y: a[1] + (b[1] - a[1]) * u, dir: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}

function targetHeading(p) {
  if (st.headMode === 'stage' || st.progress >= 0.999) return Math.atan2(-p.y, -p.x);
  return p.dir;
}
function placeListener(snap) {
  const p = routePoint(st.progress);
  listener.x = p.x; listener.y = p.y;
  if (snap) listener.heading = targetHeading(p);
  $('progress').value = Math.round(st.progress * 1000);
  updateWhere();
}

function updateWhere() {
  let w;
  if (st.progress >= 0.999) w = '🪑 座席';
  else if (scene.gates.some(g => Math.hypot(g.x - listener.x, g.y - listener.y) < 14)) w = '🚪 入場ゲート';
  else if (A.insideVenue(scene, listener.x, listener.y)) w = '🎪 場内';
  else w = '🌆 会場の外';
  $('where').textContent = w;
}

// ------------------------------------------------------------------ IR requests
let irBusy = false, irDirty = true, lastIR = null, irId = 0, lastIRTime = 0;
function requestIR() {
  if (irBusy || !scene) return;
  const now = performance.now();
  if (lastIR && lastIR.version === sceneVersion) {
    const moved = Math.hypot(listener.x - lastIR.x, listener.y - lastIR.y);
    let dh = Math.abs(listener.heading - lastIR.heading) % (2 * Math.PI);
    if (dh > Math.PI) dh = 2 * Math.PI - dh;
    if (moved < 0.4 && dh < 0.07 && !irDirty) return;
    if (now - lastIRTime < 200) { setTimeout(requestIR, 220 - (now - lastIRTime)); return; }
  }
  irDirty = false;
  irBusy = true;
  lastIRTime = now;
  lastIR = { x: listener.x, y: listener.y, heading: listener.heading, version: sceneVersion };
  const N = sr > 50000 ? 262144 : 131072;
  irWorker.postMessage({ type: 'ir', id: ++irId, version: sceneVersion, x: listener.x, y: listener.y, z: A.LISTENER_Z,
    hx: Math.cos(listener.heading), hy: Math.sin(listener.heading), N });
}
irWorker.onmessage = e => {
  const m = e.data;
  irBusy = false;
  if (m.version === sceneVersion) {
    irInfo = m.info;
    applyIR(m.chans);
    updateListenerInfo();
    updateLevel();
    updateAmbient();
    drawFR();
  }
  requestIR();
};

// ------------------------------------------------------------------ map
const canvas = $('map'), ctx2 = canvas.getContext('2d');
let view = { x0: 0, y0: 0, x1: 1, y1: 1, s: 1, ox: 0, oy: 0 };
let heat = null, mapId = 0, mapTimer = 0;

function fitView() {
  const pts = scene.poly.concat(route);
  let x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0]));
  let y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
  const m = Math.max(40, 0.08 * Math.max(x1 - x0, y1 - y0));
  view.wx0 = x0 - m; view.wx1 = x1 + m; view.wy0 = y0 - m; view.wy1 = y1 + m;
  layout();
}
function layout() {
  const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(10, Math.round(r.width * dpr)); canvas.height = Math.max(10, Math.round(r.height * dpr));
  const W = canvas.width, H = canvas.height;
  const s = Math.min(W / (view.wx1 - view.wx0), H / (view.wy1 - view.wy0));
  view.s = s;
  view.ox = (W - (view.wx1 - view.wx0) * s) / 2 - view.wx0 * s;
  view.oy = (H - (view.wy1 - view.wy0) * s) / 2 - view.wy0 * s;
  view.x0 = -view.ox / s; view.x1 = (W - view.ox) / s; view.y0 = -view.oy / s; view.y1 = (H - view.oy) / s;
  view.dpr = dpr;
}
const W2S = (x, y) => [view.ox + x * view.s, view.oy + y * view.s];
const S2W = (px, py) => [(px - view.ox) / view.s, (py - view.oy) / view.s];

function requestMap() {
  if (!st.heat || !scene) return;
  clearTimeout(mapTimer);
  mapTimer = setTimeout(() => {
    const nx = 120, ny = Math.max(10, Math.round(nx * (view.y1 - view.y0) / (view.x1 - view.x0)));
    $('mapBusy').hidden = false;
    mapWorker.postMessage({ type: 'map', id: ++mapId, version: sceneVersion, x0: view.x0, y0: view.y0, x1: view.x1, y1: view.y1, nx, ny });
  }, 150);
}
mapWorker.onmessage = e => {
  const m = e.data;
  if (m.id !== mapId || m.version !== sceneVersion) return;
  $('mapBusy').hidden = true;
  const c = document.createElement('canvas');
  c.width = m.nx; c.height = m.ny;
  const g = c.getContext('2d'), img = g.createImageData(m.nx, m.ny);
  for (let i = 0; i < m.data.length; i++) {
    const [r, gg, b] = colormap((m.data[i] - 40) / 70);
    img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 150;
  }
  g.putImageData(img, 0, 0);
  heat = { canvas: c, x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1 };
  drawLegend();
  drawMap();
};

// perceptual-ish colour ramp (dark blue -> purple -> orange -> yellow)
const RAMP = [[13, 8, 135], [84, 2, 163], [139, 10, 165], [185, 50, 137], [219, 92, 104], [244, 136, 73], [254, 188, 43], [240, 249, 33]];
function colormap(t) {
  t = Math.min(1, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(t)), u = t - i;
  return RAMP[i].map((v, k) => Math.round(v + (RAMP[i + 1][k] - v) * u));
}
function drawLegend() {
  const lg = $('legend');
  lg.hidden = !st.heat;
  if (!st.heat) return;
  if (!lg.firstChild) {
    lg.innerHTML = '<div>音圧 dB(A) (FOH = 100)</div><canvas width="180" height="10"></canvas><div class="row"><span>40</span><span>60</span><span>80</span><span>110</span></div>';
    const g = lg.querySelector('canvas').getContext('2d');
    for (let x = 0; x < 180; x++) { const [r, gg, b] = colormap(x / 179); g.fillStyle = `rgb(${r},${gg},${b})`; g.fillRect(x, 0, 1, 10); }
  }
}

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function drawMap() {
  if (!scene) return;
  const g = ctx2, W = canvas.width, H = canvas.height, dpr = view.dpr || 1;
  const dark = st.dark;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = scene.ground.color;
  g.fillRect(0, 0, W, H);
  g.fillStyle = dark ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.25)';
  g.fillRect(0, 0, W, H);
  g.setTransform(view.s, 0, 0, view.s, view.ox, view.oy);
  const px = 1 / view.s * dpr; // one css pixel in world units

  const dr = scene.draw;
  if (dr.sea) { g.fillStyle = '#1d4a73'; g.fillRect(dr.sea[2], dr.sea[1], dr.sea[0] - dr.sea[2], dr.sea[3] - dr.sea[1]); }
  if (st.heat && heat) {
    g.imageSmoothingEnabled = true;
    g.drawImage(heat.canvas, heat.x0, heat.y0, heat.x1 - heat.x0, heat.y1 - heat.y0);
  }
  // venue floor
  g.beginPath(); scene.poly.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath();
  g.fillStyle = 'rgba(255,255,255,0.05)'; g.fill();
  // audience
  const au = scene.audience;
  g.setLineDash([6 * px, 5 * px]); g.lineWidth = 1.2 * px; g.strokeStyle = 'rgba(255,255,255,0.45)';
  g.beginPath();
  if (au.type === 'rect') g.rect(au.x0, au.y0, au.x1 - au.x0, au.y1 - au.y0);
  else g.ellipse(au.cx, au.cy, au.rx, au.ry, 0, 0, 2 * Math.PI);
  g.stroke(); g.setLineDash([]);
  // surroundings
  for (const t of dr.trees) { g.strokeStyle = '#3f8f3a'; g.lineWidth = 6 * px; g.beginPath(); g.moveTo(t[0], t[1]); g.lineTo(t[2], t[3]); g.stroke(); }
  for (const r of dr.ridges) { g.strokeStyle = '#8a6a44'; g.lineWidth = 10 * px; g.beginPath(); g.moveTo(r[0], r[1]); g.lineTo(r[2], r[3]); g.stroke(); }
  for (const b of dr.buildings) {
    g.beginPath(); b.pts.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath();
    g.fillStyle = dark ? '#4a4d55' : '#9aa0a8'; g.fill();
    g.strokeStyle = '#222'; g.lineWidth = px; g.stroke();
    const c = b.pts.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
    label(g, `${b.h}m`, c[0], c[1], px, '#eee');
  }
  // walls / fence
  g.strokeStyle = scene.venue.kind === 'stadium' ? '#c9c4b8' : '#f0e6c8';
  g.lineWidth = (scene.venue.kind === 'stadium' ? 7 : 2.5) * px;
  for (const w of scene.walls) { g.beginPath(); g.moveTo(w.ax, w.ay); g.lineTo(w.bx, w.by); g.stroke(); }
  // stage
  const sg = scene.stage;
  g.fillStyle = '#111'; g.fillRect(sg.x0, sg.y0, sg.x1 - sg.x0, sg.y1 - sg.y0);
  g.strokeStyle = css('--accent'); g.lineWidth = 2 * px; g.strokeRect(sg.x0, sg.y0, sg.x1 - sg.x0, sg.y1 - sg.y0);
  label(g, 'STAGE', 0, (sg.y0 + sg.y1) / 2, px, '#fff');
  // FOH
  g.fillStyle = '#ddd'; g.fillRect(scene.foh[0] - 3, scene.foh[1] - 2, 6, 4);
  label(g, 'FOH', scene.foh[0], scene.foh[1] + 9 * px, px, '#fff');
  // speakers
  for (const s of scene.speakers) {
    const sz = (s.role === 'sub' ? 5 : 8) * px;
    const a = Math.atan2(s.ay, s.ax);
    g.save(); g.translate(s.x, s.y); g.rotate(a);
    g.beginPath(); g.moveTo(sz, 0); g.lineTo(-sz * 0.6, sz * 0.7); g.lineTo(-sz * 0.6, -sz * 0.7); g.closePath();
    g.fillStyle = s.role === 'sub' ? '#888' : s.role === 'tower' ? css('--accent2') : css('--accent');
    g.fill(); g.restore();
  }
  // route
  g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 2 * px; g.setLineDash([4 * px, 4 * px]);
  g.beginPath(); route.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.stroke(); g.setLineDash([]);
  const pv = st.pos[st.venue];
  marker(g, pv.start, 'S', '#2b8a3e', px);
  marker(g, pv.seat, '席', '#c2255c', px);
  // listener
  g.save(); g.translate(listener.x, listener.y); g.rotate(listener.heading);
  g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, 26 * px, -0.5, 0.5); g.closePath();
  g.fillStyle = 'rgba(255,255,255,0.25)'; g.fill();
  g.beginPath(); g.arc(0, 0, 6 * px, 0, 2 * Math.PI); g.fillStyle = '#fff'; g.fill();
  g.strokeStyle = '#000'; g.lineWidth = 1.5 * px; g.stroke();
  g.restore();
  // wind arrow and scale bar (screen space)
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cl = scene.climate, wv = cl.windDir;
  const wx = canvas.width / dpr - 50, wy = 50;
  g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 2;
  g.beginPath(); g.arc(wx, wy, 26, 0, 2 * Math.PI); g.globalAlpha = 0.25; g.fill(); g.globalAlpha = 1;
  const L = 8 + Math.min(16, cl.wind * 1.6);
  g.beginPath(); g.moveTo(wx - wv[0] * L, wy - wv[1] * L); g.lineTo(wx + wv[0] * L, wy + wv[1] * L); g.stroke();
  g.beginPath(); const ang = Math.atan2(wv[1], wv[0]);
  g.moveTo(wx + wv[0] * L, wy + wv[1] * L);
  g.lineTo(wx + wv[0] * L - 7 * Math.cos(ang - 0.5), wy + wv[1] * L - 7 * Math.sin(ang - 0.5));
  g.lineTo(wx + wv[0] * L - 7 * Math.cos(ang + 0.5), wy + wv[1] * L - 7 * Math.sin(ang + 0.5)); g.fill();
  g.font = '11px system-ui'; g.textAlign = 'center';
  g.fillText(`風 ${cl.wind.toFixed(1)} m/s`, wx, wy + 40);
  let sb = 10; const target = 100 / (view.s / dpr);
  for (const v of [10, 20, 50, 100, 200, 500, 1000]) if (v <= target) sb = v;
  const sbp = sb * view.s / dpr, bx = 14, by = canvas.height / dpr - 16;
  const lgOn = st.heat && heat;
  const byy = lgOn ? by - 62 : by;
  g.fillRect(bx, byy, sbp, 3); g.textAlign = 'left'; g.fillText(`${sb} m`, bx, byy - 5);
}
function label(g, t, x, y, px, color) {
  g.save(); g.translate(x, y); g.scale(px, px);
  g.font = '11px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = color; g.fillText(t, 0, 0); g.restore();
}
function marker(g, p, t, color, px) {
  g.beginPath(); g.arc(p[0], p[1], 11 * px, 0, 2 * Math.PI);
  g.fillStyle = color; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 2 * px; g.stroke();
  label(g, t, p[0], p[1], px, '#fff');
}

// drag start / seat, click on route
let drag = null;
canvas.addEventListener('pointerdown', e => {
  const r = canvas.getBoundingClientRect(), dpr = view.dpr;
  const [x, y] = S2W((e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr);
  const pv = st.pos[st.venue], tol = 16 * dpr / view.s;
  for (const k of ['seat', 'start']) {
    if (Math.hypot(pv[k][0] - x, pv[k][1] - y) < tol) { drag = k; canvas.setPointerCapture(e.pointerId); return; }
  }
  // nearest point on the route
  let best = null;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
    const d = Math.hypot(a[0] + dx * u - x, a[1] + dy * u - y);
    if (!best || d < best.d) best = { d, s: (cum[i - 1] + u * Math.sqrt(l2)) / routeLen };
  }
  if (best && best.d < 2 * tol) { setWalking(false); st.progress = best.s; placeListener(true); save(); requestIR(); drawMap(); }
});
canvas.addEventListener('pointermove', e => {
  if (!drag) return;
  const r = canvas.getBoundingClientRect(), dpr = view.dpr;
  const p = S2W((e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr);
  const ok = drag === 'start' ? validStart(scene, p) : validSeat(scene, p);
  if (!ok) return;
  st.pos[st.venue][drag] = p;
  computeRoute();
  drawMap();
  requestIR();
});
canvas.addEventListener('pointerup', () => {
  if (drag) { drag = null; fitView(); requestMap(); drawMap(); save(); }
});
window.addEventListener('resize', () => { if (scene) { layout(); requestMap(); drawMap(); drawFR(); } });

// ------------------------------------------------------------------ walking
let walking = false;
function setWalking(on) {
  walking = on;
  $('walkBtn').textContent = on ? '⏸ 止まる' : '🚶 歩く';
}
$('walkBtn').addEventListener('click', () => {
  if (!walking && st.progress >= 0.999) st.progress = 0;
  setWalking(!walking);
  if (walking && !audio.playing) startAudio();
});
$('resetBtn').addEventListener('click', () => { setWalking(false); st.progress = 0; placeListener(true); save(); requestIR(); drawMap(); });
$('progress').addEventListener('input', e => { setWalking(false); st.progress = +e.target.value / 1000; placeListener(false); save(); requestIR(); drawMap(); });

let lastT = performance.now(), stepAcc = 0, stepSide = 1, turbAcc = 0;
function tick(t) {
  const dt = Math.min(0.1, (t - lastT) / 1000);
  lastT = t;
  if (scene) {
    let changed = false;
    if (walking) {
      st.progress = Math.min(1, st.progress + dt * WALK * st.speed / routeLen);
      if (st.progress >= 1) { setWalking(false); save(); }
      placeListener(false);
      changed = true;
      stepAcc += dt;
      const iv = 0.55 / Math.sqrt(st.speed);
      if (stepAcc >= iv) { stepAcc = 0; playStep(); }
    }
    const p = routePoint(st.progress);
    const th = targetHeading(p);
    let d = th - listener.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) > 0.002) { listener.heading += d * Math.min(1, dt * 3); changed = true; }
    if (changed) { requestIR(); drawMap(); }
    turbAcc += dt;
    if (turbAcc > 0.15) { turbAcc = 0; turbulence(); }
  }
  requestAnimationFrame(tick);
}

// ------------------------------------------------------------------ audio
const audio = { ctx: null, playing: false, cur: null, music: null, demo: null, file: null, amb: {}, ambBufs: null, steps: null, src: null };
function buildGraph() {
  const ac = audio.ctx;
  audio.inBus = ac.createGain();
  audio.inBus.channelCount = 2; audio.inBus.channelCountMode = 'explicit'; audio.inBus.channelInterpretation = 'speakers';
  audio.wetBus = ac.createGain();
  audio.turb = ac.createGain();
  audio.shelf = ac.createBiquadFilter(); audio.shelf.type = 'highshelf'; audio.shelf.frequency.value = 2500;
  audio.ambBus = ac.createGain();
  audio.level = ac.createGain();
  audio.dry = ac.createGain();
  audio.master = ac.createGain();
  audio.limiter = ac.createDynamicsCompressor();
  audio.limiter.threshold.value = -4; audio.limiter.knee.value = 2; audio.limiter.ratio.value = 20;
  audio.limiter.attack.value = 0.002; audio.limiter.release.value = 0.2;
  audio.wetBus.connect(audio.turb).connect(audio.shelf).connect(audio.level);
  audio.ambBus.connect(audio.level);
  audio.level.connect(audio.master);
  audio.inBus.connect(audio.dry).connect(audio.master);
  audio.master.connect(audio.limiter).connect(ac.destination);
  audio.stepBus = ac.createGain();
  audio.stepBus.connect(audio.ambBus);
  // ambient loops
  for (const [k, buf] of Object.entries(audio.ambBufs)) {
    const s = ac.createBufferSource(); s.buffer = buf; s.loop = true;
    const g = ac.createGain(); g.gain.value = 0;
    s.connect(g).connect(audio.ambBus);
    s.start(0, Math.random() * buf.duration);
    audio.amb[k] = g;
  }
  applyMaster(); applyBypass();
}
async function ensureAudio() {
  if (audio.ctx) return;
  const ac = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
  audio.ctx = ac;
  $('playBtn').textContent = '… 準備中';
  audio.ambBufs = S.makeAmbient(ac);
  audio.steps = S.makeSteps(ac);
  buildGraph();
  if (ac.sampleRate !== sr) { sr = ac.sampleRate; rebuild(); }
  audio.demo = await S.renderDemo(ac.sampleRate);
}
function currentMusic() { return st.source === 'file' && audio.file ? audio.file : audio.demo; }
function startMusic() {
  if (audio.src) { try { audio.src.stop(); } catch (e) { /* already stopped */ } audio.src.disconnect(); }
  const s = audio.ctx.createBufferSource();
  s.buffer = currentMusic(); s.loop = true;
  s.connect(audio.inBus); s.start();
  audio.src = s;
}
async function startAudio() {
  await ensureAudio();
  await audio.ctx.resume();
  startMusic();
  audio.playing = true;
  $('playBtn').textContent = '■ 停止';
  irDirty = true; lastIR = null; requestIR();
  updateAmbient(); updateLevel();
}
function stopAudio() {
  if (audio.src) { try { audio.src.stop(); } catch (e) { /* already stopped */ } audio.src = null; }
  audio.playing = false;
  audio.ctx.suspend();
  $('playBtn').textContent = '▶ 再生';
}
$('playBtn').addEventListener('click', () => { if (audio.playing) stopAudio(); else startAudio(); });

function applyIR(chans) {
  if (!audio.ctx) return;
  const ac = audio.ctx;
  const buf = ac.createBuffer(4, chans[0].length, ac.sampleRate);
  chans.forEach((d, i) => buf.copyToChannel(d, i));
  const conv = ac.createConvolver();
  conv.normalize = false;
  conv.buffer = buf;
  const g = ac.createGain();
  const t = ac.currentTime, fade = 0.15;
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + fade);
  audio.inBus.connect(conv); conv.connect(g).connect(audio.wetBus);
  const old = audio.cur;
  if (old) {
    old.g.gain.cancelScheduledValues(t);
    old.g.gain.setValueAtTime(old.g.gain.value, t); old.g.gain.linearRampToValueAtTime(0, t + fade);
    setTimeout(() => { try { audio.inBus.disconnect(old.conv); } catch (e) { /* gone */ } old.conv.disconnect(); old.g.disconnect(); }, fade * 1000 + 200);
  }
  audio.cur = { conv, g };
}
function applyMaster() {
  if (!audio.ctx) return;
  audio.master.gain.setTargetAtTime(Math.pow(10, (st.volume + 12) / 20), audio.ctx.currentTime, 0.05);
}
function applyBypass() {
  if (!audio.ctx) return;
  const t = audio.ctx.currentTime;
  audio.dry.gain.setTargetAtTime(st.bypass ? 0.6 : 0, t, 0.05);
  audio.wetBus.gain.setTargetAtTime(st.bypass ? 0 : 1, t, 0.05);
  audio.ambBus.gain.setTargetAtTime(st.bypass ? 0 : 1, t, 0.05);
}
function compGain() {
  if (!irInfo) return 1;
  return Math.pow(10, -st.comp * (Math.max(30, irInfo.dBA) - 100) / 20);
}
function updateLevel() {
  if (!audio.ctx) return;
  audio.level.gain.setTargetAtTime(compGain(), audio.ctx.currentTime, 0.25);
}
const amp = L => (L > 0 ? 0.5 * Math.pow(10, (L - 100) / 20) : 0);
function ambientLevels() {
  const x = listener.x, y = listener.y, cl = scene.climate;
  const inside = A.insideVenue(scene, x, y), dA = A.distToAudience(scene, x, y);
  const stad = scene.venue.kind === 'stadium';
  const L = {};
  L.crowd = 70 - 20 * Math.log10(1 + dA / 15) - (inside ? 0 : stad ? 15 : 4);
  L.traffic = scene.env === 'urban' ? (inside ? 50 : 58) : scene.env === 'suburban' ? (inside ? 40 : 46) : 0;
  L.waves = scene.env === 'seaside' ? 52 : 0;
  L.wind = 28 + 40 * Math.log10(Math.max(0.3, cl.wind));
  L.rain = cl.rain ? 57 : 0;
  return L;
}
function updateAmbient() {
  if (!audio.ctx || !scene) return;
  const L = ambientLevels(), t = audio.ctx.currentTime;
  for (const [k, g] of Object.entries(audio.amb)) g.gain.setTargetAtTime(st.amb ? amp(L[k] || 0) : 0, t, 0.4);
}
function playStep() {
  if (!audio.playing || !st.steps || st.bypass) return;
  const set = audio.steps[scene.ground.step] || audio.steps.grass;
  const ac = audio.ctx, s = ac.createBufferSource(), p = ac.createStereoPanner(), g = ac.createGain();
  s.buffer = set[Math.floor(Math.random() * set.length)];
  s.playbackRate.value = 0.9 + Math.random() * 0.2;
  stepSide = -stepSide; p.pan.value = 0.15 * stepSide;
  g.gain.value = amp(50) * (0.8 + Math.random() * 0.4);
  s.connect(g).connect(p).connect(audio.stepBus);
  s.start();
}
// slow level / tone fluctuation caused by turbulence at long range
function gauss() { return Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(2 * Math.PI * Math.random()); }
function turbulence() {
  if (!audio.ctx || !irInfo || !scene) return;
  const sigma = Math.min(6, 0.01 * irInfo.dh * (0.3 + scene.climate.wind / 5));
  const t = audio.ctx.currentTime;
  audio.turb.gain.setTargetAtTime(Math.pow(10, 0.7 * sigma * gauss() / 20), t, 0.25);
  audio.shelf.gain.setTargetAtTime(0.8 * sigma * gauss(), t, 0.25);
}

// music source selection
$('source').value = st.source === 'file' ? 'demo' : st.source;
if (st.source === 'file') st.source = 'demo';
$('source').addEventListener('change', e => {
  const v = e.target.value;
  if (v === 'file') { e.target.value = audio.file ? 'loaded' : 'demo'; $('file').click(); return; }
  st.source = v === 'loaded' ? 'file' : 'demo'; save();
  if (audio.playing) startMusic();
});
$('file').addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('audio')) loadFile(f);
});
async function loadFile(f) {
  await ensureAudio();
  $('fileName').textContent = '読み込み中… ' + f.name;
  try {
    const buf = await audio.ctx.decodeAudioData(await f.arrayBuffer());
    S.normalize(buf, 0.15);
    audio.file = buf;
    st.source = 'file';
    if (![...$('source').options].some(o => o.value === 'loaded')) {
      const o = document.createElement('option'); o.value = 'loaded'; $('source').insertBefore(o, $('source').options[1]);
    }
    $('source').querySelector('option[value=loaded]').textContent = '🎵 ' + f.name;
    $('source').value = 'loaded';
    $('fileName').textContent = '';
    if (audio.playing) startMusic(); else startAudio();
  } catch (err) {
    $('fileName').textContent = '読み込めませんでした: ' + f.name;
  }
}
// ------------------------------------------------------------------ info panels
function kv(el, rows) {
  el.innerHTML = rows.map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls || ''}">${v}</dd>`).join('');
}
function updateClimate() {
  const cl = scene.climate;
  const ab = f => (A.airAbsorption(f, cl.T, cl.RH, cl.p) * 100).toFixed(2);
  let grad;
  if (cl.gradT > 0.03) grad = '逆転層 (音が下へ曲がり遠くへ届く)';
  else if (cl.gradT < -0.03) grad = '地面が暖かい (音が上へ曲がる)';
  else grad = 'ほぼ中立';
  const gnote = scene.ground.overridden ? ' (雪で上書き)' : scene.climate.wet ? ' (雨で湿り)' : '';
  kv($('climate'), [
    ['気温', `${cl.T.toFixed(1)} °C`],
    ['相対湿度', `${cl.RH.toFixed(0)} %`],
    ['気圧', `${(cl.p * 10).toFixed(0)} hPa`],
    ['音速', `${cl.c.toFixed(1)} m/s`],
    ['風', `${cl.wind.toFixed(1)} m/s ${A.WIND_DIRS[st.windDir].name.split(' (')[0]}`],
    ['気温勾配', grad],
    ['空気吸収 1k/4k/8k', `${ab(1000)} / ${ab(4000)} / ${ab(8000)} dB/100m`],
    ['地面', `${scene.ground.name}${gnote} σ=${scene.ground.sigma}`],
    ['周辺', A.ENVS[scene.env].name],
  ]);
}
function updateListenerInfo() {
  const i = irInfo;
  if (!i) return;
  const f = v => (v < 0 ? '—' : v.toFixed(0));
  let refr;
  if (i.a < -1e-4) refr = isFinite(i.shadow) ? `上向き: ${i.shadow.toFixed(0)} m 先から影 (いま ${i.dh.toFixed(0)} m)` : '上向き';
  else if (i.a > 1e-4) refr = '下向き (遠くまで届く)';
  else refr = 'なし';
  const sigma = Math.min(6, 0.01 * i.dh * (0.3 + scene.climate.wind / 5));
  kv($('listener'), [
    ['音圧', `${i.dBA.toFixed(1)} dB(A)`, 'big'],
    ['直接音 + 地面反射', `${f(i.dBAd)} dB(A)`],
    ['建物・壁の反射', `${f(i.dBAi)} dB(A)`],
    ['会場の残響', `${f(i.dBAv)} dB(A)`],
    ['周辺からの拡散音', `${f(i.dBAe)} dB(A)`],
    ['ステージ左スピーカーまで', `${i.dh.toFixed(0)} m`],
    ['柵・壁による減衰 (1kHz)', `${i.barrier1k.toFixed(1)} dB`],
    ['屈折', refr],
    ['足もとの反射面', i.crowd ? '観客の頭 (よく吸う)' : scene.ground.name],
    ['ゆらぎ', `±${sigma.toFixed(1)} dB`],
    ['反射音の数', `${i.nImages}`],
    ['音量補正', `${(20 * Math.log10(compGain())).toFixed(1)} dB`],
  ]);
}
function drawFR() {
  const c = $('fr'), r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  const g = c.getContext('2d'), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  if (!irInfo) return;
  const fr = irInfo.fr;
  const all = fr.l.concat(fr.r);
  const top = Math.ceil((Math.max(...all) + 3) / 10) * 10, bot = top - 70;
  const X = f => (Math.log10(f / 20) / 3) * W, Y = v => (top - v) / (top - bot) * H;
  g.strokeStyle = st.dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'; g.lineWidth = dpr;
  g.fillStyle = css('--muted'); g.font = `${10 * dpr}px system-ui`;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    g.beginPath(); g.moveTo(X(f), 0); g.lineTo(X(f), H); g.stroke();
    g.fillText(f >= 1000 ? f / 1000 + 'k' : f, X(f) + 2 * dpr, H - 3 * dpr);
  }
  for (let v = bot; v <= top; v += 10) {
    g.beginPath(); g.moveTo(0, Y(v)); g.lineTo(W, Y(v)); g.stroke();
    g.fillText(v + ' dB', 2 * dpr, Y(v) - 2 * dpr);
  }
  for (const [arr, col] of [[fr.l, css('--accent')], [fr.r, css('--accent2')]]) {
    g.strokeStyle = col; g.lineWidth = 1.6 * dpr; g.beginPath();
    arr.forEach((v, k) => { const x = X(fr.f[k]), y = Y(Math.max(bot, v)); k ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
  }
  g.fillStyle = css('--accent'); g.fillText('左耳', W - 70 * dpr, 12 * dpr);
  g.fillStyle = css('--accent2'); g.fillText('右耳', W - 36 * dpr, 12 * dpr);
}

// ------------------------------------------------------------------ go
rebuild();
setWalking(false);
requestAnimationFrame(tick);
})();
