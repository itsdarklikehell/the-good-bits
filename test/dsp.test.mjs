// Node-side unit tests for the pure DSP + codec modules.
// Run with: node test/dsp.test.mjs
import assert from "node:assert/strict";
import {
  computeRmsEnvelope,
  linToDb,
  estimateNoiseFloorDb,
  nonSilentRegions,
  mergeRegions,
  padAndFilterRegions,
  lowestEnergyTime,
  splitLongNaturally,
  phraseRegions,
  onsetStrengthCurve,
  multiBandOnsetStrengthCurve,
  pickOnsets,
  snapToBeatGrid,
  refineGridStart,
  fitBeatGrid,
  drumRegions,
  drumRegionsFrom,
  findNearestZeroCrossing,
  applyFades,
  toMono,
  resampleLinear,
  sanitizeForPath,
  truncateStem,
  joinNameParts,
  buildKeyTempoTag,
  barsToSeconds,
  findAudibleStart,
  equalSliceRegions,
  bandEnergies,
  classifyHit,
  findOneShotWindows,
  dedupeHits,
  peakAbs,
  computePeaks,
  computePeaksInRange,
} from "../js/dsp.js";
import { encodeWav, parseWav, parseAiff } from "../js/audio-codec.js";

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

// --- synthetic signal helpers -----------------------------------------

const SR = 22050;

function silence(seconds) {
  return new Float32Array(Math.round(seconds * SR));
}

function tone(seconds, freq = 440, amp = 0.6) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function concat(...arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// --- envelope / silence --------------------------------------------------

test("computeRmsEnvelope: tone reads louder than silence", () => {
  const sig = concat(tone(1.0), silence(1.0));
  const { times, vals } = computeRmsEnvelope(sig, SR, 25, 10);
  assert.ok(times.length > 50);
  const loudIdx = times.findIndex((t) => t > 0.3 && t < 0.6);
  const quietIdx = times.findIndex((t) => t > 1.3 && t < 1.6);
  assert.ok(vals[loudIdx] > vals[quietIdx] * 5, "tone section should be much louder than silence");
});

test("linToDb / estimateNoiseFloorDb: near-zero floor for a mostly-silent signal", () => {
  const { vals } = computeRmsEnvelope(concat(tone(0.2), silence(2.0)), SR, 25, 10);
  const floor = estimateNoiseFloorDb(vals);
  assert.ok(floor < -50, `expected a low noise floor, got ${floor}`);
});

test("nonSilentRegions: finds two separated phrases in tone-gap-tone", () => {
  const sig = concat(tone(1.0), silence(1.0), tone(1.0));
  const { times, vals } = computeRmsEnvelope(sig, SR, 25, 10);
  const floor = estimateNoiseFloorDb(vals);
  const regions = nonSilentRegions(times, vals, floor + 15, 0.3);
  assert.equal(regions.length, 2, `expected 2 regions, got ${JSON.stringify(regions)}`);
  assert.ok(regions[0][1] < 1.2, "first region should end near t=1.0");
  assert.ok(regions[1][0] > 1.7, "second region should start near t=2.0");
});

test("mergeRegions: bridges a small gap, keeps a large one", () => {
  const merged = mergeRegions(
    [
      [0, 1],
      [1.1, 2],
      [4, 5],
    ],
    0.2
  );
  assert.deepEqual(merged, [
    [0, 2],
    [4, 5],
  ]);
});

test("padAndFilterRegions: pads and drops too-short regions", () => {
  const out = padAndFilterRegions(
    [
      [1, 3],
      [5, 5.05],
    ],
    0.1,
    0.5,
    10
  );
  assert.equal(out.length, 1);
  assert.ok(Math.abs(out[0][0] - 0.9) < 1e-9);
  assert.ok(Math.abs(out[0][1] - 3.1) < 1e-9);
});

test("lowestEnergyTime: picks the quietest point in range", () => {
  const times = [0, 1, 2, 3, 4];
  const vals = [0.9, 0.8, 0.1, 0.7, 0.9];
  assert.equal(lowestEnergyTime(times, vals, 0, 4, -1), 2);
});

test("splitLongNaturally: splits an over-long region into multiple pieces", () => {
  const times = [];
  const vals = [];
  for (let t = 0; t <= 40; t += 0.1) {
    times.push(t);
    vals.push(Math.abs(Math.sin(t)) + 0.05); // wobble so there's always a "lowest" point
  }
  const pieces = splitLongNaturally([[0, 40]], times, vals, 11, 18, 0.8);
  assert.ok(pieces.length >= 3, `expected several pieces, got ${pieces.length}`);
  for (const [s, e] of pieces) assert.ok(e - s <= 18 + 1e-6, "no piece should exceed maxLen");
  assert.ok(Math.abs(pieces[0][0] - 0) < 1e-9);
  assert.ok(Math.abs(pieces[pieces.length - 1][1] - 40) < 1e-9);
});

test("phraseRegions: end-to-end on a 3-phrase synthetic sax-like signal", () => {
  const sig = concat(tone(2.0, 440), silence(0.6), tone(3.0, 500), silence(0.8), tone(1.5, 460));
  const p = {
    silenceMarginDb: 18,
    minSilenceDuration: 0.32,
    mergeGap: 0.2,
    minLen: 0.8,
    maxLen: 18,
    preferred: 11,
    pad: 0.12,
  };
  const { regions } = phraseRegions(sig, SR, p);
  assert.equal(regions.length, 3, `expected 3 phrases, got ${JSON.stringify(regions)}`);
});

/**
 * A run of separately-attacked notes with no silence between them - legato playing, which is where
 * gate-and-split has nothing to work with. `dipAfter` inserts a quiet moment (a breath, a released
 * chord) after that many notes, the thing that actually ends a phrase.
 */
function noteRun(count, noteSec = 0.8, freq = 440, { dipAfter = null, dipSec = 0.35, dipAmp = 0.02, hissAmp = 0 } = {}) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const n = Math.round(noteSec * SR);
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      // Each note attacks and decays a little, so it reads as a note rather than one held tone.
      out[k] = 0.7 * Math.sin((2 * Math.PI * (freq + i * 20) * k) / SR) * Math.exp((-k / SR) * 1.2);
    }
    parts.push(out);
    if (dipAfter != null && i === dipAfter - 1) {
      const d = new Float32Array(Math.round(dipSec * SR));
      for (let k = 0; k < d.length; k++) d[k] = dipAmp * Math.sin((2 * Math.PI * 300 * k) / SR);
      parts.push(d);
    }
  }
  const sig = concat(...parts);
  if (hissAmp) {
    let seed = 7;
    for (let i = 0; i < sig.length; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      sig[i] += hissAmp * (seed / 1073741824 - 1);
    }
  }
  return sig;
}

