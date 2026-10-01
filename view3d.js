/* view3d.js — first-person 3D view of the venue (three.js r128, global THREE).
 * World coordinates: x = audience right, y = away from the stage, h = height.
 * three.js coordinates: (x, h, y). */
(function () {
'use strict';
const V = {};
const EYE = 1.6;
let renderer, s3, cam, root, sky, sun, hemi;
let heatMesh = null, heatTex = null;
let crowd = null, crowdBaseY = null, crowdPhase = null;
let screens = [], beams = [], precip = null, precipKind = null;
let night = false;
const t0 = performance.now();

const GROUND3D = {
  grass: 0x55803c, soil: 0x7d6649, sand: 0xc9b27c, gravel: 0x8c8b85,
  asphalt: 0x3e3f44, concrete: 0x9d9d9a, snow: 0xf0f3f7,
};

const M = (color, o) => new THREE.MeshLambertMaterial(Object.assign({ color }, o || {}));

function box(cx, cy, w, d, h, mat, h0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(cx, (h0 || 0) + h / 2, cy);
  root.add(m);
  return m;
}
function segBox(ax, ay, bx, by, h, thick, mat, h0) {
  const L = Math.hypot(bx - ax, by - ay);
  const m = new THREE.Mesh(new THREE.BoxGeometry(L, h, thick), mat);
  m.position.set((ax + bx) / 2, (h0 || 0) + h / 2, (ay + by) / 2);
  m.rotation.y = -Math.atan2(by - ay, bx - ax);
  root.add(m);
  return m;
}
function dispose(o) {
  o.traverse(n => {
    if (n.geometry) n.geometry.dispose();
    if (n.material) (Array.isArray(n.material) ? n.material : [n.material]).forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
  });
}
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

V.init = function (canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  s3 = new THREE.Scene();
  cam = new THREE.PerspectiveCamera(70, 1, 0.1, 9000);
  hemi = new THREE.HemisphereLight(0xffffff, 0x444433, 0.6);
  s3.add(hemi);
  sun = new THREE.DirectionalLight(0xffffff, 0.8);
  s3.add(sun);
  const g = new THREE.SphereGeometry(7000, 32, 16);
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3), 3));
  sky = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  sky.renderOrder = -1;
  s3.add(sky);
  V.resize();
};

V.resize = function () {
  if (!renderer) return;
  const c = renderer.domElement, w = Math.max(1, c.clientWidth), h = Math.max(1, c.clientHeight);
  renderer.setSize(w, h, false);
  cam.aspect = w / h;
  cam.updateProjectionMatrix();
};

