// fixtures-break.mjs
//
// Synthetic drum breaks for the STRETCH FX tests - no audio files in the repo. A kick is a decaying
// sine sweep, a snare a noise burst over a 190Hz body, hats short high-passed noise, a crash a long
// bright noise wash. Deterministic (seeded noise), so every test run hears the same break.
import { makeRng } from "../js/dsp/stretch/rng.js";

/** Raised-cosine taper over the last 30% of a voice, so a drum never ends on a click (which the onset detector would rightly hear as a hit). */
function taper(i, n) {
  const start = n * 0.7;
  return i < start ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (i - start)) / (n - start));
}

function addKick(buf, sr, at, amp = 0.9) {
  const n = Math.round(0.28 * sr);
  const s = Math.round(at * sr);
  let ph = 0;
  for (let i = 0; i < n && s + i < buf.length; i++) {
    const t = i / sr;
    ph += (2 * Math.PI * (48 + 110 * Math.exp(-t * 30))) / sr;
    buf[s + i] += amp * Math.sin(ph) * Math.exp(-t * 11) * taper(i, n);
  }
}

function addSnare(buf, sr, at, rng, amp = 0.8) {
  const n = Math.round(0.22 * sr);
  const s = Math.round(at * sr);
  let lp = 0;
  for (let i = 0; i < n && s + i < buf.length; i++) {
    const t = i / sr;
    const noise = rng.signed();
    lp += 0.35 * (noise - lp);
    const hp = noise - lp; // bright-ish noise
    buf[s + i] += amp * (0.75 * hp * Math.exp(-t * 18) + 0.5 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30)) * taper(i, n);
  }
}

function addHat(buf, sr, at, rng, amp = 0.25, len = 0.05) {
  const n = Math.round(len * sr);
  const s = Math.round(at * sr);
  let prev = 0;
  for (let i = 0; i < n && s + i < buf.length; i++) {
    const noise = rng.signed();
    const hp = noise - prev;
    prev = noise;
    buf[s + i] += amp * hp * Math.exp(-(i / sr) * (len > 0.3 ? 5 : 60)) * taper(i, n);
  }
}

/**
 * @param {object} [opts] {bpm=170, bars=4, sampleRate=44100, stereo=true, messy=false, crash=true}
 * @returns {{channels: Float32Array[], sampleRate:number, bpm:number, snareTimes:number[]}}
 */
export function makeBreak({ bpm = 170, bars = 4, sampleRate = 44100, stereo = true, messy = false, crash = true, seed = 5 } = {}) {
  const rng = makeRng(seed);
  const beat = 60 / bpm;
  const n = Math.round(bars * 4 * beat * sampleRate);
  const mono = new Float32Array(n);
  const snareTimes = [];
  const jitter = () => (messy ? rng.signed() * 0.012 : 0);
  for (let b = 0; b < bars; b++) {
    const t0 = b * 4 * beat;
    // Amen-ish: kick 1, 1&, snare 2, ghost, kick 3&, snare 4, ghost
    addKick(mono, sampleRate, t0 + jitter());
    addKick(mono, sampleRate, t0 + 0.5 * beat + jitter(), 0.7);
    addKick(mono, sampleRate, t0 + 2.5 * beat + jitter(), 0.8);
    for (const sb of [1, 3]) {
      const t = t0 + sb * beat + jitter();
      addSnare(mono, sampleRate, t, rng);
      snareTimes.push(t);
    }
    addSnare(mono, sampleRate, t0 + 1.75 * beat + jitter(), rng, messy ? 0.5 : 0.25);
    addSnare(mono, sampleRate, t0 + 3.5 * beat + jitter(), rng, messy ? 0.45 : 0.2);
    for (let e = 0; e < 8; e++) addHat(mono, sampleRate, t0 + e * 0.5 * beat + jitter(), rng, messy ? 0.35 : 0.22);
    if (messy) for (let k = 0; k < 6; k++) addHat(mono, sampleRate, t0 + rng.next() * 4 * beat, rng, 0.3);
  }
  if (crash) addHat(mono, sampleRate, (bars - 1) * 4 * beat, rng, 0.4, 1.2);
  let peak = 0;
  for (const v of mono) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < n; i++) mono[i] *= 0.9 / peak;
  const channels = stereo ? [mono, Float32Array.from(mono, (v, i) => v * 0.9 + (mono[i - 1] || 0) * 0.1)] : [mono];
  return { channels, sampleRate, bpm, snareTimes };
}