/** Start of the first note after `t`, as these synthetic runs lay them out. */
function noteStartAfter(t, noteSec, dipSec, dipAfter) {
  return dipAfter * noteSec + dipSec;
}

test("phraseRegions: splits continuous playing at the breath, not at an arbitrary target length", () => {
  const noteSec = 0.8;
  const dipSec = 0.35;
  const sig = noteRun(10, noteSec, 440, { dipAfter: 5, dipSec });
  const p = { silenceMarginDb: 18, minSilenceDuration: 0.5, mergeGap: 0.4, minLen: 0.8, maxLen: 18, preferred: 11, pad: 0.12 };
  const { regions } = phraseRegions(sig, SR, p);
  assert.equal(regions.length, 2, `expected the two phrases either side of the breath, got ${JSON.stringify(regions)}`);
  const expected = noteStartAfter(0, noteSec, dipSec, 5);
  assert.ok(
    Math.abs(regions[1][0] - expected) < 0.12,
    `phrase 2 should start on the note after the breath (${expected}s), got ${regions[1][0]}s`
  );
});

test("phraseRegions: every phrase starts on a note attack, never part-way into one", () => {
  const noteSec = 0.8;
  const dipSec = 0.35;
  const dipAfter = 6;
  const sig = noteRun(12, noteSec, 440, { dipAfter, dipSec });
  // Where the notes actually are, breath included - what a phrase start has to land on.
  const noteStarts = [];
  for (let i = 0; i < 12; i++) noteStarts.push(i * noteSec + (i >= dipAfter ? dipSec : 0));
  // A short maxLen forces splits inside continuous playing, where there is no breath to find.
  const p = { silenceMarginDb: 18, minSilenceDuration: 0.5, mergeGap: 0.4, minLen: 0.8, maxLen: 4, preferred: 3, pad: 0.12 };
  const { regions } = phraseRegions(sig, SR, p);
  assert.ok(regions.length >= 3, `expected maxLen to force several phrases, got ${regions.length}`);
  for (const [s] of regions) {
    const nearest = noteStarts.reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a));
    assert.ok(
      s <= nearest + 0.02 && s >= nearest - 0.1,
      `phrase starting at ${s.toFixed(2)}s should sit just before the note at ${nearest.toFixed(2)}s`
    );
  }
});

test("phraseRegions: a hissy transfer keeps its audio instead of being gated away", () => {
  // Tape hiss puts the noise floor high enough that "floor + margin" lands in the middle of the
  // playing - which used to throw away most of the file.
  const sig = noteRun(8, 0.8, 440, { dipAfter: 4, hissAmp: 0.03 });
  const p = { silenceMarginDb: 10, minSilenceDuration: 0.5, mergeGap: 0.55, minLen: 1.8, maxLen: 20, preferred: 13, pad: 0.18 };
  const { regions } = phraseRegions(sig, SR, p);
  const covered = regions.reduce((sum, [s, e]) => sum + (e - s), 0);
  const duration = sig.length / SR;
  assert.ok(covered > duration * 0.85, `only ${(100 * covered / duration).toFixed(0)}% of the file ended up in a chop`);
});

test("phraseRegions: digital silence in the file doesn't break the gate", () => {
  // A file with true -inf silence reports a noise floor of -180dB, so a floor-relative gate sits
  // below anything that ever happens and nothing reads as a gap.
  const sig = concat(silence(1.0), noteRun(4, 0.8), silence(0.8), noteRun(4, 0.8, 520), silence(1.0));
  const p = { silenceMarginDb: 18, minSilenceDuration: 0.5, mergeGap: 0.4, minLen: 0.8, maxLen: 18, preferred: 11, pad: 0.12 };
  const { regions } = phraseRegions(sig, SR, p);
  assert.equal(regions.length, 2, `expected the two phrases, got ${JSON.stringify(regions)}`);
  assert.ok(regions[0][0] > 0.5, `phrase 1 should start at the music, not in the leading silence (got ${regions[0][0]}s)`);
  assert.ok(regions[1][1] < sig.length / SR - 0.5, `phrase 2 should end at the music, not in the trailing silence (got ${regions[1][1]}s)`);
});

// --- drum / onsets ---------------------------------------------------------

test("onsetStrengthCurve + pickOnsets: detects periodic hits", () => {
  // eight evenly-spaced "hits" (short loud bursts) in otherwise quiet audio
  const hitGap = 0.5;
  const parts = [];
  for (let i = 0; i < 8; i++) {
    parts.push(tone(0.08, 200, 0.9));
    parts.push(silence(hitGap - 0.08));
  }
  const sig = concat(...parts);
  const { times, vals } = computeRmsEnvelope(sig, SR, 20, 10);
  const diffs = onsetStrengthCurve(vals);
  const onsets = pickOnsets(times, diffs, 0.65, 0.12);
  assert.ok(onsets.length >= 6, `expected several onsets, got ${onsets.length}`);
  // consecutive onsets should be roughly hitGap apart
  const gaps = onsets.slice(1).map((t, i) => t - onsets[i]);
  for (const g of gaps) assert.ok(Math.abs(g - hitGap) < 0.15, `gap ${g} should be near ${hitGap}`);
});

