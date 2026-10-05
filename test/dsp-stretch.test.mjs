// Node-side unit tests for the expanded time-stretch DSP system:
// js/dsp/stretch/{fft,characters,index,wsola,phase-vocoder,granular,repeat,
// spectral-freeze,paulstretch,varispeed}.js. Run with: node test/dsp-stretch.test.mjs
//
// This is deliberately a numeric sanity suite, not a listening test - it checks every engine
// produces well-behaved output (finite, roughly the right length, stereo-coherent, deterministic
// under a seed) across the whole character palette, not whether any character sounds good. Sound
// quality was judged by ear during development; this suite exists so a later refactor can't quietly
// break an engine into producing NaN/garbage without anyone noticing until export.
import assert from "node:assert/strict";
import { fft, ifft, nextPow2, wrapPhase } from "../js/dsp/stretch/fft.js";
import { makeRng } from "../js/dsp/stretch/rng.js";
import { stretchChannels, ratioForTargetTempo, resolveCharacter, CHARACTERS, characterGroups, DEFAULT_MAX_RATIO, MAX_OUTPUT_SECONDS } from "../js/dsp/stretch/index.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const SR = 22050;
function tone(seconds, freq = 220, amp = 0.6) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}
function isFiniteBuffer(buf) {
  for (const v of buf) if (!Number.isFinite(v)) return false;
  return true;
}
function peakAbs(buf) {
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  return peak;
}

// ---------------------------------------------------------------------------
// fft.js
// ---------------------------------------------------------------------------

test("fft/ifft: round-trips a random signal within floating-point tolerance", () => {
  const n = 512;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const original = new Float64Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    original[i] = re[i] = (seed / 0x7fffffff) * 2 - 1;
  }
  fft(re, im);
  ifft(re, im);
  let maxErr = 0;
  for (let i = 0; i < n; i++) {
    maxErr = Math.max(maxErr, Math.abs(re[i] - original[i]), Math.abs(im[i]));
  }
  assert.ok(maxErr < 1e-9, `round-trip error too large: ${maxErr}`);
});

test("fft: a single-frequency sine produces energy concentrated at the matching bin", () => {
  const n = 256;
  const k = 10; // bin -> frequency n/k cycles over the buffer... use frequency = k cycles/buffer
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * k * i) / n);
  fft(re, im);
  let peakBin = 0;
  let peakMag = 0;
  for (let i = 0; i <= n / 2; i++) {
    const mag = Math.hypot(re[i], im[i]);
    if (mag > peakMag) {
      peakMag = mag;
      peakBin = i;
    }
  }
  assert.equal(peakBin, k, "peak magnitude should be at the sine's own bin");
});

test("nextPow2: rounds up to the nearest power of two, exact powers pass through", () => {
  assert.equal(nextPow2(1), 1);
  assert.equal(nextPow2(2), 2);
  assert.equal(nextPow2(500), 512);
  assert.equal(nextPow2(1024), 1024);
  assert.equal(nextPow2(1025), 2048);
});

test("wrapPhase: keeps values in [-PI, PI] and is a no-op inside that range", () => {
  assert.ok(Math.abs(wrapPhase(0.5) - 0.5) < 1e-9);
  const wrapped = wrapPhase(3 * Math.PI);
  assert.ok(wrapped >= -Math.PI - 1e-9 && wrapped <= Math.PI + 1e-9);
});

// ---------------------------------------------------------------------------
// rng.js
// ---------------------------------------------------------------------------

test("makeRng: same seed reproduces the same sequence, different seeds diverge", () => {
  const a = makeRng(42);
  const b = makeRng(42);
  const c = makeRng(43);
  const seqA = Array.from({ length: 10 }, () => a.next());
  const seqB = Array.from({ length: 10 }, () => b.next());
  const seqC = Array.from({ length: 10 }, () => c.next());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
});

// ---------------------------------------------------------------------------
// stretchChannels: every character in the registry, mono + stereo
// ---------------------------------------------------------------------------

const ALL_KEYS = Object.keys(CHARACTERS);

test("characterGroups(): every registered character appears in exactly one group", () => {
  const grouped = characterGroups()
    .flatMap((g) => g.characters)
    .map((c) => c.key);
  assert.equal(grouped.length, ALL_KEYS.length);
  assert.deepEqual(new Set(grouped), new Set(ALL_KEYS));
});