// sky colours (top, horizon) per time of day and weather
function skyColors(tod, weather) {
  const grey = { cloudy: 1, rain: 1, fog: 1, snow: 1, storm: 1 }[weather];
  switch (tod) {
    case 'night': return grey ? [0x07090e, 0x1b1f27] : [0x03060f, 0x18203a];
    case 'evening': return grey ? [0x3b4150, 0x9a7f6c] : [0x24356a, 0xf0884a];
    case 'morning': return grey ? [0x7d8590, 0xc4c2bc] : [0x5b8fd0, 0xf2d3a4];
    default:
      if (weather === 'fog') return [0xa9aeb4, 0xc8ccd0];
      if (weather === 'snow') return [0xa3abb5, 0xdde1e6];
      if (grey) return [0x6f7782, 0xaeb3ba];
      return [0x3d7cc9, 0xb3d4f2];
  }
}
function setSky(top, hor) {
  const pos = sky.geometry.attributes.position, col = sky.geometry.attributes.color;
  const a = new THREE.Color(top), b = new THREE.Color(hor), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 7000;
    c.copy(b).lerp(a, Math.pow(Math.max(0, y), 0.5));
    if (y < 0) c.copy(b).multiplyScalar(0.6);
    col.setXYZ(i, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
}

function windowTexture(lit) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d'), r = rng(5);
  g.fillStyle = lit ? '#1b1e24' : '#7f858e';
  g.fillRect(0, 0, 64, 128);
  for (let y = 4; y < 128; y += 10) {
    for (let x = 4; x < 64; x += 10) {
      g.fillStyle = lit ? (r() < 0.45 ? '#f6d68a' : '#2a2f38') : (r() < 0.5 ? '#9fb3c8' : '#5d6670');
      g.fillRect(x, y, 6, 6);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

V.build = function (sc) {
  if (root) { s3.remove(root); dispose(root); }
  root = new THREE.Group();
  s3.add(root);
  screens = []; beams = []; crowd = null; heatMesh = null;
  const st = sc.st, V0 = sc.venue, dr = sc.draw;
  night = st.tod === 'night' || st.tod === 'evening';
  const [top, hor] = skyColors(st.tod, st.weather);
  setSky(top, hor);
  const fogFar = st.weather === 'fog' ? 260 : st.weather === 'rain' || st.weather === 'snow' ? 1500 : 5000;
  s3.fog = new THREE.Fog(hor, st.weather === 'fog' ? 15 : 200, fogFar);
  const dayK = { noon: 1, morning: 0.7, evening: 0.45, night: 0.12 }[st.tod] * (['cloudy', 'rain', 'fog', 'snow', 'storm'].includes(st.weather) ? 0.6 : 1);
  hemi.intensity = 0.25 + 0.55 * dayK;
  hemi.color.set(st.tod === 'evening' ? 0xffc9a0 : st.tod === 'night' ? 0x8090c0 : 0xffffff);
  sun.intensity = 0.9 * dayK;
  sun.color.set(st.tod === 'evening' || st.tod === 'morning' ? 0xffb070 : 0xffffff);
  sun.position.set(st.tod === 'morning' ? 600 : -600, st.tod === 'noon' ? 900 : 250, -300);

  // ground and sea
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(12000, 12000), M(GROUND3D[sc.ground.key] || 0x55803c));
  ground.rotation.x = -Math.PI / 2;
  root.add(ground);
  if (dr.sea) {
    const [x1, y0, x0, y1] = dr.sea;
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, y1 - y0), M(0x1d4f7d));
    sea.rotation.x = -Math.PI / 2;
    sea.position.set((x0 + x1) / 2, 0.05, (y0 + y1) / 2);
    root.add(sea);
  }

  // venue
  if (V0.kind === 'stadium') buildStadium(sc);
  else {
    const fence = M(0x24302a, { transparent: true, opacity: 0.88, side: THREE.DoubleSide });
    for (const w of sc.walls) segBox(w.ax, w.ay, w.bx, w.by, V0.fenceH, 0.12, fence);
    const post = M(0x9a9a9a);
    for (const w of sc.walls) {
      const L = Math.hypot(w.bx - w.ax, w.by - w.ay), n = Math.ceil(L / 3.5);
      for (let i = 0; i <= n; i++) box(w.ax + (w.bx - w.ax) * i / n, w.ay + (w.by - w.ay) * i / n, 0.08, 0.08, V0.fenceH + 0.1, post);
    }
  }
  buildStage(sc);
  buildSpeakers(sc);
  // FOH tent
  const [fx, fy] = sc.foh;
  box(fx, fy + 1, 8, 6, 0.25, M(0xdddddd), 3);
  for (const [dx, dy] of [[-4, -2], [4, -2], [-4, 4], [4, 4]]) box(fx + dx, fy + 1 + dy, 0.12, 0.12, 3, M(0x888888));
  box(fx, fy, 5, 1.2, 1, M(0x222222));
  buildCrowd(sc);
  // surroundings
  const lit = night;
  const wt = windowTexture(lit);
  for (const b of dr.buildings) {
    const xs = b.pts.map(p => p[0]), ys = b.pts.map(p => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), d = Math.max(...ys) - Math.min(...ys);
    const t = wt.clone(); t.needsUpdate = true; t.repeat.set(Math.max(1, w / 12), Math.max(1, b.h / 24));
    const mat = lit ? new THREE.MeshBasicMaterial({ map: t }) : M(0xffffff, { map: t });
    box((Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2, w, d, b.h, mat);
  }
  for (const t of dr.trees) buildTrees(t, sc);
  for (const r of dr.ridges) buildRidge(r);
  setPrecip(st.weather === 'rain' ? 'rain' : st.weather === 'snow' ? 'snow' : null);
};

function buildStadium(sc) {
  const V0 = sc.venue, cy = sc.audience.cy, n = 64, H = V0.wallH;
  const pos = [], col = [];
  const cA = new THREE.Color(0x5d6470), cB = new THREE.Color(0x3c4250);
  const pt = (ph, outer) => outer ? [V0.rx * Math.cos(ph), H, cy + V0.ry * Math.sin(ph)] : [V0.frx * Math.cos(ph), 3, cy + V0.fry * Math.sin(ph)];
  for (let i = 0; i < n; i++) {
    const p0 = 2 * Math.PI * i / n, p1 = 2 * Math.PI * (i + 1) / n, pm = (p0 + p1) / 2;
    if (Math.sin(pm) < -0.9) continue; // behind the stage
    const a = pt(p0, 0), b = pt(p1, 0), c = pt(p1, 1), d = pt(p0, 1);
    for (const v of [a, b, c, a, c, d]) { pos.push(v[0], v[1], v[2]); const cc = i % 2 ? cA : cB; col.push(cc.r, cc.g, cc.b); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  root.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  // facade with tunnel openings
  const fac = M(0xb9b4a8);
  for (const w of sc.walls) segBox(w.ax, w.ay, w.bx, w.by, H, 1.5, fac);
  // tunnel portals: a frame around each opening, the passage itself stays open
  const frame = M(0x3a3d44);
  for (const gt of sc.gates) {
    const tx = -gt.ny, ty = gt.nx; // along the wall
    for (const s of [-1, 1]) box(gt.x + tx * 4.6 * s, gt.y + ty * 4.6 * s, 1.2, 1.2, 6, frame);
    segBox(gt.x - tx * 5.2, gt.y - ty * 5.2, gt.x + tx * 5.2, gt.y + ty * 5.2, 1.5, 1.6, frame, 6);
  }
  // pitch
  const pitch = new THREE.Mesh(new THREE.CircleGeometry(1, 48), M(0x3f7a35));
  pitch.scale.set(V0.frx, V0.fry, 1);
  pitch.rotation.x = -Math.PI / 2;
  pitch.position.set(0, 0.03, cy);
  root.add(pitch);
  box(0, cy - V0.fry, V0.frx * 2, 1, 3, M(0x30343c));
  // spectators in the stands
  const r = rng(11), N = 9000, pp = new Float32Array(N * 3), pc = new Float32Array(N * 3);
  const pal = [0xe03131, 0xf8f9fa, 0x1c7ed6, 0xfab005, 0x2b8a3e, 0x212529, 0xae3ec9].map(c => new THREE.Color(c));
  for (let i = 0; i < N; i++) {
    let ph;
    do { ph = r() * 2 * Math.PI; } while (Math.sin(ph) < -0.9);
    const t = r(), a = pt(ph, 0), b = pt(ph, 1);
    pp[i * 3] = a[0] + (b[0] - a[0]) * t; pp[i * 3 + 1] = a[1] + (b[1] - a[1]) * t + 0.6; pp[i * 3 + 2] = a[2] + (b[2] - a[2]) * t;
    const c = pal[Math.floor(r() * pal.length)];
    pc[i * 3] = c.r; pc[i * 3 + 1] = c.g; pc[i * 3 + 2] = c.b;
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pp, 3));
  pg.setAttribute('color', new THREE.BufferAttribute(pc, 3));
  root.add(new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.7, vertexColors: true })));
}