test("multiBandOnsetStrengthCurve: times/diffs match the envelope's length", () => {
  const sig = concat(tone(0.5, 200, 0.8), silence(0.5));
  const { times, vals } = computeRmsEnvelope(sig, SR, 20, 10);
  const { times: mbTimes, diffs } = multiBandOnsetStrengthCurve(sig, SR, 20, 10, { times, vals });
  assert.equal(mbTimes.length, times.length);
  assert.equal(diffs.length, times.length);
});

test("multiBandOnsetStrengthCurve: catches a quiet, high-frequency-only hit that a full-spectrum curve misses", () => {
  const gap = 0.22;
  const parts = [];
  for (let i = 0; i < 3; i++) {
    parts.push(tone(0.05, 100, 0.9)); // loud low-freq "kick"
    parts.push(silence(gap - 0.05));
    parts.push(tone(0.05, 8000, 0.1)); // quiet high-freq "shaker" - small in total-energy terms
    parts.push(silence(gap - 0.05));
  }
  const sig = concat(...parts);

  const { times, vals } = computeRmsEnvelope(sig, SR, 20, 10);
  const singleDiffs = onsetStrengthCurve(vals);
  const singleOnsets = pickOnsets(times, singleDiffs, 0.65, 0.1);

  const { diffs: multiDiffs } = multiBandOnsetStrengthCurve(sig, SR, 20, 10, { times, vals });
  const multiOnsets = pickOnsets(times, multiDiffs, 0.65, 0.1);

  assert.ok(
    multiOnsets.length > singleOnsets.length,
    `expected multi-band to find more onsets than single-band (kick-only) at the same sensitivity: single=${singleOnsets.length}, multi=${multiOnsets.length}`
  );
  // multi-band should catch every one of the 6 hits (3 kicks + 3 shakers); single-band, working
  // from total energy alone, should catch at most the loud kicks and miss the quiet shakers.
  assert.equal(multiOnsets.length, 6, `expected all 6 hits found via multi-band, got ${multiOnsets.length}`);
  assert.ok(singleOnsets.length <= 3, `single-band shouldn't be finding the quiet shakers too, got ${singleOnsets.length}`);
});

test("snapToBeatGrid: snaps within tolerance, leaves distant points alone", () => {
  const bpm = 120; // beat period 0.5s
  assert.equal(snapToBeatGrid(1.02, bpm, 0, 0.1), 1.0);
  assert.equal(snapToBeatGrid(1.3, bpm, 0, 0.1), 1.3); // too far from any grid line
});

test("snapToBeatGrid: an explicit step snaps to bars, not beats", () => {
  const bpm = 120; // beat 0.5s, bar 2.0s
  const bar = 2.0;
  // 2.6s is a whole number of beats from the grid start, so beat snapping leaves it on beat 6 -
  // a chop of 5 beats, which loops as audio but not as music.
  assert.equal(snapToBeatGrid(2.6, bpm, 0, bar / 2), 2.5);
  assert.equal(snapToBeatGrid(2.6, bpm, 0, bar / 2, bar), 2.0);
  assert.equal(snapToBeatGrid(3.1, bpm, 0, bar / 2, bar), 4.0);
});

// --- grid phase ------------------------------------------------------------

/** A kick-like burst every `barSec`, starting `phaseSec` in. Silence between hits, so each attack has a clean start. */
function barPulses(barSec, count, phaseSec = 0, hitSec = 0.05) {
  const parts = [silence(phaseSec)];
  for (let i = 0; i < count; i++) {
    parts.push(tone(hitSec, 90, 0.9));
    parts.push(silence(barSec - hitSec));
  }
  return concat(...parts);
}

test("refineGridStart: pulls a late anchor back onto the attack", () => {
  const bpm = 120;
  const bar = 2.0;
  const phase = 0.02;
  const sig = barPulses(bar, 12, phase);
  // What drumRegions used to hand over: an onset time quantised to the 10ms envelope hop and
  // lagging the attack that produced it, so the grid lands well after the downbeat.
  const refined = refineGridStart(sig, SR, bpm, phase + 0.012, 4);
  assert.ok(
    Math.abs(refined - phase) < 0.003,
    `expected the grid to land on the attack at ${phase}s, got ${refined}s`
  );
});

test("refineGridStart: never lands after the attack it is correcting", () => {
  const bpm = 120;
  const phase = 0.05;
  const sig = barPulses(2.0, 12, phase);
  for (const lateBy of [0.004, 0.008, 0.012, 0.02]) {
    const refined = refineGridStart(sig, SR, bpm, phase + lateBy, 4);
    assert.ok(
      refined <= phase + 0.0015,
      `anchor ${lateBy * 1000}ms late refined to ${refined}s, which is past the attack at ${phase}s - a cut there slices the transient`
    );
  }
});

test("refineGridStart: leaves the anchor alone when there is nothing to measure", () => {
  const quiet = silence(8);
  assert.equal(refineGridStart(quiet, SR, 120, 0.01, 4), 0.01);
  // A steady tone has no attacks to vote with, so there is no evidence to move on.
  const steady = tone(8, 220, 0.5);
  assert.equal(refineGridStart(steady, SR, 120, 0.01, 4), 0.01);
});

test("refineGridStart: refuses a correction too large to be editing slop", () => {
  const bpm = 120;
  const bar = 2.0;
  const sig = barPulses(bar, 12, 0.02);
  // Anchored most of a beat away from any downbeat. Whatever it finds there is not slop, so the
  // coarse anchor has to stand rather than the grid jumping onto a different subdivision.
  const anchor = 0.02 + bar / 8;
  assert.equal(refineGridStart(sig, SR, bpm, anchor, 4), anchor);
});

/**
 * A rock beat at an exact tempo: kick on 1 and 3, snare on 2 and 4, quiet hats on every eighth.
 * Hits are placed at absolute sample positions so the tempo really is exact over the whole file.
 * `startBeat` shifts which beat of the bar the file opens on (3 = a snare pickup on beat 4).
 */