test("stretchChannels: ratio 1 is a no-op copy for every character", () => {
  const input = tone(0.3, 220);
  for (const key of ALL_KEYS) {
    const [out] = stretchChannels([input], SR, 1, key);
    assert.equal(out.length, input.length, `${key}: length should be unchanged at ratio 1`);
    assert.notEqual(out, input, `${key}: should return a copy, not the same array`);
  }
});

test("stretchChannels: every character produces finite, bounded output for a mono tone", () => {
  const input = tone(1.0, 220, 0.6);
  for (const key of ALL_KEYS) {
    const [out] = stretchChannels([input], SR, 1.6, key, { seed: 7 });
    assert.ok(isFiniteBuffer(out), `${key}: output should be finite`);
    assert.ok(peakAbs(out) < 2.0, `${key}: unexpectedly large peak ${peakAbs(out)}`);
  }
});

test("stretchChannels: every character handles stereo input and returns two channels of equal length", () => {
  const l = tone(0.5, 220);
  const r = tone(0.5, 330);
  for (const key of ALL_KEYS) {
    const [outL, outR] = stretchChannels([l, r], SR, 1.4, key, { seed: 3 });
    assert.equal(outL.length, outR.length, `${key}: L/R length mismatch`);
    assert.ok(isFiniteBuffer(outL) && isFiniteBuffer(outR), `${key}: stereo output should be finite`);
  }
});

test("stretchChannels: identical L/R input stays identical after stretching (shared randomness across channels)", () => {
  const mono = tone(0.6, 300);
  for (const key of ALL_KEYS) {
    const [l, r] = stretchChannels([mono, mono], SR, 1.6, key, { seed: 5 });
    assert.equal(l.length, r.length, `${key}: length mismatch`);
    let maxDiff = 0;
    for (let i = 0; i < l.length; i++) maxDiff = Math.max(maxDiff, Math.abs(l[i] - r[i]));
    assert.ok(maxDiff < 1e-4, `${key}: expected identical L/R, max diff ${maxDiff}`);
  }
});

test("stretchChannels: silence in, silence-or-finite out (no NaN/Infinity, no blow-up) for every character", () => {
  const silence = new Float32Array(Math.round(0.4 * SR));
  for (const key of ALL_KEYS) {
    const [out] = stretchChannels([silence, silence], SR, 1.7, key, { seed: 9 });
    assert.ok(isFiniteBuffer(out), `${key}: silence should not produce NaN/Infinity`);
    assert.ok(peakAbs(out) < 0.05, `${key}: silence should stay near-silent, peak ${peakAbs(out)}`);
  }
});

test("stretchChannels: very short input (10 samples) is handled without throwing, for every character", () => {
  const tiny = Float32Array.from({ length: 10 }, (_, i) => 0.3 * Math.sin(i));
  for (const key of ALL_KEYS) {
    const [out] = stretchChannels([tiny], SR, 2.2, key, { seed: 1 });
    assert.ok(isFiniteBuffer(out), `${key}: tiny input should not produce NaN/Infinity`);
  }
});

test("stretchChannels: output length is roughly right (within 15%) for ratio 2 and ratio 0.5, every character", () => {
  const input = tone(2.0, 220);
  for (const key of ALL_KEYS) {
    const [longer] = stretchChannels([input], SR, 2.0, key, { seed: 1 });
    const [shorter] = stretchChannels([input], SR, 0.5, key, { seed: 1 });
    const devLonger = Math.abs(longer.length - input.length * 2) / (input.length * 2);
    const devShorter = Math.abs(shorter.length - input.length * 0.5) / (input.length * 0.5);
    assert.ok(devLonger < 0.15, `${key}: ratio 2 length off by ${(devLonger * 100).toFixed(1)}%`);
    assert.ok(devShorter < 0.15, `${key}: ratio 0.5 length off by ${(devShorter * 100).toFixed(1)}%`);
  }
});

test("stretchChannels: extreme stretch ratios (well beyond the clamp) don't crash and stay finite", () => {
  const input = tone(0.05, 220);
  for (const key of ["spectral", "infinite", "frozen", "drone", "clean", "grain", "stutter", "cyclic"]) {
    const [out] = stretchChannels([input], SR, 50000, key, { seed: 1 });
    assert.ok(isFiniteBuffer(out), `${key}: extreme ratio should still be finite (clamped internally)`);
    assert.ok(out.length > input.length, `${key}: extreme ratio should still stretch, not shrink`);
  }
});