function buildStage(sc) {
  const sg = sc.stage, W = sg.x1 - sg.x0, D = sg.y1 - sg.y0, H = sg.h;
  const dark = M(0x1a1a1e), truss = M(0x8d8f94);
  box(0, (sg.y0 + sg.y1) / 2, W, D, 1.8, dark);
  box(0, sg.y0 + 0.5, W, 1, H, dark);
  box(0, (sg.y0 + sg.y1) / 2, W + 6, D + 2, 1.2, truss, H);
  for (const x of [sg.x0 - 2, sg.x1 + 2]) for (const y of [sg.y0, sg.y1 + 0.5]) box(x, y, 0.6, 0.6, H, truss);
  // LED screens
  const addScreen = (x, y, w, h, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0x223344 }));
    m.position.set(x, z, y);
    root.add(m);
    screens.push(m);
  };
  addScreen(0, sg.y0 + 1.05, W * 0.6, H * 0.45, 2 + H * 0.3);
  for (const s of [-1, 1]) addScreen(s * (W / 2 + 9), sg.y1 - 1, 9, 5.5, H * 0.55);
  for (const s of [-1, 1]) box(s * (W / 2 + 9), sg.y1 - 1.3, 0.4, 0.4, H * 0.55 - 2.75, truss);
  // light beams (visible in the dark) and stage wash lighting the surroundings
  if (night) {
    const wash = new THREE.PointLight(0xffd0a0, 1.2, 400, 1.2);
    wash.position.set(0, H, sg.y1 + 10);
    root.add(wash);
    for (let i = 0; i < 8; i++) {
      const g = new THREE.ConeGeometry(4, 60, 16, 1, true);
      g.translate(0, -30, 0);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(i / 8, 0.8, 0.6), transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      m.position.set(sg.x0 + (i + 0.5) * W / 8, H - 0.3, sg.y1 - 1);
      m.userData.phase = i * 0.7;
      root.add(m);
      beams.push(m);
    }
  }
}