function rockBeat(bpm, seconds, { phase = 0.1, startBeat = 0 } = {}) {
  const out = new Float32Array(Math.round(seconds * SR));
  const beat = 60 / bpm;
  let seed = 12345;
  const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 1073741824) - 1;
  const add = (t, len, fn) => {
    const s0 = Math.round(t * SR);
    for (let i = 0; i < Math.round(len * SR) && s0 + i < out.length; i++) out[s0 + i] += fn(i / SR);
  };
  for (let e = 0; phase + (e / 2) * beat < seconds; e++) {
    const t = phase + (e / 2) * beat;
    add(t, 0.03, (x) => 0.08 * noise() * Math.exp(-x * 150));
    if (e % 2) continue;
    const beatInBar = (e / 2 + startBeat) % 4;
    if (beatInBar === 0 || beatInBar === 2) add(t, 0.15, (x) => 0.9 * Math.sin(2 * Math.PI * 60 * x) * Math.exp(-x * 25));
    else add(t, 0.12, (x) => 0.6 * noise() * Math.exp(-x * 30));
  }
  return out;
}

test("fitBeatGrid: corrects a tempo estimate that is a few hundredths of a BPM out", () => {
  // The real failure: Essentia read a straight 123.00 break as 123.047, and cut boundaries
  // walked tens of milliseconds off the downbeat by the end of the file.
  const sig = rockBeat(123, 60, { phase: 0.1 });
  const grid = fitBeatGrid(sig, SR, 123.046875);
  assert.ok(grid, "expected a fit on a steady beat");
  const lastBeat = Math.floor((60 - 0.2) / (60 / 123));
  const driftMs = Math.abs(lastBeat * (60 / grid.bpm - 60 / 123)) * 1000;
  assert.ok(driftMs < 3, `fitted ${grid.bpm} BPM drifts ${driftMs.toFixed(1)}ms by the end of the file`);
  assert.ok(grid.downbeat <= 0.1 + 0.001 && grid.downbeat > 0.1 - 0.006, `downbeat ${grid.downbeat}s should sit on or just before the kick at 0.1s`);
});

test("fitBeatGrid: bar 1 is the kick, not a snare pickup the file happens to open on", () => {
  const bpm = 120;
  const sig = rockBeat(bpm, 40, { phase: 0.1, startBeat: 3 }); // opens on beat 4
  const grid = fitBeatGrid(sig, SR, bpm);
  assert.ok(grid, "expected a fit");
  const expected = 0.1 + 60 / bpm; // the first kick
  assert.ok(Math.abs(grid.downbeat - expected) < 0.006, `downbeat ${grid.downbeat}s, expected the kick at ${expected}s`);
});

test("fitBeatGrid: no fit on material with no pulse", () => {
  assert.equal(fitBeatGrid(tone(10, 220, 0.5), SR, 120), null);
  assert.equal(fitBeatGrid(silence(10), SR, 120), null);
});

test("drumRegions: chops stay on the downbeat across a long file despite a slightly wrong tempo", () => {
  const sig = rockBeat(123, 90, { phase: 0.1 });
  const est = 123.046875;
  const chop = barsToSeconds(4, est);
  const { regions, bpm } = drumRegions(sig, SR, { preferred: chop, minLen: chop / 2, maxLen: chop * 1.5, onsetSensitivity: 0.65 }, est);
  const bar = (4 * 60) / 123;
  for (let i = 0; i < regions.length - 1; i++) {
    const barsIn = (regions[i][0] - 0.1) / bar;
    const offMs = Math.abs(barsIn - Math.round(barsIn)) * bar * 1000;
    assert.ok(offMs < 6, `chop ${i + 1} starts ${offMs.toFixed(1)}ms off the downbeat (tempo used ${bpm})`);
    assert.ok(Math.abs((regions[i][1] - regions[i][0]) / bar - 4) < 0.002, `chop ${i + 1} is not 4 bars`);
  }
});

test("drumRegions: anchorAtStart treats 0:00 as bar 1", () => {
  const sig = rockBeat(120, 30, { phase: 0.1 });
  const p = { preferred: 8, minLen: 4, maxLen: 12, onsetSensitivity: 0.65, anchorAtStart: true };
  const { regions } = drumRegions(sig, SR, p, 120);
  assert.equal(regions[0][0], 0);
  assert.ok(Math.abs(regions[1][0] - 8) < 0.01, `second chop should start 4 bars in, got ${regions[1][0]}`);
});

test("drumRegionsFrom: carves off an intro fill and chops whole bars from the chosen point", () => {
  const bpm = 120;
  const bar = 2;
  // A 3.3s intro fill: loud off-grid hits at a different rate, which is what wrecks whole-file
  // downbeat detection. The groove starts right after it.
  const intro = new Float32Array(Math.round(3.3 * SR));
  for (let t = 0.05; t < 3.2; t += 0.17) {
    const s0 = Math.round(t * SR);
    for (let i = 0; i < 0.08 * SR; i++) intro[s0 + i] += 0.8 * Math.sin((2 * Math.PI * 200 * i) / SR) * Math.exp((-i / SR) * 40);
  }
  const groove = rockBeat(bpm, 40, { phase: 0 });
  const sig = concat(intro, groove);
  const downbeat = intro.length / SR;
  const p = { preferred: 4 * bar, minLen: 2 * bar, maxLen: 6 * bar, onsetSensitivity: 0.65 };
  // A hand-placed mark 15ms late of the real downbeat.
  const { regions, anchor } = drumRegionsFrom(sig, SR, p, bpm, downbeat + 0.015);
  assert.ok(Math.abs(anchor - downbeat) < 0.004, `bar 1 should snap to the downbeat at ${downbeat}s, got ${anchor}s`);
  assert.ok(regions.length >= 4);
  assert.equal(regions[0][0], anchor);
  for (let i = 0; i < regions.length - 1; i++) {
    assert.ok(Math.abs((regions[i][1] - regions[i][0]) / bar - 4) < 0.002, `chop ${i + 1} is not 4 bars`);
  }
});