test("stretchChannels: every character reaches large stretch ratios for long textures", () => {
  const input = tone(0.3, 220);
  const bigRatio = 100;
  assert.ok(DEFAULT_MAX_RATIO >= 1000, `expected a huge default cap, got ${DEFAULT_MAX_RATIO}`);
  for (const key of Object.keys(CHARACTERS)) {
    const [out] = stretchChannels([input], SR, bigRatio, key, { seed: 1 });
    assert.ok(isFiniteBuffer(out));
    const dev = Math.abs(out.length - input.length * bigRatio) / (input.length * bigRatio);
    assert.ok(dev < 0.2, `${key}: length off by ${(dev * 100).toFixed(1)}% at ratio ${bigRatio}`);
  }
});

test("stretchChannels: STFT characters don't break up into silent gaps at big ratios", () => {
  // Regression: synthesis hop used to scale with the ratio, so past ~overlap x the frames stopped
  // overlapping and a steady tone came out as blips separated by silence.
  const input = tone(1.5, 220); // longer than Infinite's 500ms window, so edge fades don't count as gaps
  const block = Math.round(SR * 0.01);
  for (const key of ["transient", "punch", "phase", "metallic", "spectral", "infinite", "frozen", "drone"]) {
    for (const ratio of [8, 40]) {
      const [out] = stretchChannels([input], SR, ratio, key, { seed: 1 });
      let silent = 0;
      let blocks = 0;
      for (let s = Math.floor(out.length * 0.1); s + block < out.length * 0.9; s += block) {
        let e = 0;
        for (let i = 0; i < block; i++) e += out[s + i] * out[s + i];
        blocks++;
        if (Math.sqrt(e / block) < 0.02) silent++;
      }
      assert.ok(silent / blocks < 0.1, `${key} at ${ratio}x: ${((100 * silent) / blocks).toFixed(0)}% of the middle is silent`);
    }
  }
});

test("stretchChannels: output length is capped at MAX_OUTPUT_SECONDS whatever the ratio", () => {
  const input = tone(1.0, 220);
  const [out] = stretchChannels([input], SR, 1000, "cyclic");
  assert.ok(out.length <= MAX_OUTPUT_SECONDS * SR + 1, `expected <= ${MAX_OUTPUT_SECONDS}s, got ${(out.length / SR).toFixed(1)}s`);
  assert.ok(out.length >= MAX_OUTPUT_SECONDS * SR * 0.99);
});

test("cyclic: every cycle is an untouched copy of the source read at the output clock - no splice search", () => {
  const n = Math.round(0.5 * SR);
  const noise = new Float32Array(n);
  const rng = makeRng(3);
  for (let i = 0; i < n; i++) noise[i] = rng.signed() * 0.5;
  const ratio = 8;
  const [out] = stretchChannels([noise], SR, ratio, "cyclic", { macroValues: { cycle: 50, crossfade: 0 } });
  const cycle = Math.round(0.06 * SR); // crossfade 0 -> cycles butt up, hop == cycle length
  for (const c of [1, 5, 17, 40]) {
    const dst = c * cycle;
    const src = Math.round(dst / ratio);
    for (let i = 0; i < cycle; i += 97) assert.equal(out[dst + i], noise[src + i], `cycle ${c} sample ${i}`);
  }
});

test("cyclic: stereo channels share one cycle grid", () => {
  const l = tone(0.4, 220);
  const [a, b] = stretchChannels([l, Float32Array.from(l)], SR, 3, "cyclic12");
  assert.deepEqual(Array.from(a), Array.from(b));
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

const RANDOMIZED_CHARACTERS = ["grain", "scatter", "shred", "phase", "underwater", "spectral", "infinite", "cheap93"];

test("stretchChannels: same seed reproduces byte-identical output for every randomised character", () => {
  const input = tone(0.5, 220);
  for (const key of RANDOMIZED_CHARACTERS) {
    const [a] = stretchChannels([input], SR, 1.6, key, { seed: 7 });
    const [b] = stretchChannels([input], SR, 1.6, key, { seed: 7 });
    assert.deepEqual(Array.from(a), Array.from(b), `${key}: identical seed should reproduce identical output`);
  }
});

test("stretchChannels: different seeds produce different output for every randomised character", () => {
  const input = tone(0.5, 220);
  for (const key of RANDOMIZED_CHARACTERS) {
    const [a] = stretchChannels([input], SR, 1.6, key, { seed: 7 });
    const [b] = stretchChannels([input], SR, 1.6, key, { seed: 8 });
    let same = a.length === b.length;
    if (same) {
      same = true;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
          same = false;
          break;
        }
      }
    }
    assert.ok(!same, `${key}: different seeds should produce different output`);
  }
});