function buildSpeakers(sc) {
  const cab = M(0x15161a), metal = M(0x8d8f94);
  for (const s of sc.speakers) {
    const g = new THREE.Group();
    g.position.set(s.x, 0, s.y);
    g.rotation.y = -Math.atan2(s.ay, s.ax);
    root.add(g);
    const add = (w, h, d, x, y, z, rz, mat) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(d, h, w), mat || cab);
      m.position.set(x, y, z);
      if (rz) m.rotation.z = rz;
      g.add(m);
    };
    if (s.type === 'line') {
      const n = Math.max(3, Math.round(s.L / 0.4)), top = s.z + s.L / 2;
      for (let k = 0; k < n; k++) add(1.2, 0.36, 0.65, 0, top - k * 0.39, 0, -0.6 * Math.pow(k / n, 2));
      if (s.role === 'tower') {
        for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const p = new THREE.Mesh(new THREE.BoxGeometry(0.12, top + 1, 0.12), metal);
          p.position.set(dx, (top + 1) / 2, dz);
          g.add(p);
        }
        add(2.4, 0.15, 2.4, 0, top + 1, 0, 0, metal);
      } else {
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.05, sc.stage.h - top, 0.05), metal);
        p.position.set(0, (sc.stage.h + top) / 2, 0);
        g.add(p);
      }
    } else if (s.type === 'point') {
      add(0.6, 0.9, 0.5, 0, s.z, 0);
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, s.z - 0.45, 8), metal);
      p.position.y = (s.z - 0.45) / 2;
      g.add(p);
    } else {
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) add(1.1, 0.6, 0.8, 0, 0.3 + i * 0.62, (j - 0.5) * 1.15);
    }
  }
}

