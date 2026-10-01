/* sounds.js — procedural demo song and ambient sounds (no audio files needed). */
(function (root) {
'use strict';
const S = {};
const TAU = 2 * Math.PI;

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ------------------------------------------------------------------ demo song
// 128 BPM, 16 bars, Am - F - C - G, rendered offline
S.renderDemo = async function (sr) {
  const bpm = 128, beat = 60 / bpm, bars = 16, len = Math.ceil(bars * 4 * beat * sr);
  const ctx = new OfflineAudioContext(2, len, sr);
  const out = ctx.createGain();
  out.gain.value = 0.5;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.12;
  out.connect(comp).connect(ctx.destination);

  const r = rng(7);
  const nbuf = ctx.createBuffer(1, sr, sr);
  const nd = nbuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = r() * 2 - 1;
  const noise = (t, dur, type, f, q, gain, pan) => {
    const s = ctx.createBufferSource(); s.buffer = nbuf;
    const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    const p = ctx.createStereoPanner(); p.pan.value = pan || 0;
    s.connect(fl).connect(g).connect(p).connect(out);
    s.start(t, r() * 0.5); s.stop(t + dur + 0.01);
  };
  const midi = n => 440 * Math.pow(2, (n - 69) / 12);
  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
  const roots = [33, 29, 36, 31];

  // sidechain pump bus for pads and bass
  const pump = ctx.createGain();
  pump.connect(out);
  for (let b = 0; b < bars * 4; b++) {
    const t = b * beat;
    pump.gain.setValueAtTime(0.25, t);
    pump.gain.linearRampToValueAtTime(1, t + beat * 0.6);
  }

  for (let bar = 0; bar < bars; bar++) {
    const t0 = bar * 4 * beat, ci = bar % 4;
    const full = bar >= 4;
    for (let k = 0; k < 4; k++) {
      const t = t0 + k * beat;
      // kick
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      g.gain.setValueAtTime(1.1, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      o.connect(g).connect(out); o.start(t); o.stop(t + 0.5);
      noise(t, 0.012, 'highpass', 3000, 0.7, 0.25);
      // clap on 2 and 4
      if (k % 2 === 1 && full) {
        for (let j = 0; j < 3; j++) noise(t + j * 0.011, 0.2, 'bandpass', 1500, 0.9, 0.55);
        const tt = ctx.createOscillator(), tg = ctx.createGain();
        tt.type = 'triangle'; tt.frequency.value = 190;
        tg.gain.setValueAtTime(0.3, t); tg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        tt.connect(tg).connect(out); tt.start(t); tt.stop(t + 0.12);
      }
      // hats
      noise(t + beat / 2, 0.06, 'highpass', 7500, 0.7, 0.32, 0.2);
      if (full) for (const q of [0.25, 0.75]) noise(t + beat * q, 0.03, 'highpass', 9000, 0.7, 0.12, -0.25);
      // bass on off-beats
      for (const q of [0.5]) {
        const bt = t + beat * q;
        const bo = ctx.createOscillator(), bf = ctx.createBiquadFilter(), bg = ctx.createGain();
        bo.type = 'sawtooth'; bo.frequency.value = midi(roots[ci] + 12);
        bf.type = 'lowpass'; bf.Q.value = 6;
        bf.frequency.setValueAtTime(1400, bt); bf.frequency.exponentialRampToValueAtTime(180, bt + 0.2);
        bg.gain.setValueAtTime(0.0001, bt); bg.gain.linearRampToValueAtTime(0.5, bt + 0.01);
        bg.gain.exponentialRampToValueAtTime(0.001, bt + beat * 0.48);
        bo.connect(bf).connect(bg).connect(pump); bo.start(bt); bo.stop(bt + beat * 0.5);
        const so = ctx.createOscillator(), sg = ctx.createGain();
        so.frequency.value = midi(roots[ci]);
        sg.gain.setValueAtTime(0.0001, bt); sg.gain.linearRampToValueAtTime(0.5, bt + 0.01);
        sg.gain.exponentialRampToValueAtTime(0.001, bt + beat * 0.48);
        so.connect(sg).connect(pump); so.start(bt); so.stop(bt + beat * 0.5);
      }
    }
    // supersaw pad
    const padF = ctx.createBiquadFilter(); padF.type = 'lowpass'; padF.frequency.value = full ? 3200 : 1200; padF.Q.value = 0.7;
    const padG = ctx.createGain();
    padG.gain.setValueAtTime(0.0001, t0); padG.gain.linearRampToValueAtTime(0.06, t0 + 0.05);
    padG.gain.setValueAtTime(0.06, t0 + 4 * beat - 0.08); padG.gain.linearRampToValueAtTime(0.0001, t0 + 4 * beat);
    padF.connect(padG).connect(pump);
    for (const n of chords[ci].concat([chords[ci][0] + 12])) {
      for (const [det, pan] of [[-14, -0.8], [-5, -0.3], [5, 0.3], [14, 0.8]]) {
        const o = ctx.createOscillator(), p = ctx.createStereoPanner();
        o.type = 'sawtooth'; o.frequency.value = midi(n); o.detune.value = det; p.pan.value = pan;
        o.connect(p).connect(padF); o.start(t0); o.stop(t0 + 4 * beat);
      }
    }
    // lead arpeggio in the second half
    if (bar >= 8) {
      const arp = [0, 1, 2, 3, 2, 1, 0, 2];
      const notes = chords[ci].concat([chords[ci][0] + 12]);
      for (let s = 0; s < 16; s++) {
        const t = t0 + s * beat / 4;
        const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain(), p = ctx.createStereoPanner();
        o.type = 'square'; o.frequency.value = midi(notes[arp[s % 8]] + 12);
        f.type = 'lowpass'; f.frequency.value = 2600;
        g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.07, t + 0.005);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
        p.pan.value = s % 2 ? 0.35 : -0.35;
        o.connect(f).connect(g).connect(p).connect(out); o.start(t); o.stop(t + 0.18);
      }
    }
  }
  const buf = await ctx.startRendering();
  S.normalize(buf, 0.15);
  return buf;
};

// scale a buffer to the given RMS (peak-limited)
S.normalize = function (buf, rms) {
  let e = 0, n = 0, pk = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { e += d[i] * d[i]; pk = Math.max(pk, Math.abs(d[i])); }
    n += d.length;
  }
  const g = Math.min(rms / Math.sqrt(e / n || 1e-12), 0.98 / (pk || 1));
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
};

// ------------------------------------------------------------------ simple DSP
function biquad(x, type, f0, Q, sr) {
  const w = TAU * Math.min(f0, sr * 0.45) / sr, cw = Math.cos(w), al = Math.sin(w) / (2 * Q);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
  else if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
  else { b0 = al; b1 = 0; b2 = -al; }
  const a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
  b0 /= a0; b1 /= a0; b2 /= a0; const c1 = a1 / a0, c2 = a2 / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i], y = b0 * xi + b1 * x1 + b2 * x2 - c1 * y1 - c2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = y; x[i] = y;
  }
  return x;
}
function white(n, r) { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = r() * 2 - 1; return x; }
function pink(n, r) {
  const x = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
    x[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
  }
  return x;
}
// smooth random envelope (values ~[0,1]) with the given rate in Hz
function slowRandom(n, sr, rate, r) {
  const x = new Float32Array(n);
  const step = Math.max(1, Math.floor(sr / rate));
  let a = r(), b = r();
  for (let i = 0; i < n; i++) {
    if (i % step === 0) { a = b; b = r(); }
    const u = (i % step) / step, s = u * u * (3 - 2 * u);
    x[i] = a + (b - a) * s;
  }
  return x;
}
function setRms(x, rms) {
  let e = 0; for (let i = 0; i < x.length; i++) e += x[i] * x[i];
  const g = rms / Math.sqrt(e / x.length || 1e-12);
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}
// make a loop seamless by cross-fading the end into the start
function loopify(x, sr) {
  const n = Math.floor(0.5 * sr), L = x.length - n;
  const y = new Float32Array(L);
  for (let i = 0; i < L; i++) y[i] = x[i];
  for (let i = 0; i < n; i++) { const u = i / n; y[i] = x[i] * u + x[L + i] * (1 - u); }
  return y;
}
function toBuffer(ctx, chans) {
  const b = ctx.createBuffer(chans.length, chans[0].length, ctx.sampleRate);
  chans.forEach((d, i) => b.copyToChannel(d, i));
  return b;
}

