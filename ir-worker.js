/* ir-worker.js — computes impulse responses and level maps off the main thread. */
importScripts('acoustics.js');
const A = self.Acoustics;
let scene = null, bctx = null, cctx = null;
const cache = {};

self.onmessage = e => {
  const m = e.data;
  if (m.type === 'scene') {
    scene = m.scene;
    bctx = A.prepareScene(scene);
    cctx = A.makeFreqCtx(scene, A.coarseFreqs(scene.sr, A.IR_K));
    return;
  }
  if (!scene) return;
  if (m.type === 'ir') {
    const r = A.synthIR(scene, cctx, bctx, m.x, m.y, m.z, m.hx, m.hy, m.N, cache);
    const L = r.level, mp = L.mainPath;
    const info = {
      dBA: A.dBA(L.E), dBAd: A.dBA(L.Ed), dBAi: A.dBA(L.Ei), dBAv: A.dBA(L.Ev), dBAe: A.dBA(L.Ee),
      bands: Array.from(L.E, v => 100 + 10 * Math.log10(v + 1e-20)),
      barrier1k: L.barrier1k, inside: L.inside, a: mp.a, dh: mp.dh, crowd: mp.crowd,
      shadow: A.shadowDistance(mp.a, scene.climate.c, scene.speakers[0].z, m.z),
      nImages: r.nImages, fr: r.fr,
    };
    self.postMessage({ type: 'ir', id: m.id, version: m.version, chans: r.chans, info }, r.chans.map(c => c.buffer));
    return;
  }
  if (m.type === 'map') {
    const { x0, y0, x1, y1, nx, ny } = m;
    const out = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = x0 + (i + 0.5) * (x1 - x0) / nx, y = y0 + (j + 0.5) * (y1 - y0) / ny;
        out[j * nx + i] = A.dBA(A.levelAt(scene, bctx, x, y, A.LISTENER_Z, true).E);
      }
    }
    self.postMessage({ type: 'map', id: m.id, version: m.version, data: out, nx, ny, x0, y0, x1, y1 }, [out.buffer]);
  }
};