function buildCrowd(sc) {
  const a = sc.audience, r = rng(21);
  const area = a.type === 'rect' ? (a.x1 - a.x0) * (a.y1 - a.y0) : Math.PI * a.rx * a.ry * 0.9;
  const N = Math.min(4500, Math.round(area / 2.2));
  const y0 = a.type === 'rect' ? a.y0 : a.ymin, y1 = a.type === 'rect' ? a.y1 : a.cy + a.ry;
  const x0 = a.type === 'rect' ? a.x0 : -a.rx, x1 = a.type === 'rect' ? a.x1 : a.rx;
  const geo = new THREE.CylinderGeometry(0.22, 0.26, 1.65, 6);
  geo.translate(0, 0.825, 0);
  const mesh = new THREE.InstancedMesh(geo, M(0xffffff), N);
  const pal = [0x222222, 0xf1f3f5, 0x1971c2, 0xc92a2a, 0x2f9e44, 0xf08c00, 0x6741d9, 0x868e96].map(c => new THREE.Color(c));
  const dummy = new THREE.Object3D();
  crowdBaseY = new Float32Array(N); crowdPhase = new Float32Array(N);
  let i = 0, guard = 0;
  while (i < N && guard++ < N * 30) {
    const x = x0 + r() * (x1 - x0), y = y0 + r() * (y1 - y0);
    if (a.type !== 'rect') { const u = x / a.rx, v = (y - a.cy) / a.ry; if (u * u + v * v > 1) continue; }
    if (r() > Math.exp(-1.6 * (y - y0) / (y1 - y0)) + 0.12) continue;
    if (Math.abs(x - sc.foh[0]) < 6 && Math.abs(y - sc.foh[1] - 1) < 5) continue;
    dummy.position.set(x, 0, y);
    dummy.scale.set(1, 0.9 + r() * 0.2, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, pal[Math.floor(r() * pal.length)]);
    crowdPhase[i] = r() * Math.PI * 2;
    i++;
  }
  mesh.count = i;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(mesh);
  crowd = mesh;
}

function buildTrees(t, sc) {
  const [ax, ay, bx, by] = t;
  const L = Math.hypot(bx - ax, by - ay);
  const ref = sc.reflectors.find(r => r.ax === ax && r.ay === ay && r.bx === bx && r.by === by);
  const h = ref ? ref.h : 12;
  if (h < 5) { segBox(ax, ay, bx, by, h, 1.5, M(0x2f5e2a)); return; }
  const n = Math.ceil(L / 7), r = rng(n);
  const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(3.2, h * 0.75, 7), M(0x2d6a2f), n);
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.3, 0.4, h * 0.3, 6), M(0x5a4030), n);
  const d = new THREE.Object3D();
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n, x = ax + (bx - ax) * u + (r() - 0.5) * 3, y = ay + (by - ay) * u + (r() - 0.5) * 3;
    const s = 0.8 + r() * 0.4;
    d.position.set(x, h * 0.3 + h * 0.375 * s, y); d.scale.set(s, s, s); d.updateMatrix(); crown.setMatrixAt(i, d.matrix);
    d.position.set(x, h * 0.15, y); d.scale.set(1, 1, 1); d.updateMatrix(); trunk.setMatrixAt(i, d.matrix);
  }
  root.add(crown, trunk);
}

function buildRidge(r) {
  const [ax, ay, bx, by] = r;
  const L = Math.hypot(bx - ax, by - ay), n = Math.ceil(L / 350), rr = rng(L);
  const mat = M(0x3c5a3a);
  for (let i = 0; i <= n; i++) {
    const u = i / n, h = 120 + rr() * 160;
    const m = new THREE.Mesh(new THREE.ConeGeometry(260 + rr() * 120, h, 7), mat);
    const nx = -(by - ay) / L, ny = (bx - ax) / L, off = 80 * (rr() - 0.2);
    m.position.set(ax + (bx - ax) * u + nx * off, h / 2, ay + (by - ay) * u + ny * off);
    root.add(m);
  }
}