// ---------------------------------------------------------------------------
// Macro controls
// ---------------------------------------------------------------------------

test("stretchChannels: macro sliders at their extremes produce audibly different output than at default, for every macro-enabled character", () => {
  const input = tone(0.6, 220, 0.6);
  for (const [key, character] of Object.entries(CHARACTERS)) {
    if (!character.macros || !character.macros.length) continue;
    const low = {};
    const high = {};
    for (const m of character.macros) {
      low[m] = 0;
      high[m] = 100;
    }
    const [outLow] = stretchChannels([input], SR, 1.5, key, { seed: 1, macroValues: low });
    const [outHigh] = stretchChannels([input], SR, 1.5, key, { seed: 1, macroValues: high });
    assert.ok(isFiniteBuffer(outLow) && isFiniteBuffer(outHigh), `${key}: macro extremes should stay finite`);
    let same = outLow.length === outHigh.length;
    if (same) {
      for (let i = 0; i < outLow.length; i++) {
        if (Math.abs(outLow[i] - outHigh[i]) > 1e-6) {
          same = false;
          break;
        }
      }
    }
    assert.ok(!same, `${key}: macro sliders at 0 vs 100 should change the output`);
  }
});

test("stretchChannels: macro sliders at their default value are a no-op vs. omitting macroValues entirely", () => {
  const input = tone(0.6, 220, 0.6);
  for (const [key, character] of Object.entries(CHARACTERS)) {
    if (!character.macros || !character.macros.length) continue;
    const [withDefaults] = stretchChannels([input], SR, 1.5, key, {
      seed: 1,
      macroValues: { texture: 50, variation: 50, smear: 50, roughness: 50 },
    });
    const [withoutMacros] = stretchChannels([input], SR, 1.5, key, { seed: 1 });
    assert.deepEqual(Array.from(withDefaults), Array.from(withoutMacros), `${key}: default macro value should be a no-op`);
  }
});

// ---------------------------------------------------------------------------
// Backwards compatibility / character resolution
// ---------------------------------------------------------------------------

test("resolveCharacter: legacy character ids (clean, vintage, glitch, warped, crushed) still resolve, with their original DSP params intact", () => {
  assert.deepEqual(resolveCharacter("clean").params, { windowMs: 46, searchMs: 14, hopFraction: 0.5, bitDepth: null });
  assert.deepEqual(resolveCharacter("vintage").params, { windowMs: 24, searchMs: 5, hopFraction: 0.5, bitDepth: 12 });
  assert.deepEqual(resolveCharacter("glitch").params, { windowMs: 12, searchMs: 0, hopFraction: 0.5, bitDepth: 8 });
  assert.deepEqual(resolveCharacter("warped").params, { windowMs: 8, searchMs: 0, hopFraction: 0.5, bitDepth: null });
  assert.deepEqual(resolveCharacter("crushed").params, { windowMs: 30, searchMs: 10, hopFraction: 0.5, bitDepth: 6 });
  for (const key of ["clean", "vintage", "glitch", "warped", "crushed"]) {
    assert.equal(resolveCharacter(key).engine, "wsola", `${key}: legacy characters should still be WSOLA-based`);
  }
});

test("resolveCharacter: an unrecognised id (stale save, typo, corrupted setting) falls back to clean instead of throwing", () => {
  assert.equal(resolveCharacter("does-not-exist-anymore").label, "Clean");
  assert.equal(resolveCharacter(undefined).label, "Clean");
  assert.equal(resolveCharacter("").label, "Clean");
});

test("ratioForTargetTempo: higher target tempo -> shorter (ratio < 1), lower target -> longer (ratio > 1)", () => {
  assert.ok(Math.abs(ratioForTargetTempo(120, 120) - 1) < 1e-9);
  assert.ok(ratioForTargetTempo(120, 140) < 1);
  assert.ok(ratioForTargetTempo(120, 100) > 1);
  assert.equal(ratioForTargetTempo(null, 120), 1);
  assert.equal(ratioForTargetTempo(120, 0), 1);
});