// ------------------------------------------------------------------ ambient beds (RMS 0.1 each)
S.makeAmbient = function (ctx) {
  const sr = ctx.sampleRate, r = rng(99);
  const mk = (secs, fn) => {
    const n = Math.floor(secs * sr) + Math.floor(0.5 * sr);
    return toBuffer(ctx, [0, 1].map(ch => setRms(loopify(fn(n, ch), sr), 0.1)));
  };
  const out = {};
  // crowd: babble of many voices + slow swells
  out.crowd = mk(12, n => {
    const y = new Float32Array(n);
    for (let v = 0; v < 14; v++) {
      const x = biquad(biquad(pink(n, r), 'bp', 250 + r() * 1800, 2.5, sr), 'lp', 3500, 0.7, sr);
      const syl = slowRandom(n, sr, 3 + r() * 4, r);
      const act = slowRandom(n, sr, 0.3 + r() * 0.4, r);
      for (let i = 0; i < n; i++) y[i] += x[i] * Math.pow(syl[i], 2) * (act[i] > 0.4 ? 1 : 0.25);
    }
    const sw = slowRandom(n, sr, 0.15, r);
    for (let i = 0; i < n; i++) y[i] *= 0.6 + 0.8 * sw[i];
    return y;
  });
  // traffic: low rumble with passing cars
  out.traffic = mk(16, n => {
    const x = biquad(biquad(pink(n, r), 'lp', 600, 0.7, sr), 'hp', 40, 0.7, sr);
    const pass = slowRandom(n, sr, 0.25, r);
    for (let i = 0; i < n; i++) x[i] *= 0.5 + Math.pow(pass[i], 3) * 2;
    return x;
  });
  // wind at the ears: low-frequency buffeting with gusts
  out.wind = mk(14, n => {
    const x = biquad(biquad(pink(n, r), 'lp', 250, 0.9, sr), 'hp', 20, 0.7, sr);
    const g = slowRandom(n, sr, 0.6, r), g2 = slowRandom(n, sr, 3, r);
    for (let i = 0; i < n; i++) x[i] *= 0.2 + 1.6 * g[i] * (0.6 + 0.4 * g2[i]);
    return x;
  });
  // rain: hiss + droplets
  out.rain = mk(8, n => {
    const x = biquad(biquad(white(n, r), 'hp', 1200, 0.7, sr), 'lp', 9000, 0.7, sr);
    for (let i = 0; i < n; i++) x[i] *= 0.4;
    for (let k = 0; k < n / sr * 120; k++) {
      const p = Math.floor(r() * (n - 400)), a = 0.5 + r() * 1.5, f = 2000 + r() * 4000;
      for (let i = 0; i < 300; i++) x[p + i] += a * Math.exp(-i / 40) * Math.sin(TAU * f * i / sr);
    }
    return x;
  });
  // sea waves: slow swells of filtered noise
  out.waves = mk(16, n => {
    const x = biquad(pink(n, r), 'lp', 1500, 0.7, sr);
    for (let i = 0; i < n; i++) { const ph = (i / sr) / 8 * TAU; x[i] *= Math.pow(0.5 + 0.5 * Math.sin(ph), 3) + 0.15; }
    return x;
  });
  return out;
};