function setPrecip(kind) {
  if (precip) { s3.remove(precip); dispose(precip); precip = null; }
  precipKind = kind;
  if (!kind) return;
  const N = kind === 'rain' ? 6000 : 4000, p = new Float32Array(N * 3), r = rng(3);
  for (let i = 0; i < N; i++) { p[i * 3] = (r() - 0.5) * 80; p[i * 3 + 1] = r() * 30; p[i * 3 + 2] = (r() - 0.5) * 80; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  precip = new THREE.Points(g, new THREE.PointsMaterial({ color: kind === 'rain' ? 0xaabbdd : 0xffffff, size: kind === 'rain' ? 0.08 : 0.15, transparent: true, opacity: 0.8 }));
  s3.add(precip);
}

V.setRoute = function (route, start, seat) {
  if (!root) return;
  const old = root.getObjectByName('route');
  if (old) { root.remove(old); dispose(old); }
  const g = new THREE.Group();
  g.name = 'route';
  const pts = route.map(p => P3(p[0], p[1], 0.06));
  const lg = new THREE.BufferGeometry().setFromPoints(pts);
  const line = new THREE.Line(lg, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 1.5, gapSize: 1.5 }));
  line.computeLineDistances();
  g.add(line);
  const pole = (p, color, h) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, h, 8), M(color));
    m.position.set(p[0], h / 2, p[1]);
    const f = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.7, 0.05), new THREE.MeshBasicMaterial({ color }));
    f.position.set(p[0] + 0.6, h - 0.4, p[1]);
    g.add(m, f);
  };
  pole(start, 0x2b8a3e, 3);
  pole(seat, 0xc2255c, 2.6);
  root.add(g);
};
const P3 = (x, y, h) => new THREE.Vector3(x, h || 0, y);

V.setHeat = function (canvas, x0, y0, x1, y1, show) {
  if (!root) return;
  if (heatMesh) { root.remove(heatMesh); dispose(heatMesh); heatMesh = null; }
  if (!canvas || !show) return;
  const t = new THREE.CanvasTexture(canvas);
  t.magFilter = THREE.LinearFilter;
  heatMesh = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, y1 - y0), new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.3, depthWrite: false }));
  heatMesh.rotation.x = -Math.PI / 2; // image row 0 (y0) lands at -z side = small world y
  heatMesh.position.set((x0 + x1) / 2, 0.08, (y0 + y1) / 2);
  root.add(heatMesh);
};

// L: {x, y, heading, pitch}, lvl: 0..1 music level
V.render = function (L, lvl) {
  if (!renderer) return;
  const t = (performance.now() - t0) / 1000;
  cam.position.set(L.x, EYE, L.y);
  const cp = Math.cos(L.pitch);
  cam.lookAt(L.x + Math.cos(L.heading) * cp, EYE + Math.sin(L.pitch), L.y + Math.sin(L.heading) * cp);
  sky.position.copy(cam.position);
  if (crowd) {
    const arr = crowd.instanceMatrix.array, beat = t * 2 * Math.PI * 128 / 60;
    for (let i = 0; i < crowd.count; i++) arr[i * 16 + 13] = 0.25 * lvl * Math.max(0, Math.sin(beat + crowdPhase[i] * 0.3));
    crowd.instanceMatrix.needsUpdate = true;
  }
  const hue = (t * 0.05) % 1;
  for (let i = 0; i < screens.length; i++) screens[i].material.color.setHSL((hue + i * 0.1) % 1, 0.7, 0.15 + 0.45 * lvl);
  for (const b of beams) {
    const ph = b.userData.phase;
    b.rotation.x = -2.6 + 0.35 * Math.sin(t * 0.7 + ph);
    b.rotation.z = 0.5 * Math.sin(t * 0.5 + ph * 1.3);
    b.material.opacity = 0.06 + 0.18 * lvl;
  }
  if (precip) {
    const p = precip.geometry.attributes.position, fall = precipKind === 'rain' ? 0.6 : 0.05;
    for (let i = 0; i < p.count; i++) {
      let y = p.getY(i) - fall;
      if (y < 0) y += 30;
      p.setY(i, y);
    }
    p.needsUpdate = true;
    precip.position.set(L.x, 0, L.y);
  }
  renderer.render(s3, cam);
};

window.View3D = V;
})();