test("drumRegionsFrom: a mark nowhere near a beat is used as-is", () => {
  const sig = rockBeat(120, 30, { phase: 0 });
  const p = { preferred: 8, minLen: 4, maxLen: 12, onsetSensitivity: 0.65 };
  const { anchor } = drumRegionsFrom(sig, SR, p, 120, 4.25); // halfway between beats
  assert.ok(Math.abs(anchor - 4.25) < 1 / SR);
});

test("drumRegions: produces loop-length chops close to preferred length", () => {
  const parts = [];
  for (let i = 0; i < 40; i++) {
    parts.push(tone(0.06, 150, 0.9));
    parts.push(silence(0.44));
  }
  const sig = concat(...parts); // 40 * 0.5s = 20s of "drum" pulses at 120bpm
  const p = { preferred: 8, maxLen: 16, minLen: 3, onsetSensitivity: 0.65 };
  const { regions } = drumRegions(sig, SR, p, 120);
  assert.ok(regions.length >= 2, `expected multiple regions, got ${regions.length}`);
  for (const [s, e] of regions) {
    assert.ok(e - s <= p.maxLen + 1e-6);
    assert.ok(e - s >= 0.5);
  }
});

test("drumRegions: every chop but the tail is an exact whole number of bars", () => {
  const bpm = 120;
  const bar = 2.0; // 4 beats at 120bpm
  const barsPerChop = 4;
  const chopSec = barsPerChop * bar;
  const phase = 0.03; // the file does not start on the grid, as a DAW bounce rarely does
  const sig = barPulses(bar, 30, phase); // 30 bars = 7.5 four-bar chops
  const p = {
    preferred: chopSec,
    minLen: chopSec * 0.5,
    maxLen: chopSec * 1.5,
    onsetSensitivity: 0.65,
  };
  const { regions } = drumRegions(sig, SR, p, bpm);
  assert.ok(regions.length >= 6, `expected several chops, got ${regions.length}`);

  // The tail is whatever is left over after the last whole chop and was never going to loop.
  for (let i = 0; i < regions.length - 1; i++) {
    const [s, e] = regions[i];
    const bars = (e - s) / bar;
    assert.ok(
      Math.abs(bars - barsPerChop) < 0.01,
      `chop ${i + 1} is ${bars.toFixed(4)} bars (${(e - s).toFixed(4)}s), not ${barsPerChop} - it cannot loop`
    );
  }
});

test("drumRegions: the FIRST chop is on the grid too", () => {
  const bpm = 120;
  const bar = 2.0;
  const phase = 0.03;
  const sig = barPulses(bar, 30, phase);
  const p = { preferred: 4 * bar, minLen: 2 * bar, maxLen: 6 * bar, onsetSensitivity: 0.65 };
  const { regions, gridStart } = drumRegions(sig, SR, p, bpm);

  // Starting the walk at t=0 regardless - which is what this used to do - made chop 1 the one
  // chop in the file guaranteed not to loop: it ran from 0 to the first grid line plus N bars.
  assert.ok(regions[0][0] > 0, "chop 1 should start on the grid, not at t=0");
  const offGrid = Math.abs(((regions[0][0] - gridStart) / bar) % 1);
  assert.ok(
    offGrid < 0.01 || offGrid > 0.99,
    `chop 1 starts ${regions[0][0]}s, which is not a bar line from gridStart ${gridStart}s`
  );
});

test("drumRegions: a tail shorter than a chop does not get swallowed by the last chop", () => {
  const bpm = 120;
  const bar = 2.0;
  const barsPerChop = 4;
  // 10 bars at 4 bars a chop: two full chops and a 2-bar remainder. The old walk stopped as soon
  // as the remainder fit inside maxLen (1.5x), handing the whole tail to chop 2 and making it six
  // bars long when four was asked for.
  const sig = barPulses(bar, 10, 0.02);
  const p = {
    preferred: barsPerChop * bar,
    minLen: barsPerChop * bar * 0.5,
    maxLen: barsPerChop * bar * 1.5,
    onsetSensitivity: 0.65,
  };
  const { regions } = drumRegions(sig, SR, p, bpm);
  assert.ok(regions.length >= 3, `expected two whole chops plus a tail, got ${regions.length}`);
  for (let i = 0; i < regions.length - 1; i++) {
    const len = regions[i][1] - regions[i][0];
    assert.ok(
      Math.abs(len / bar - barsPerChop) < 0.01,
      `chop ${i + 1} is ${(len / bar).toFixed(3)} bars, not ${barsPerChop}`
    );
  }
});

test("drumRegions: with no tempo, behaviour is unchanged - chops still start at 0", () => {
  const sig = barPulses(2.0, 20, 0.03);
  const p = { preferred: 8, minLen: 3, maxLen: 16, onsetSensitivity: 0.65 };
  const { regions } = drumRegions(sig, SR, p, null);
  assert.equal(regions[0][0], 0);
  assert.equal(regions[regions.length - 1][1], sig.length / SR);
});

// --- one-shot extraction ----------------------------------------------------

test("bandEnergies: a low tone reads low-dominant, a high tone reads high-dominant", () => {
  const lowTone = tone(0.2, 80, 0.8);
  const { low: lowLow, mid: lowMid, high: lowHigh } = bandEnergies(lowTone, SR, 0, lowTone.length);
  assert.ok(lowLow > lowMid && lowLow > lowHigh, `expected low band to dominate an 80Hz tone: ${lowLow},${lowMid},${lowHigh}`);

  const highTone = tone(0.2, 9000, 0.8);
  const { low: hiLow, mid: hiMid, high: hiHigh } = bandEnergies(highTone, SR, 0, highTone.length);
  assert.ok(hiHigh > hiLow && hiHigh > hiMid, `expected high band to dominate a 9kHz tone: ${hiLow},${hiMid},${hiHigh}`);
});