// ---------------------------------------------------------------------------
// Worker integration (js/heavy-dsp-worker.js), simulated without a real Worker thread
// ---------------------------------------------------------------------------

test("heavy-dsp-worker.js: onmessage runs the real stretch + lo-fi + fade + encode pipeline and posts a result", async () => {
  const posted = [];
  globalThis.self = {
    onmessage: null,
    postMessage(msg) {
      posted.push(msg);
    },
  };
  await import("../js/heavy-dsp-worker.js?t=" + Date.now());
  assert.equal(typeof globalThis.self.onmessage, "function", "worker should register an onmessage handler");

  const channels = [tone(0.5, 220), tone(0.5, 220)];
  globalThis.self.onmessage({
    data: {
      type: "processRegions",
      requestId: 1,
      sampleRate: SR,
      bitDepth: 16,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      stretchRatio: 1.5,
      character: "scatter",
      macroValues: { variation: 70 },
      seed: 4,
      lofi: {},
      regions: [{ channels }],
    },
  });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, "processRegionsResult");
  assert.equal(posted[0].requestId, 1);
  assert.equal(posted[0].results.length, 1);
  assert.ok(posted[0].results[0].blob, "result should include an encoded WAV blob");
  const expectedSeconds = (channels[0].length * 1.5) / SR;
  assert.ok(Math.abs(posted[0].results[0].seconds - expectedSeconds) / expectedSeconds < 0.15);

  delete globalThis.self;
});

// --- regression: the output has to be FULL, not merely the right length ------------------

/** RMS of the last `frac` of a buffer relative to the whole - near zero means a silent tail. */
function tailFill(x, frac = 0.1) {
  const from = Math.floor(x.length * (1 - frac));
  let tail = 0;
  let all = 0;
  for (let i = 0; i < x.length; i++) {
    const e = x[i] * x[i];
    all += e;
    if (i >= from) tail += e;
  }
  const tailRms = Math.sqrt(tail / Math.max(1, x.length - from));
  const allRms = Math.sqrt(all / Math.max(1, x.length));
  return allRms > 0 ? tailRms / allRms : 0;
}

/** A dense, irregular break - the material that exposed the bug. */
function breakLoop(bpm, sampleRate = 44100) {
  const spb = 60 / bpm;
  const n = Math.round(4 * spb * sampleRate);
  const x = new Float32Array(n);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (const beat of [0, 0.5, 0.75, 1, 1.5, 2, 2.25, 2.5, 3, 3.25, 3.5, 3.75]) {
    const s = Math.round(beat * spb * sampleRate);
    const L = Math.round(spb * sampleRate * 0.5);
    for (let i = 0; i < L && s + i < n; i++) {
      const e = Math.exp(-i / (sampleRate * 0.03));
      x[s + i] += 0.25 * e * rnd() + 0.5 * e * Math.sin((2 * Math.PI * 180 * i) / sampleRate);
    }
  }
  return x;
}

test("stretchChannels: every character fills its whole output buffer", () => {
  // The bug: WSOLA accumulated the similarity search's forward nudges into its read
  // position, so the input ran out while the output buffer was only part-written. A break
  // stretched with Clean/Tight/Vintage came back the right LENGTH with silence on the end -
  // right duration, missing audio.
  const src = breakLoop(136);
  assert.ok(tailFill(src) > 0.5, "the source itself must have a loud tail for this to mean anything");
  for (const character of ["clean", "tight", "vintage", "glitch", "crushed", "transient", "punch", "grain"]) {
    for (const ratio of [0.855, 1.133, 1.347, 2.2]) {
      const [out] = stretchChannels([src], 44100, ratio, character);
      assert.equal(out.length, Math.round(src.length * ratio), `${character} @ ${ratio}: wrong length`);
      assert.ok(tailFill(out) > 0.4, `${character} @ ${ratio}: tail is ${tailFill(out).toFixed(3)} - the end of the buffer is empty`);
    }
  }
});

test("stretchChannels: a large stretch still fills the buffer", () => {
  // The failure got worse the further from 1.0 the ratio was, so the extremes matter most.
  const src = breakLoop(136);
  for (const ratio of [3.5, 6]) {
    const [out] = stretchChannels([src], 44100, ratio, "vintage");
    assert.ok(tailFill(out) > 0.4, `vintage @ ${ratio}: tail is ${tailFill(out).toFixed(3)}`);
  }
});

console.log(`\n${passed} test(s) passed.`);
