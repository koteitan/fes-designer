/* main.js — UI, first-person 3D walk, minimap, audio graph and inputs for Fes Designer */
(function () {
'use strict';
const A = window.Acoustics, S = window.Sounds, V3 = window.View3D;
const $ = id => document.getElementById(id);
const KEY = 'fes-designer';
const WALK = 1.3; // m/s

// ------------------------------------------------------------------ state
const defaults = {
  venue: 'fes', system: 'lineL', ground: 'grass', region: 'tokyo', month: 7, tod: 'evening', weather: 'sunny',
  windDir: 'toAudience', headMode: 'auto', progress: 0, speed: 3, volume: 0, comp: 0.2,
  heat: true, mini: true, amb: true, steps: true, dark: true, bypass: false, source: 'demo', url: '', inGain: 0, pos: {},
};
let st;
try { st = Object.assign({}, defaults, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { st = Object.assign({}, defaults); }
if (!(st.v >= 2)) { st.comp = defaults.comp; st.v = 2; } // v2: closer-to-physical default level compression
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
  const groups = {};
  for (const [k, v] of Object.entries(table)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = fmt ? fmt(k, v) : v.name;
    if (v.group) {
      if (!groups[v.group]) { groups[v.group] = document.createElement('optgroup'); groups[v.group].label = v.group; el.appendChild(groups[v.group]); }
      groups[v.group].appendChild(o);
    } else el.appendChild(o);
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
$('optHeat').addEventListener('change', e => { st.heat = e.target.checked; save(); if (st.heat) requestMap(); else V3.setHeat(null); drawLegend(); drawMap(); });
$('optMini').checked = st.mini;
$('mini').hidden = !st.mini;
$('optMini').addEventListener('change', e => { st.mini = e.target.checked; $('mini').hidden = !st.mini; save(); if (st.mini) { layout(); drawMap(); } });
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
let route = [], routeLen = 1, cum = [0], collSegs = [];
// mode 'route': position follows the route; 'free': WASD / mouse
const listener = { x: 0, y: 0, heading: -Math.PI / 2, pitch: 0, mode: 'route', lookOff: 0 };
let irInfo = null;

const irWorker = new Worker('ir-worker.js');
const mapWorker = new Worker('ir-worker.js');
V3.init($('view3d'));

function defaultStart(sc) { const [, , x1, y1] = sc.bbox; return [x1 + 230, y1 + 170]; }
function defaultSeat(sc) { return [10, Math.max(14, sc.venue.foh * 0.8)]; }
function inBuilding(sc, p) { return sc.draw.buildings.some(b => A.pointInPoly(b.pts, p[0], p[1])); }
function validStart(sc, p) { return p && !A.insideVenue(sc, p[0], p[1]) && !inBuilding(sc, p) && Math.hypot(p[0], p[1]) < 2500; }
function validSeat(sc, p) { return p && A.inAudience(sc, p[0], p[1]); }

function rebuild() {
  scene = A.buildScene(st, sr);
  sceneVersion++;
  const pv = st.pos[st.venue] || {};
  if (!validStart(scene, pv.start)) pv.start = defaultStart(scene);
  if (!validSeat(scene, pv.seat)) pv.seat = defaultSeat(scene);
  st.pos[st.venue] = pv;
  collSegs = scene.walls.concat(scene.barriers.filter(b => b.kind === 'building' || b.kind === 'stage'));
  irWorker.postMessage({ type: 'scene', scene });
  mapWorker.postMessage({ type: 'scene', scene });
  V3.build(scene);
  if (listener.mode === 'free' && pv.free && !inBuilding(scene, pv.free)) {
    listener.x = pv.free[0]; listener.y = pv.free[1];
  } else listener.mode = 'route';
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
    const path = [start];
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
  V3.setRoute(route, start, seat);
  if (listener.mode === 'route') placeListener(true);
}

function routePoint(s) {
  const d = s * routeLen;
  let i = 1;
  while (i < route.length - 1 && cum[i] < d) i++;
  const a = route[i - 1], b = route[i], seg = cum[i] - cum[i - 1] || 1;
  const u = Math.min(1, Math.max(0, (d - cum[i - 1]) / seg));
  return { x: a[0] + (b[0] - a[0]) * u, y: a[1] + (b[1] - a[1]) * u, dir: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}
function autoHeading(p) {
  if (st.headMode === 'stage' || st.progress >= 0.999) return Math.atan2(-p.y, -p.x);
  return p.dir;
}
function placeListener(snap) {
  const p = routePoint(st.progress);
  listener.x = p.x; listener.y = p.y;
  if (snap) { listener.lookOff = 0; listener.heading = autoHeading(p); }
  $('progress').value = Math.round(st.progress * 1000);
  updateWhere();
}
function enterRoute(progress) {
  listener.mode = 'route';
  if (progress != null) st.progress = progress;
  placeListener(true);
  save();
  requestIR();
  drawMap();
}
function enterFree() {
  if (listener.mode === 'free') return;
  listener.mode = 'free';
  listener.lookOff = 0;
  setWalking(false);
}

function updateWhere() {
  let w;
  if (listener.mode === 'route' && st.progress >= 0.999) w = '🪑 座席';
  else if (scene.gates.some(g => Math.hypot(g.x - listener.x, g.y - listener.y) < 14)) w = '🚪 入場ゲート';
  else if (A.inAudience(scene, listener.x, listener.y)) w = '🙌 客席エリア';
  else if (A.insideVenue(scene, listener.x, listener.y)) w = '🎪 場内';
  else w = '🌆 会場の外';
  $('where').textContent = w;
}

// ------------------------------------------------------------------ IR requests
let irBusy = false, irDirty = true, lastIR = null, irId = 0, lastIRTime = 0, irTimer = 0;
function requestIR() {
  if (irBusy || !scene) return;
  const now = performance.now();
  if (lastIR && lastIR.version === sceneVersion && !irDirty) {
    const moved = Math.hypot(listener.x - lastIR.x, listener.y - lastIR.y);
    let dh = Math.abs(listener.heading - lastIR.heading) % (2 * Math.PI);
    if (dh > Math.PI) dh = 2 * Math.PI - dh;
    if (moved < 0.4 && dh < 0.07) return;
  }
  if (now - lastIRTime < 200) {
    clearTimeout(irTimer);
    irTimer = setTimeout(requestIR, 220 - (now - lastIRTime));
    return;
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

// ------------------------------------------------------------------ minimap
const canvas = $('map'), ctx2 = canvas.getContext('2d');
const view = { x0: 0, y0: 0, x1: 1, y1: 1, s: 1, ox: 0, oy: 0, dpr: 1 };
let heat = null, mapId = 0, mapTimer = 0;

function fitView() {
  const pts = scene.poly.concat(route, [[listener.x, listener.y]]);
  const x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0]));
  const y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
  const m = Math.max(40, 0.08 * Math.max(x1 - x0, y1 - y0));
  view.wx0 = x0 - m; view.wx1 = x1 + m; view.wy0 = y0 - m; view.wy1 = y1 + m;
  layout();
}
function layout() {
  const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if (r.width < 2) return;
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  const W = canvas.width, H = canvas.height;
  const s = Math.min(W / (view.wx1 - view.wx0), H / (view.wy1 - view.wy0));
  view.s = s;
  view.ox = (W - (view.wx1 - view.wx0) * s) / 2 - view.wx0 * s;
  view.oy = (H - (view.wy1 - view.wy0) * s) / 2 - view.wy0 * s;
  view.x0 = -view.ox / s; view.x1 = (W - view.ox) / s; view.y0 = -view.oy / s; view.y1 = (H - view.oy) / s;
  view.dpr = dpr;
}
const S2W = (px, py) => [(px - view.ox) / view.s, (py - view.oy) / view.s];

function requestMap() {
  if (!st.heat || !scene) return;
  clearTimeout(mapTimer);
  mapTimer = setTimeout(() => {
    // the level map covers the minimap area (square) so it can also be laid on the 3D ground
    const cx = (view.wx0 + view.wx1) / 2, cy = (view.wy0 + view.wy1) / 2;
    const half = Math.max(view.wx1 - view.wx0, view.wy1 - view.wy0) / 2;
    const nx = 128, ny = 128;
    $('mapBusy').hidden = false;
    mapWorker.postMessage({ type: 'map', id: ++mapId, version: sceneVersion, x0: cx - half, y0: cy - half, x1: cx + half, y1: cy + half, nx, ny });
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
  V3.setHeat(c, m.x0, m.y0, m.x1, m.y1, st.heat);
  drawLegend();
  drawMap();
};

const RAMP = [[13, 8, 135], [84, 2, 163], [139, 10, 165], [185, 50, 137], [219, 92, 104], [244, 136, 73], [254, 188, 43], [240, 249, 33]];
function colormap(t) {
  t = Math.min(1, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(t)), u = t - i;
  return RAMP[i].map((v, k) => Math.round(v + (RAMP[i + 1][k] - v) * u));
}
function drawLegend() {
  const lg = $('legend');
  lg.hidden = !st.heat;
  if (!st.heat || lg.firstChild) return;
  lg.innerHTML = '<div>音圧 dB(A) (FOH = 100)</div><canvas width="140" height="8"></canvas><div class="row"><span>40</span><span>75</span><span>110</span></div>';
  const g = lg.querySelector('canvas').getContext('2d');
  for (let x = 0; x < 140; x++) { const [r, gg, b] = colormap(x / 139); g.fillStyle = `rgb(${r},${gg},${b})`; g.fillRect(x, 0, 1, 8); }
}
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function drawMap() {
  if (!scene || !st.mini) return;
  const g = ctx2, W = canvas.width, H = canvas.height, dpr = view.dpr || 1;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = scene.ground.color;
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(0, 0, W, H);
  g.setTransform(view.s, 0, 0, view.s, view.ox, view.oy);
  const px = dpr / view.s;
  const dr = scene.draw;
  if (dr.sea) { g.fillStyle = '#1d4a73'; g.fillRect(dr.sea[2], dr.sea[1], dr.sea[0] - dr.sea[2], dr.sea[3] - dr.sea[1]); }
  if (st.heat && heat) { g.imageSmoothingEnabled = true; g.drawImage(heat.canvas, heat.x0, heat.y0, heat.x1 - heat.x0, heat.y1 - heat.y0); }
  const au = scene.audience;
  g.setLineDash([4 * px, 4 * px]); g.lineWidth = px; g.strokeStyle = 'rgba(255,255,255,0.45)';
  g.beginPath();
  if (au.type === 'rect') g.rect(au.x0, au.y0, au.x1 - au.x0, au.y1 - au.y0);
  else g.ellipse(au.cx, au.cy, au.rx, au.ry, 0, 0, 2 * Math.PI);
  g.stroke(); g.setLineDash([]);
  for (const t of dr.trees) { g.strokeStyle = '#3f8f3a'; g.lineWidth = 4 * px; g.beginPath(); g.moveTo(t[0], t[1]); g.lineTo(t[2], t[3]); g.stroke(); }
  for (const r of dr.ridges) { g.strokeStyle = '#8a6a44'; g.lineWidth = 7 * px; g.beginPath(); g.moveTo(r[0], r[1]); g.lineTo(r[2], r[3]); g.stroke(); }
  for (const b of dr.buildings) {
    g.beginPath(); b.pts.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath();
    g.fillStyle = '#4a4d55'; g.fill();
  }
  g.strokeStyle = scene.venue.kind === 'stadium' ? '#c9c4b8' : '#f0e6c8';
  g.lineWidth = (scene.venue.kind === 'stadium' ? 4 : 1.5) * px;
  for (const w of scene.walls) { g.beginPath(); g.moveTo(w.ax, w.ay); g.lineTo(w.bx, w.by); g.stroke(); }
  const sg = scene.stage;
  g.fillStyle = '#111'; g.fillRect(sg.x0, sg.y0, sg.x1 - sg.x0, sg.y1 - sg.y0);
  g.strokeStyle = css('--accent'); g.lineWidth = 1.5 * px; g.strokeRect(sg.x0, sg.y0, sg.x1 - sg.x0, sg.y1 - sg.y0);
  for (const s of scene.speakers) {
    g.fillStyle = s.role === 'sub' ? '#888' : s.role === 'tower' ? css('--accent2') : css('--accent');
    g.beginPath(); g.arc(s.x, s.y, 2.5 * px, 0, 2 * Math.PI); g.fill();
  }
  g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 1.5 * px; g.setLineDash([3 * px, 3 * px]);
  g.beginPath(); route.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.stroke(); g.setLineDash([]);
  const pv = st.pos[st.venue];
  marker(g, pv.start, 'S', '#2b8a3e', px);
  marker(g, pv.seat, '席', '#c2255c', px);
  g.save(); g.translate(listener.x, listener.y); g.rotate(listener.heading);
  g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, 22 * px, -0.6, 0.6); g.closePath();
  g.fillStyle = 'rgba(255,255,255,0.3)'; g.fill();
  g.beginPath(); g.arc(0, 0, 5 * px, 0, 2 * Math.PI); g.fillStyle = '#fff'; g.fill();
  g.strokeStyle = '#000'; g.lineWidth = 1.5 * px; g.stroke();
  g.restore();
  // wind arrow
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cl = scene.climate, wv = cl.windDir;
  const wx = canvas.width / dpr - 26, wy = 26, L = 6 + Math.min(12, cl.wind * 1.2);
  g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(wx - wv[0] * L, wy - wv[1] * L); g.lineTo(wx + wv[0] * L, wy + wv[1] * L); g.stroke();
  const ang = Math.atan2(wv[1], wv[0]);
  g.beginPath(); g.moveTo(wx + wv[0] * L, wy + wv[1] * L);
  g.lineTo(wx + wv[0] * L - 6 * Math.cos(ang - 0.5), wy + wv[1] * L - 6 * Math.sin(ang - 0.5));
  g.lineTo(wx + wv[0] * L - 6 * Math.cos(ang + 0.5), wy + wv[1] * L - 6 * Math.sin(ang + 0.5)); g.fill();
  g.font = '10px system-ui'; g.textAlign = 'center';
  g.fillText(`風 ${cl.wind.toFixed(1)}m/s`, wx, wy + 22);
}
function marker(g, p, t, color, px) {
  g.beginPath(); g.arc(p[0], p[1], 8 * px, 0, 2 * Math.PI);
  g.fillStyle = color; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 1.5 * px; g.stroke();
  g.save(); g.translate(p[0], p[1]); g.scale(px, px);
  g.font = '9px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff'; g.fillText(t, 0, 0);
  g.restore();
}

// minimap: drag start / seat, click on route to walk from there, click elsewhere to teleport
let drag = null;
canvas.addEventListener('pointerdown', e => {
  e.stopPropagation();
  const r = canvas.getBoundingClientRect(), dpr = view.dpr;
  const [x, y] = S2W((e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr);
  const pv = st.pos[st.venue], tol = 12 * dpr / view.s;
  for (const k of ['seat', 'start']) {
    if (Math.hypot(pv[k][0] - x, pv[k][1] - y) < tol) { drag = k; canvas.setPointerCapture(e.pointerId); return; }
  }
  let best = null;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
    const d = Math.hypot(a[0] + dx * u - x, a[1] + dy * u - y);
    if (!best || d < best.d) best = { d, s: (cum[i - 1] + u * Math.sqrt(l2)) / routeLen };
  }
  if (best && best.d < tol) { setWalking(false); enterRoute(best.s); return; }
  if (!inBuilding(scene, [x, y])) {
    enterFree();
    listener.x = x; listener.y = y;
    st.pos[st.venue].free = [x, y];
    save(); updateWhere(); requestIR(); drawMap();
  }
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
window.addEventListener('resize', () => { V3.resize(); if (scene) { layout(); drawMap(); drawFR(); } });

// ------------------------------------------------------------------ first-person controls
const view3d = $('view3d');
const keys = {};
const typing = e => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox';
window.addEventListener('keydown', e => {
  if (typing(e)) return;
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'].includes(e.code)) {
    keys[e.code] = true;
    if (e.code.startsWith('Arrow') || e.code.startsWith('Key')) e.preventDefault();
  }
});
window.addEventListener('keyup', e => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

function look(dx, dy) {
  if (listener.mode === 'route') listener.lookOff += dx;
  else listener.heading += dx;
  listener.pitch = Math.max(-1.2, Math.min(1.2, listener.pitch - dy));
}
view3d.addEventListener('click', () => { if (!matchMedia('(pointer: coarse)').matches && document.pointerLockElement !== view3d && view3d.requestPointerLock) view3d.requestPointerLock(); });
document.addEventListener('mousemove', e => { if (document.pointerLockElement === view3d) look(e.movementX * 0.0025, e.movementY * 0.0025); });
document.addEventListener('pointerlockchange', () => {
  $('hud').textContent = document.pointerLockElement === view3d
    ? 'Esc で解除・WASD / 矢印で歩く・Shift で走る'
    : 'クリックで見回す (Esc で解除)・WASD / 矢印で歩く・Shift で走る';
});
// touch: left half = joystick, right half = look
const touches = {};
let joy = [0, 0];
view3d.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'touch') return;
  const r = view3d.getBoundingClientRect();
  const left = e.clientX - r.left < r.width / 2;
  touches[e.pointerId] = { left, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY };
  view3d.setPointerCapture(e.pointerId);
  if (left) { $('joy').hidden = false; }
});
view3d.addEventListener('pointermove', e => {
  const t = touches[e.pointerId];
  if (!t) return;
  if (t.left) {
    const dx = (e.clientX - t.x0) / 50, dy = (e.clientY - t.y0) / 50, m = Math.hypot(dx, dy);
    joy = m > 1 ? [dx / m, dy / m] : [dx, dy];
    $('joy').firstChild.style.transform = `translate(${joy[0] * 35}px, ${joy[1] * 35}px)`;
  } else {
    look((e.clientX - t.x) * 0.005, (e.clientY - t.y) * 0.005);
  }
  t.x = e.clientX; t.y = e.clientY;
});
const endTouch = e => {
  const t = touches[e.pointerId];
  if (!t) return;
  if (t.left) { joy = [0, 0]; $('joy').hidden = true; $('joy').firstChild.style.transform = ''; }
  delete touches[e.pointerId];
};
view3d.addEventListener('pointerup', endTouch);
view3d.addEventListener('pointercancel', endTouch);
if (matchMedia('(pointer: coarse)').matches) $('hud').textContent = '左: 歩く ・ 右: 見回す';

function blocked(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy) || 1;
  const ex = bx + dx / d * 0.4, ey = by + dy / d * 0.4; // keep a little distance from walls
  for (const s of collSegs) if (A.segX(ax, ay, ex, ey, s.ax, s.ay, s.bx, s.by) !== null) return true;
  return false;
}
function freeMove(dt) {
  let f = 0, r = 0;
  if (keys.KeyW || keys.ArrowUp) f += 1;
  if (keys.KeyS || keys.ArrowDown) f -= 1;
  if (keys.KeyD || keys.ArrowRight) r += 1;
  if (keys.KeyA || keys.ArrowLeft) r -= 1;
  f -= joy[1]; r += joy[0];
  if (!f && !r) return false;
  enterFree();
  const m = Math.hypot(f, r);
  if (m > 1) { f /= m; r /= m; }
  const sp = 1.4 * (keys.ShiftLeft || keys.ShiftRight ? 3 : 1) * Math.max(1, st.speed / 2) * dt;
  const h = listener.heading;
  const dx = (Math.cos(h) * f - Math.sin(h) * r) * sp, dy = (Math.sin(h) * f + Math.cos(h) * r) * sp;
  const x = listener.x, y = listener.y;
  if (!blocked(x, y, x + dx, y + dy)) { listener.x += dx; listener.y += dy; }
  else if (!blocked(x, y, x + dx, y)) listener.x += dx;
  else if (!blocked(x, y, x, y + dy)) listener.y += dy;
  else return false;
  stepDist += Math.hypot(listener.x - x, listener.y - y);
  st.pos[st.venue].free = [listener.x, listener.y];
  return true;
}

// ------------------------------------------------------------------ walking along the route
let walking = false;
function setWalking(on) {
  walking = on;
  $('walkBtn').textContent = on ? '⏸ 止まる' : '🚶 道を歩く';
}
$('walkBtn').addEventListener('click', () => {
  if (!walking) {
    if (st.progress >= 0.999) enterRoute(0);
    else if (listener.mode === 'free') enterRoute();
  }
  setWalking(!walking);
  if (walking && !audio.playing) startAudio();
});
$('resetBtn').addEventListener('click', () => { setWalking(false); enterRoute(0); });
$('progress').addEventListener('input', e => { setWalking(false); enterRoute(+e.target.value / 1000); });

let lastT = performance.now(), stepDist = 0, stepSide = 1, turbAcc = 0, mapAcc = 0, lvl = 0;
function tick(t) {
  const dt = Math.min(0.1, (t - lastT) / 1000);
  lastT = t;
  if (scene) {
    let moved = false;
    if (freeMove(dt)) moved = true;
    if (listener.mode === 'route') {
      if (walking) {
        const before = st.progress;
        st.progress = Math.min(1, st.progress + dt * WALK * st.speed / routeLen);
        stepDist += (st.progress - before) * routeLen;
        if (st.progress >= 1) { setWalking(false); save(); }
        placeListener(false);
        moved = true;
      }
      const p = routePoint(st.progress);
      const th = autoHeading(p) + listener.lookOff;
      let d = Math.atan2(Math.sin(th - listener.heading), Math.cos(th - listener.heading));
      if (Math.abs(d) > 0.002) { listener.heading += d * Math.min(1, dt * 4); }
    }
    if (moved) updateWhere();
    // footsteps every ~0.75 m
    if (stepDist > 0.75) { stepDist = 0; playStep(); }
    requestIR();
    turbAcc += dt;
    if (turbAcc > 0.15) { turbAcc = 0; turbulence(); }
    mapAcc += dt;
    if (mapAcc > 0.1) {
      mapAcc = 0;
      if (listener.x < view.wx0 || listener.x > view.wx1 || listener.y < view.wy0 || listener.y > view.wy1) { fitView(); requestMap(); }
      drawMap();
      if (moved && Math.random() < 0.05) save();
    }
    lvl += (inputLevel() - lvl) * Math.min(1, dt * 12);
    V3.render(listener, lvl);
  }
  requestAnimationFrame(tick);
}

// ------------------------------------------------------------------ audio graph
const audio = { ctx: null, playing: false, cur: null, demo: null, file: null, amb: {}, ambBufs: null, steps: null, stopSrc: null };
function buildGraph() {
  const ac = audio.ctx;
  audio.inGain = ac.createGain();
  audio.inBus = ac.createGain();
  audio.inBus.channelCount = 2; audio.inBus.channelCountMode = 'explicit'; audio.inBus.channelInterpretation = 'speakers';
  audio.inGain.connect(audio.inBus);
  audio.meter = ac.createAnalyser();
  audio.meter.fftSize = 2048;
  audio.inBus.connect(audio.meter);
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
  for (const [k, buf] of Object.entries(audio.ambBufs)) {
    const s = ac.createBufferSource(); s.buffer = buf; s.loop = true;
    const g = ac.createGain(); g.gain.value = 0;
    s.connect(g).connect(audio.ambBus);
    s.start(0, Math.random() * buf.duration);
    audio.amb[k] = g;
  }
  applyMaster(); applyBypass(); applyInGain();
}
let audioInit = null;
function ensureAudio() {
  if (!audioInit) {
    audioInit = (async () => {
      const ac = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
      audio.ctx = ac;
      audio.ambBufs = S.makeAmbient(ac);
      audio.steps = S.makeSteps(ac);
      buildGraph();
      if (ac.sampleRate !== sr) { sr = ac.sampleRate; rebuild(); }
      audio.demo = await S.renderDemo(ac.sampleRate);
    })();
  }
  return audioInit;
}
function inputLevel() {
  if (!audio.meter || !audio.playing) return 0;
  const a = inputLevel.buf || (inputLevel.buf = new Float32Array(audio.meter.fftSize));
  audio.meter.getFloatTimeDomainData(a);
  let e = 0;
  for (let i = 0; i < a.length; i += 4) e += a[i] * a[i];
  const db = 10 * Math.log10(e / (a.length / 4) + 1e-12);
  $('inMeter').style.width = Math.max(0, Math.min(100, (db + 50) * 2)) + '%';
  return Math.max(0, Math.min(1, (db + 30) / 22));
}

// ------------------------------------------------------------------ inputs
const status = t => { $('srcStatus').textContent = t; };
function showSourceRow() {
  $('rowFile').hidden = st.source !== 'file';
  $('rowUrl').hidden = st.source !== 'url';
  $('rowLive').hidden = st.source !== 'tab' && st.source !== 'mic';
  $('liveBtn').textContent = st.source === 'tab' ? 'タブを選んで共有する' : 'マイク・ライン入力を使う';
}
$('source').value = st.source;
if ($('source').value === '') st.source = 'demo';
$('urlIn').value = st.url;
showSourceRow();
$('source').addEventListener('change', e => {
  st.source = e.target.value; save(); showSourceRow(); status('');
  if (st.source === 'demo' && audio.playing) connectSource();
  if (st.source === 'file') { if (audio.file) { if (audio.playing) connectSource(); } else $('file').click(); }
});
$('fileBtn').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); });
$('urlBtn').addEventListener('click', () => { st.url = $('urlIn').value.trim(); save(); startAudio(); });
$('liveBtn').addEventListener('click', () => startAudio());
$('inGain').value = st.inGain;
function applyInGain() {
  $('inGainVal').textContent = `${st.inGain > 0 ? '+' : ''}${st.inGain} dB`;
  if (audio.ctx) audio.inGain.gain.setTargetAtTime(Math.pow(10, st.inGain / 20), audio.ctx.currentTime, 0.05);
}
applyInGain();
$('inGain').addEventListener('input', e => { st.inGain = +e.target.value; save(); applyInGain(); });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});
async function loadFile(f) {
  await ensureAudio();
  status('読み込み中… ' + f.name);
  try {
    const buf = await audio.ctx.decodeAudioData(await f.arrayBuffer());
    S.normalize(buf, 0.15);
    audio.file = buf;
    st.source = 'file'; $('source').value = 'file'; showSourceRow(); save();
    status('🎵 ' + f.name);
    if (audio.playing) connectSource(); else startAudio();
  } catch (err) {
    status('読み込めませんでした: ' + f.name);
  }
}
function stopSource() {
  if (audio.stopSrc) { try { audio.stopSrc(); } catch (e) { /* already stopped */ } audio.stopSrc = null; }
}
// connect the selected input to the simulation; returns false if it could not start
async function connectSource() {
  await ensureAudio();
  stopSource();
  const ac = audio.ctx;
  try {
    if (st.source === 'demo' || st.source === 'file') {
      const buf = st.source === 'file' ? audio.file : audio.demo;
      if (!buf) { status('ファイルを選んでください (ページにドロップしても使えます)'); return false; }
      const s = ac.createBufferSource();
      s.buffer = buf; s.loop = true;
      s.connect(audio.inGain); s.start();
      audio.stopSrc = () => { s.stop(); s.disconnect(); };
    } else if (st.source === 'url') {
      if (!st.url) { status('URL を入れてください'); return false; }
      const el = new Audio();
      el.crossOrigin = 'anonymous'; el.src = st.url; el.loop = true;
      const node = ac.createMediaElementSource(el);
      node.connect(audio.inGain);
      audio.stopSrc = () => { el.pause(); node.disconnect(); el.removeAttribute('src'); el.load(); };
      status('読み込み中…');
      await el.play();
      status('▶ ' + st.url.split('/').pop());
    } else {
      let stream;
      if (st.source === 'mic') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } });
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: true },
          systemAudio: 'include', selfBrowserSurface: 'exclude',
        });
      }
      const at = stream.getAudioTracks();
      if (!at.length) {
        stream.getTracks().forEach(t => t.stop());
        status('音声が共有されていません。タブを選んで「タブの音声も共有」をオンにしてください');
        return false;
      }
      const node = ac.createMediaStreamSource(stream);
      node.connect(audio.inGain);
      at[0].addEventListener('ended', () => status('入力が終わりました'));
      audio.stopSrc = () => { node.disconnect(); stream.getTracks().forEach(t => t.stop()); };
      status(st.source === 'mic' ? '🎤 ' + (at[0].label || 'マイク') : '🖥 ' + (at[0].label || 'タブの音'));
    }
    return true;
  } catch (err) {
    stopSource();
    if (st.source === 'url') status('再生できませんでした。相手のサーバーが他のサイトからの読み込みを許していない (CORS) かもしれません。ファイルを保存して読み込んでください');
    else status('開始できませんでした: ' + (err && err.message ? err.message : err));
    return false;
  }
}
async function startAudio() {
  $('playBtn').textContent = '… 準備中';
  await ensureAudio();
  await audio.ctx.resume();
  const ok = await connectSource();
  audio.playing = ok;
  $('playBtn').textContent = ok ? '■ 停止' : '▶ 再生';
  if (!ok) return;
  irDirty = true; lastIR = null; requestIR();
  updateAmbient(); updateLevel();
}
function stopAudio() {
  stopSource();
  audio.playing = false;
  audio.ctx.suspend();
  $('playBtn').textContent = '▶ 再生';
  $('inMeter').style.width = '0';
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
  audio.master.gain.setTargetAtTime(Math.pow(10, (st.volume + 6) / 20), audio.ctx.currentTime, 0.05);
}
function applyBypass() {
  if (!audio.ctx) return;
  const t = audio.ctx.currentTime;
  audio.dry.gain.setTargetAtTime(st.bypass ? 0.7 : 0, t, 0.05);
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
function gauss() { return Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(2 * Math.PI * Math.random()); }
function turbulence() {
  if (!audio.ctx || !irInfo || !scene) return;
  const sigma = Math.min(6, 0.01 * irInfo.dh * (0.3 + scene.climate.wind / 5));
  const t = audio.ctx.currentTime;
  audio.turb.gain.setTargetAtTime(Math.pow(10, 0.7 * sigma * gauss() / 20), t, 0.25);
  audio.shelf.gain.setTargetAtTime(0.8 * sigma * gauss(), t, 0.25);
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