test("classifyHit: buckets low/short as kick, high/short as hat, high/long as cymbal", () => {
  assert.equal(classifyHit({ low: 0.9, mid: 0.1, high: 0.05, durationSec: 0.15 }), "kick");
  assert.equal(classifyHit({ low: 0.05, mid: 0.1, high: 0.9, durationSec: 0.08 }), "hat");
  assert.equal(classifyHit({ low: 0.05, mid: 0.15, high: 0.9, durationSec: 0.6 }), "cymbal");
  assert.equal(classifyHit({ low: 0, mid: 0, high: 0, durationSec: 0.1 }), "perc");
});

test("findOneShotWindows: a hit may ring past the next onset, but only by the bleed allowance", () => {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    parts.push(tone(0.05, 150, 0.9));
    parts.push(silence(0.25));
  }
  const sig = concat(...parts); // hits at ~0, 0.3, 0.6, 0.9
  const onsets = [0, 0.3, 0.6, 0.9];
  const bleedSec = 0.09;
  const windows = findOneShotWindows(sig, SR, onsets, { bleedSec });
  assert.equal(windows.length, 4);
  for (let i = 0; i < windows.length; i++) {
    const [s, e] = windows[i];
    assert.ok(e > s, "window should have positive length");
    if (i + 1 < windows.length) {
      assert.ok(e <= onsets[i + 1] + bleedSec + 1e-6, "a hit shouldn't run more than the bleed allowance into the next");
    }
  }
});

test("findOneShotWindows: dense breaks still yield usable hit lengths, not stubs", () => {
  // Cutting hard at the next onset used to make every hit in a busy break a ~40ms stub.
  const parts = [];
  for (let i = 0; i < 8; i++) {
    parts.push(tone(0.02, 200, 0.9));
    parts.push(silence(0.05)); // onsets only 70ms apart
  }
  const sig = concat(...parts);
  const onsets = Array.from({ length: 8 }, (_, i) => i * 0.07);
  const windows = findOneShotWindows(sig, SR, onsets);
  assert.ok(windows.length >= 6, `expected most hits to survive, got ${windows.length}`);
  for (const [s, e] of windows) {
    assert.ok(e - s >= 0.05 - 1e-9, `hit of ${(e - s).toFixed(3)}s is too short to be a usable sample`);
  }
});

test("dedupeHits: collapses repeats of one sound but keeps genuinely different ones", () => {
  const fp = (v) => {
    const mean = v.reduce((s, x) => s + x, 0) / v.length;
    const c = v.map((x) => x - mean);
    const n = Math.hypot(...c) || 1;
    return c.map((x) => x / n);
  };
  const lowVec = fp([2, 1, 0, -1, -2]); // bass-heavy
  const highVec = fp([-2, -1, 0, 1, 2]); // bright
  const hits = [
    { start: 0, peak: 0.5, fingerprint: lowVec },
    { start: 1, peak: 0.9, fingerprint: lowVec }, // same sound, louder
    { start: 2, peak: 0.7, fingerprint: highVec }, // genuinely different sound
  ];
  const kept = dedupeHits(hits);
  assert.equal(kept.length, 2, "two distinct sounds should survive, the repeat should not");
  assert.ok(
    kept.some((h) => h.peak === 0.9),
    "the louder of the two identical hits should be the one kept"
  );
  assert.ok(kept.some((h) => h.peak === 0.7), "the different sound should be kept");
});

test("dedupeHits: labels no longer decide clustering, so a mislabel can't split a sound", () => {
  // Clustering used to be grouped by the (unreliable) kick/snare/hat label, so the same sound
  // labelled two different ways could never be recognised as a duplicate.
  const v = [0.8, 0.2, -0.1, -0.4, -0.5];
  const n = Math.hypot(...v);
  const same = v.map((x) => x / n);
  const hits = [
    { start: 0, label: "kick", peak: 0.6, fingerprint: same },
    { start: 1, label: "perc", peak: 0.8, fingerprint: same }, // identical sound, different label
  ];
  assert.equal(dedupeHits(hits).length, 1);
});

test("dedupeHits: drops ghost notes far below the loudest hit", () => {
  const fp = (a, b) => {
    const v = [a, b, 0, -a, -b];
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  };
  const hits = [
    { start: 0, peak: 1.0, fingerprint: fp(1, 0) },
    { start: 1, peak: 0.01, fingerprint: fp(0, 1) }, // distinct, but essentially inaudible
  ];
  const kept = dedupeHits(hits, { minPeakRatio: 0.08 });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].peak, 1.0);
});

test("dedupeHits: caps the total number kept", () => {
  const hits = Array.from({ length: 40 }, (_, i) => {
    const ang = (i / 40) * Math.PI;
    const v = [Math.cos(ang), Math.sin(ang), 0, -Math.cos(ang), -Math.sin(ang)];
    const n = Math.hypot(...v) || 1;
    return { start: i, peak: 0.5 + i / 100, fingerprint: v.map((x) => x / n) };
  });
  assert.equal(dedupeHits(hits, { simThreshold: 0.0001, maxKept: 5 }).length, 5);
});

test("peakAbs: finds the largest absolute sample in range", () => {
  const mono = new Float32Array([0.1, -0.9, 0.3, 0.05]);
  assert.ok(Math.abs(peakAbs(mono, 0, mono.length) - 0.9) < 1e-6);
  assert.ok(Math.abs(peakAbs(mono, 2, mono.length) - 0.3) < 1e-6);
});

// --- waveform preview -------------------------------------------------------

test("computePeaks: one bin per block, each holding that block's max-abs sample", () => {
  const mono = new Float32Array([0.1, 0.2, -0.9, 0.3, 0.4, 0.5, -0.05, 0.05]);
  const peaks = computePeaks(mono, 4); // 2 samples per bin
  assert.equal(peaks.length, 4);
  assert.ok(Math.abs(peaks[0] - 0.2) < 1e-6);
  assert.ok(Math.abs(peaks[1] - 0.9) < 1e-6);
  assert.ok(Math.abs(peaks[2] - 0.5) < 1e-6);
  assert.ok(Math.abs(peaks[3] - 0.05) < 1e-6);
});