// ------------------------------------------------------------------ footsteps per ground type
S.makeSteps = function (ctx) {
  const sr = ctx.sampleRate, r = rng(3);
  const mk = fn => [0, 1, 2].map(() => toBuffer(ctx, [setRms(fn(Math.floor(0.25 * sr)), 0.1)]));
  const env = (x, att, dec) => { for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] *= Math.min(1, t / att) * Math.exp(-t / dec); } return x; };
  const grains = (x, count, f, spread, dec) => {
    for (let k = 0; k < count; k++) {
      const p = Math.floor(Math.pow(r(), 1.5) * spread * sr), a = r();
      for (let i = 0; i < 400 && p + i < x.length; i++) x[p + i] += a * (r() * 2 - 1) * Math.exp(-i / (dec * sr));
    }
    return biquad(x, 'bp', f, 1.2, sr);
  };
  return {
    grass: mk(n => biquad(env(white(n, r), 0.01, 0.05), 'lp', 1800, 0.7, sr)),
    soil: mk(n => biquad(env(white(n, r), 0.002, 0.03), 'lp', 900, 0.9, sr)),
    sand: mk(n => biquad(env(white(n, r), 0.015, 0.06), 'lp', 1300, 0.7, sr)),
    gravel: mk(n => grains(new Float32Array(n), 40, 3500, 0.12, 0.0008)),
    asphalt: mk(n => { const x = biquad(env(white(n, r), 0.0005, 0.012), 'hp', 1500, 0.7, sr); const y = env(white(n, r), 0.001, 0.02); biquad(y, 'lp', 300, 0.7, sr); for (let i = 0; i < n; i++) x[i] += y[i] * 2; return x; }),
    snow: mk(n => grains(new Float32Array(n), 60, 1800, 0.15, 0.002)),
  };
};

root.Sounds = S;
})(typeof self !== 'undefined' ? self : globalThis);