test("computePeaks: handles an empty signal and a zero bin count without throwing", () => {
  assert.equal(computePeaks(new Float32Array(0), 10).length, 10);
  assert.equal(computePeaks(new Float32Array(100), 0).length, 0);
});

test("computePeaksInRange: matches computePeaks over the full array, and isolates a sub-range", () => {
  const mono = new Float32Array([0.1, 0.2, -0.9, 0.3, 0.4, 0.5, -0.05, 0.05]);
  const full = computePeaksInRange(mono, 0, mono.length, 4);
  const viaComputePeaks = computePeaks(mono, 4);
  assert.deepEqual(Array.from(full), Array.from(viaComputePeaks));

  // A sub-range covering just [0.3, 0.4, 0.5, -0.05] (indices 3..6) should never see the 0.9 peak.
  const sub = computePeaksInRange(mono, 3, 7, 2);
  assert.ok(Math.abs(sub[0] - 0.4) < 1e-6);
  assert.ok(Math.abs(sub[1] - 0.5) < 1e-6);
});

// --- zero-crossing / fades -------------------------------------------------

test("findNearestZeroCrossing: finds an actual sign change near the target", () => {
  const n = 1000;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = Math.sin((2 * Math.PI * 10 * i) / n);
  const idx = findNearestZeroCrossing(mono, 505, 60);
  assert.ok(idx >= 445 && idx <= 565);
  const prev = mono[idx - 1];
  const cur = mono[idx];
  assert.ok((prev <= 0 && cur >= 0) || (prev >= 0 && cur <= 0), "should land on a sign change");
});

test("applyFades: zeroes the very first and last samples", () => {
  const ch = new Float32Array(100).fill(1);
  applyFades([ch], 10, 10);
  assert.equal(ch[0], 0);
  assert.equal(ch[99], 0);
  assert.equal(ch[50], 1);
});

// --- naming helpers ---------------------------------------------------

test("sanitizeForPath: strips filesystem-unsafe characters", () => {
  assert.equal(sanitizeForPath('sax take 3: "the good one"'), "sax take 3- -the good one-");
  assert.equal(sanitizeForPath("a/b\\c*d?e"), "a-b-c-d-e");
  assert.equal(sanitizeForPath("  spaced   out  "), "spaced out");
});

test("buildKeyTempoTag: plain text, no brackets/commas, defaults to a space separator", () => {
  assert.equal(buildKeyTempoTag({ key: "C", scale: "minor", bpm: 92.4 }), "Cm 92bpm");
  assert.equal(buildKeyTempoTag({ key: "G", scale: "major", bpm: null }), "G");
  assert.equal(buildKeyTempoTag({ key: null, bpm: 128 }), "128bpm");
  assert.equal(buildKeyTempoTag({ key: null, bpm: null }), "");
  assert.equal(buildKeyTempoTag(), "");
  assert.equal(buildKeyTempoTag({ key: "C", scale: "minor", bpm: 120 }, "_"), "Cm_120bpm");
});

test("truncateStem: cuts to length and trims a dangling separator", () => {
  assert.equal(truncateStem("short", 20), "short");
  assert.equal(truncateStem("sax_take_three_long_name", 10), "sax_take_t");
  assert.equal(truncateStem("sax_take_three", 9), "sax_take");
});

test("joinNameParts: drops empty parts and joins with the given separator", () => {
  assert.equal(joinNameParts(["sax", "Cm 120bpm", "01"], " "), "sax Cm 120bpm 01");
  assert.equal(joinNameParts(["sax", "", null, undefined, "01"], "_"), "sax_01");
  assert.equal(joinNameParts(["sax"], "-"), "sax");
});

test("sanitizeForPath: strips unsafe characters and enforces a max length", () => {
  assert.equal(sanitizeForPath("a/b\\c*d?e,f[g]h"), "a-b-c-d-e-f-g-h");
  assert.equal(sanitizeForPath("a fairly long sample name here", 12), "a fairly lon");
});

test("barsToSeconds: bars * beats-per-bar / bpm, null without a usable bpm", () => {
  assert.ok(Math.abs(barsToSeconds(4, 120) - 8) < 1e-9); // 4 bars @ 120bpm, 4/4 = 8s
  assert.ok(Math.abs(barsToSeconds(2, 100) - 4.8) < 1e-9);
  assert.equal(barsToSeconds(4, null), null);
  assert.equal(barsToSeconds(4, 0), null);
  assert.equal(barsToSeconds(0, 120), null);
});

// --- manual re-chop helpers --------------------------------------------

test("findAudibleStart: reports the true start of audio after leading silence", () => {
  const sig = concat(silence(2.0), tone(1.0, 300, 0.9));
  const t = findAudibleStart(sig, SR);
  assert.ok(Math.abs(t - 2.0) < 0.05, `expected ~2.0s, got ${t}`);
});

test("findAudibleStart: returns 0 for audio with no leading silence", () => {
  const sig = tone(1.0, 300, 0.9);
  assert.equal(findAudibleStart(sig, SR), 0);
});

test("equalSliceRegions: splits a range into evenly-sized, contiguous regions", () => {
  const regions = equalSliceRegions(2, 10, 4);
  assert.equal(regions.length, 4);
  assert.deepEqual(regions[0], [2, 4]);
  assert.deepEqual(regions[3], [8, 10]);
  for (let i = 1; i < regions.length; i++) {
    assert.ok(Math.abs(regions[i][0] - regions[i - 1][1]) < 1e-9, "regions should be contiguous");
  }
});

test("equalSliceRegions: clamps count to at least 1", () => {
  assert.deepEqual(equalSliceRegions(0, 5, 0), [[0, 5]]);
  assert.deepEqual(equalSliceRegions(0, 5, -3), [[0, 5]]);
});

// --- mono / resample ---------------------------------------------------

test("toMono: averages stereo channels", () => {
  const l = new Float32Array([1, 1, 1]);
  const r = new Float32Array([-1, -1, -1]);
  const m = toMono([l, r]);
  assert.deepEqual(Array.from(m), [0, 0, 0]);
});

test("resampleLinear: halves the length when downsampling by 2x", () => {
  const src = new Float32Array(1000);
  const out = resampleLinear(src, 44100, 22050);
  assert.ok(Math.abs(out.length - 500) <= 1);
});

// --- WAV codec round trip ---------------------------------------------------

test("encodeWav -> parseWav round trip (24-bit stereo)", () => {
  const n = 500;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = Math.sin((2 * Math.PI * 5 * i) / n) * 0.8;
    r[i] = Math.cos((2 * Math.PI * 5 * i) / n) * 0.5;
  }
  const blob = encodeWav([l, r], 48000, 24);
  assert.ok(blob.size > 44);
  return blob.arrayBuffer().then((ab) => {
    const decoded = parseWav(ab);
    assert.equal(decoded.sampleRate, 48000);
    assert.equal(decoded.numberOfChannels, 2);
    assert.equal(decoded.length, n);
    const dl = decoded.getChannelData(0);
    const dr = decoded.getChannelData(1);
    for (let i = 0; i < n; i++) {
      assert.ok(Math.abs(dl[i] - l[i]) < 0.001, `L sample ${i}: ${dl[i]} vs ${l[i]}`);
      assert.ok(Math.abs(dr[i] - r[i]) < 0.001, `R sample ${i}: ${dr[i]} vs ${r[i]}`);
    }
  });
});

test("encodeWav -> parseWav round trip (16-bit mono)", () => {
  const n = 200;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = Math.sin((2 * Math.PI * 3 * i) / n) * 0.9;
  const blob = encodeWav([mono], 44100, 16);
  return blob.arrayBuffer().then((ab) => {
    const decoded = parseWav(ab);
    assert.equal(decoded.numberOfChannels, 1);
    const d = decoded.getChannelData(0);
    for (let i = 0; i < n; i++) {
      assert.ok(Math.abs(d[i] - mono[i]) < 0.001);
    }
  });
});

test("parseAiff: reads a hand-built 16-bit big-endian AIFF buffer", () => {
  // Build a minimal AIFF file by hand: FORM/AIFF, COMM, SSND.
  const frames = 4;
  const channels = 1;
  const bits = 16;
  const sampleRate = 44100;
  const samples = [1000, -1000, 32767, -32768];

  function extended80FromInt(rate) {
    // Encode an integer sample rate as an 80-bit extended float, minimal case.
    const buf = new ArrayBuffer(10);
    const dv = new DataView(buf);
    let exp = 16383 + 31; // bias + assumed 32-bit-ish integer range exponent
    // Normalize rate into 1.mantissa * 2^exp form within 63 mantissa bits.
    let mantissa = rate;
    let e = 0;
    while (mantissa < Math.pow(2, 62)) {
      mantissa *= 2;
      e++;
    }
    exp = 16383 + (31 - e) + 31; // fallback simplified below
    // Simpler robust approach: use BigInt bit tricks instead.
    return buf;
  }

  // Simpler + correct: construct extended80 via a known-good bit-twiddling routine.
  function writeExtended80(dv, offset, value) {
    if (value === 0) {
      for (let i = 0; i < 10; i++) dv.setUint8(offset + i, 0);
      return;
    }
    const sign = value < 0 ? 1 : 0;
    value = Math.abs(value);
    let exp = Math.floor(Math.log2(value));
    let mantissa = value / Math.pow(2, exp); // in [1,2)
    // 64-bit mantissa with explicit integer bit
    const mantissaBits = BigInt(Math.round(mantissa * Math.pow(2, 63)));
    const biasedExp = exp + 16383;
    dv.setUint8(offset, (sign << 7) | ((biasedExp >> 8) & 0x7f));
    dv.setUint8(offset + 1, biasedExp & 0xff);
    dv.setUint32(offset + 2, Number((mantissaBits >> 32n) & 0xffffffffn), false);
    dv.setUint32(offset + 6, Number(mantissaBits & 0xffffffffn), false);
  }

  const commSize = 18;
  const ssndDataSize = frames * channels * 2;
  const ssndSize = 8 + ssndDataSize;
  const totalSize = 4 + (8 + commSize) + (8 + ssndSize); // 'AIFF' + COMM chunk + SSND chunk

  const buf = new ArrayBuffer(8 + totalSize);
  const dv = new DataView(buf);
  let pos = 0;
  const writeStr = (s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(pos + i, s.charCodeAt(i));
    pos += s.length;
  };
  writeStr("FORM");
  dv.setUint32(pos, totalSize, false);
  pos += 4;
  writeStr("AIFF");

  writeStr("COMM");
  dv.setUint32(pos, commSize, false);
  pos += 4;
  dv.setUint16(pos, channels, false);
  pos += 2;
  dv.setUint32(pos, frames, false);
  pos += 4;
  dv.setUint16(pos, bits, false);
  pos += 2;
  writeExtended80(dv, pos, sampleRate);
  pos += 10;

  writeStr("SSND");
  dv.setUint32(pos, ssndSize, false);
  pos += 4;
  dv.setUint32(pos, 0, false); // offset
  pos += 4;
  dv.setUint32(pos, 0, false); // block size
  pos += 4;
  for (const s of samples) {
    dv.setInt16(pos, s, false);
    pos += 2;
  }

  const decoded = parseAiff(buf);
  assert.equal(decoded.sampleRate, sampleRate);
  assert.equal(decoded.numberOfChannels, 1);
  assert.equal(decoded.length, frames);
  const d = decoded.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    assert.ok(Math.abs(d[i] - samples[i] / 32768) < 0.001, `frame ${i}: ${d[i]} vs ${samples[i] / 32768}`);
  }
});

console.log(`\n${passed} test(s) passed.`);
