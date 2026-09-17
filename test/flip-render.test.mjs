// Node-side unit tests for FLIP's audio layer - js/flip/render.js and js/flip/naming.js.
//
// The two promises FLIP makes about rendered audio are both testable without a browser, and both
// are the kind of thing that breaks silently and is then blamed on the source material:
//
//   SAME LENGTH, ALWAYS. Drop the export into a DAW and it occupies the same bars as the original.
//   No repeat, stutter, reverse or silence may add or remove a single sample frame.
//
//   NO ACCIDENTAL DAMAGE. Rearranging audio must not introduce clicks, gaps, level changes or
//   clipping. Untouched stretches must come back bit-identical, silence must be real silence, and
//   the crossfades that bridge edits must never push a hot loop over full scale.
// Run with: node test/flip-render.test.mjs
import assert from "node:assert/strict";
import { createSliceMap } from "../js/flip/slice-map.js";
import { generateRecipe, identitySteps, makeStep } from "../js/flip/recipe.js";
import { renderRecipe, renderVariationAudio, DEFAULT_CROSSFADE_MS } from "../js/flip/render.js";
import { styleKeys } from "../js/flip/styles.js";
import { variationFileName, batchFolderName, uniqueName, sourceStem } from "../js/flip/naming.js";

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

const SR = 44100;

function loopMap({ bars = 4, bpm = 120, subdivision = "1/16", sampleRate = SR, totalSamples = null } = {}) {
  const total = totalSamples != null ? totalSamples : Math.round(((bars * 4 * 60) / bpm) * sampleRate);
  return createSliceMap({ totalSamples: total, sampleRate, bpm, subdivision });
}

/**
 * Distinguishable test audio: a slow tone whose period divides the length exactly, so it is
 * genuinely LOOP-CONTINUOUS - the last sample runs into the first the way a real loop's does.
 *
 * That property matters for the crossfade tests. FLIP takes pre-roll from the source, and for a
 * slot taken from the very start of the file (or a reversed slot taken from the very end) that
 * pre-roll lies off the end and wraps around. A test signal with a discontinuous seam would show
 * that wrap as a jump and blame the renderer for a break in the source - so the fixture has to be
 * the thing the renderer is designed for. Adjacent samples still differ only slightly, so any
 * untreated splice stands out.
 */
function sweep(total, channels = 2, cycles = 170) {
  const out = [];
  for (let c = 0; c < channels; c++) {
    const data = new Float32Array(total);
    const step = (2 * Math.PI * cycles * (c + 1)) / total;
    for (let i = 0; i < total; i++) data[i] = Math.sin(i * step) * 0.85;
    out.push(data);
  }
  return out;
}

/** Biggest sample-to-sample step anywhere in a channel - a click, measured. */
function worstStep(data, from = 1, to = data.length) {
  let worst = 0;
  for (let i = Math.max(1, from); i < to; i++) worst = Math.max(worst, Math.abs(data[i] - data[i - 1]));
  return worst;
}

/** A ramp that encodes its own position, so a rendered slot can be traced back to its source. */
function ramp(total) {
  const data = new Float32Array(total);
  for (let i = 0; i < total; i++) data[i] = i / total;
  return [data];
}

const recipeOf = (map, steps) => ({ seed: 1, style: "mixed", intensity: 50, sliceCount: map.count, subdivision: map.subdivision, steps, edits: [] });

// --- the length guarantee --------------------------------------------------------------------

test("renderRecipe: output is exactly the source length, for every style, intensity and subdivision", () => {
  for (const subdivision of ["1/4", "1/8", "1/16", "1/32"]) {
    // A length that is deliberately not a round number of slices.
    const map = loopMap({ subdivision, totalSamples: 191237, bpm: 93.7 });
    const channels = sweep(map.totalSamples, 2);
    for (const style of styleKeys()) {
      for (const intensity of [0, 50, 100]) {
        const recipe = generateRecipe({ map, style, intensity, seed: 777 });
        const out = renderRecipe({ recipe, map, channels });
        assert.equal(out.length, map.totalSamples, `${subdivision}/${style}/${intensity}: length`);
        for (const ch of out.channels) assert.equal(ch.length, map.totalSamples, `${subdivision}/${style}/${intensity}: channel length`);
      }
    }
  }
});

test("renderRecipe: a stutter replaces time rather than adding it", () => {
  const map = loopMap({ subdivision: "1/8" });
  const channels = ramp(map.totalSamples);
  const steps = identitySteps(map.count);
  // Every single slot stuttered eight ways - the most time a naive implementation could invent.
  for (const step of steps) {
    step.stutter = 8;
    step.op = "stutter-slice";
  }
  const out = renderRecipe({ recipe: recipeOf(map, steps), map, channels });
  assert.equal(out.length, map.totalSamples);
  assert.equal(out.channels[0].length, map.totalSamples);
});

test("renderRecipe: channel count and sample rate come straight from the source", () => {
  for (const channelCount of [1, 2, 4]) {
    for (const sampleRate of [22050, 44100, 48000, 96000]) {
      const map = loopMap({ bars: 1, sampleRate });
      const channels = sweep(map.totalSamples, channelCount);
      const audio = renderVariationAudio({ recipe: generateRecipe({ map, style: "chaos", intensity: 80, seed: 3 }), map, channels, sampleRate });
      assert.equal(audio.channels.length, channelCount, `${channelCount}ch @ ${sampleRate}`);
      assert.equal(audio.sampleRate, sampleRate);
      assert.equal(audio.length, map.totalSamples);
      assert.ok(Math.abs(audio.duration - map.totalSamples / sampleRate) < 1e-9);
      assert.equal(audio.mono.length, map.totalSamples, "the drawn overview matches the audio");
    }
  }
});

// --- fidelity --------------------------------------------------------------------------------

test("renderRecipe: an untouched recipe is bit-identical to the source, including the loop seam", () => {
  const map = loopMap({ subdivision: "1/16", totalSamples: 191237, bpm: 93.7 });
  const channels = sweep(map.totalSamples, 2);
  const out = renderRecipe({ recipe: recipeOf(map, identitySteps(map.count)), map, channels });
  for (let c = 0; c < channels.length; c++) {
    for (let i = 0; i < map.totalSamples; i++) {
      assert.equal(out.channels[c][i], channels[c][i], `channel ${c}, sample ${i} must be untouched`);
    }
  }
});

test("renderRecipe: stretches that weren't edited keep their original samples exactly", () => {
  const map = loopMap({ subdivision: "1/8" });
  const channels = sweep(map.totalSamples, 1);
  const steps = identitySteps(map.count);
  // One edit, right at the end. Everything before the crossfade window must be pristine.
  steps[map.count - 1] = makeStep(0, "repeat-slice");
  const out = renderRecipe({ recipe: recipeOf(map, steps), map, channels });
  const fadeSamples = Math.ceil((DEFAULT_CROSSFADE_MS / 1000) * SR) + 2;
  const safeEnd = map.bounds[map.count - 1] - fadeSamples;
  for (let i = 0; i < safeEnd; i++) assert.equal(out.channels[0][i], channels[0][i], `sample ${i} should be untouched`);
});

test("renderRecipe: a reversed slot reverses the AUDIO, not just the playback order", () => {
  const map = loopMap({ subdivision: "1/4", bars: 1 });
  const channels = ramp(map.totalSamples);
  const steps = identitySteps(map.count);
  steps[2].reverse = true;
  const out = renderRecipe({ recipe: recipeOf(map, steps), map, channels, crossfadeMs: 0 });
  const { startSample, endSample } = map.slices[2];
  for (let i = startSample; i < endSample; i++) {
    const mirrored = endSample - 1 - (i - startSample);
    assert.equal(out.channels[0][i], channels[0][mirrored], `sample ${i} should be its mirror within the slice`);
  }
});

test("renderRecipe: a silenced slot is real written silence, not an unfilled gap", () => {
  const map = loopMap({ subdivision: "1/8" });
  const channels = sweep(map.totalSamples, 2);
  const steps = identitySteps(map.count);
  steps[5].silent = true;
  const out = renderRecipe({ recipe: recipeOf(map, steps), map, channels, crossfadeMs: 0 });
  for (let c = 0; c < 2; c++) {
    for (let i = map.slices[5].startSample; i < map.slices[5].endSample; i++) {
      assert.equal(out.channels[c][i], 0, `channel ${c} sample ${i} should be silent`);
    }
  }
  // ...and only that slot.
  assert.notEqual(out.channels[0][map.slices[6].startSample + 40], 0);
});

test("renderRecipe: a repeated slot really is the same audio twice", () => {
  const map = loopMap({ subdivision: "1/8" });
  const channels = ramp(map.totalSamples);
  const steps = identitySteps(map.count);
  steps[9] = makeStep(8, "repeat-slice");
  const out = renderRecipe({ recipe: recipeOf(map, steps), map, channels, crossfadeMs: 0 });
  const a = map.bounds[8];
  const b = map.bounds[9];
  const shortest = Math.min(map.bounds[9] - a, map.bounds[10] - b);
  for (let k = 0; k < shortest; k++) assert.equal(out.channels[0][b + k], out.channels[0][a + k], `repeat differs at ${k}`);
});

// --- no accidental damage --------------------------------------------------------------------

test("renderRecipe: never clips, and never introduces a value the source didn't have room for", () => {
  const map = loopMap({ subdivision: "1/16" });
  // Full-scale source: an equal-power crossfade would overshoot here and clip on export.
  const channels = [new Float32Array(map.totalSamples), new Float32Array(map.totalSamples)];
  for (let i = 0; i < map.totalSamples; i++) {
    channels[0][i] = Math.sin(i * 0.05);
    channels[1][i] = Math.sin(i * 0.05 + 1.1);
  }
  let peak = 0;
  for (const style of styleKeys()) {
    for (let seed = 1; seed <= 6; seed++) {
      const out = renderRecipe({ recipe: generateRecipe({ map, style, intensity: 100, seed }), map, channels });
      for (const ch of out.channels) {
        for (let i = 0; i < ch.length; i++) {
          assert.ok(Number.isFinite(ch[i]), `${style}/${seed}: sample ${i} is finite`);
          peak = Math.max(peak, Math.abs(ch[i]));
        }
      }
    }
  }
  assert.ok(peak <= 1.0000001, `output peaked at ${peak}, above the source's own full scale`);
});

test("renderRecipe: edits are crossfaded, so no splice is a hard discontinuity", () => {
  const map = loopMap({ subdivision: "1/16" });
  const channels = sweep(map.totalSamples, 1);
  const sourceJump = worstStep(channels[0]);

  let worstFaded = 0;
  let worstUnfaded = 0;
  for (const style of styleKeys()) {
    for (let seed = 1; seed <= 10; seed++) {
      const recipe = generateRecipe({ map, style, intensity: 100, seed });
      worstFaded = Math.max(worstFaded, worstStep(renderRecipe({ recipe, map, channels }).channels[0]));
      worstUnfaded = Math.max(worstUnfaded, worstStep(renderRecipe({ recipe, map, channels, crossfadeMs: 0 }).channels[0]));
    }
  }
  assert.ok(worstUnfaded > sourceJump * 50, `sanity: without crossfades the splices should be obvious (${worstUnfaded.toFixed(4)})`);
  assert.ok(worstFaded < worstUnfaded / 10, `crossfades should flatten the splices: ${worstFaded.toFixed(4)} vs ${worstUnfaded.toFixed(4)}`);
});

test("renderRecipe: a slot taken from the very start crossfades against the loop's own tail, not silence", () => {
  // The pre-roll for source slice 0 lies before the file. Reading silence there would fade the
  // outgoing tail to nothing and then jump straight up to slice 0's first sample - a click placed
  // by the very code meant to remove one. Wrapping gives it the loop's real tail instead.
  const map = loopMap({ subdivision: "1/8" });
  const channels = sweep(map.totalSamples, 1);
  const steps = identitySteps(map.count);
  steps[12] = makeStep(0, "jump-back");
  const out = renderRecipe({ recipe: recipeOf(map, steps), map, channels });
  const boundary = map.bounds[12];
  const window = 128;
  let quietest = Infinity;
  for (let i = boundary - window; i < boundary; i++) quietest = Math.min(quietest, Math.abs(out.channels[0][i]));
  // A fade-to-silence bug parks a sample within a hair of zero right before the boundary.
  assert.ok(quietest > 0.001, `the crossfade should never collapse to silence, got ${quietest.toExponential(2)}`);
  assert.ok(worstStep(out.channels[0], boundary - window, boundary + window) < 0.02, "and the join should be smooth");
});

test("renderRecipe: a reversed final slice crossfades against the loop's own head, not silence", () => {
  // The mirror image: reversed audio's pre-roll lies AFTER the slice, and for the last slice that
  // is past the end of the file.
  const map = loopMap({ subdivision: "1/8" });
  const channels = sweep(map.totalSamples, 1);
  const steps = identitySteps(map.count);
  steps[10] = makeStep(map.count - 1, "reverse-slice");
  steps[10].reverse = true;
  const out = renderRecipe({ recipe: recipeOf(map, steps), map, channels });
  const boundary = map.bounds[10];
  const window = 128;
  let quietest = Infinity;
  for (let i = boundary - window; i < boundary; i++) quietest = Math.min(quietest, Math.abs(out.channels[0][i]));
  assert.ok(quietest > 0.001, `the crossfade should never collapse to silence, got ${quietest.toExponential(2)}`);
  assert.ok(worstStep(out.channels[0], boundary - window, boundary + window) < 0.02, "and the join should be smooth");
});

test("renderRecipe: stutter fragment joins are crossfaded too, not just the slot boundaries", () => {
  const map = loopMap({ subdivision: "1/8" });
  const channels = sweep(map.totalSamples, 1);
  const steps = identitySteps(map.count);
  // One eight-way stutter: seven hard splices INSIDE a single slot, all of which click if the
  // renderer only looks at slot boundaries.
  steps[10].stutter = 8;
  const recipe = recipeOf(map, steps);
  const worst = (crossfadeMs) => {
    const out = renderRecipe({ recipe, map, channels, crossfadeMs });
    let max = 0;
    for (let i = map.bounds[10] + 1; i < map.bounds[11]; i++) max = Math.max(max, Math.abs(out.channels[0][i] - out.channels[0][i - 1]));
    return max;
  };
  assert.ok(worst(undefined) < worst(0) / 5, `inside the stutter: ${worst(undefined).toFixed(5)} faded vs ${worst(0).toFixed(5)} unfaded`);
});

test("renderRecipe: the loop seam is treated as an edit when the ending changed", () => {
  const map = loopMap({ subdivision: "1/8" });
  const channels = sweep(map.totalSamples, 1);
  const steps = identitySteps(map.count);
  steps[map.count - 1] = makeStep(3, "jump-back"); // the loop no longer ends where it used to
  const out = renderRecipe({ recipe: recipeOf(map, steps), map, channels });
  const raw = renderRecipe({ recipe: recipeOf(map, steps), map, channels, crossfadeMs: 0 });
  const seamJump = (rendered) => Math.abs(rendered.channels[0][0] - rendered.channels[0][rendered.length - 1]);
  assert.ok(seamJump(out) < seamJump(raw), "the wrap-around join should be bridged, so the variation still loops");
});

// --- determinism -----------------------------------------------------------------------------

test("renderRecipe: same recipe, same audio, same result - every time", () => {
  const map = loopMap({ subdivision: "1/16" });
  const channels = sweep(map.totalSamples, 2);
  for (const style of styleKeys()) {
    const recipe = generateRecipe({ map, style, intensity: 70, seed: "reproduce me" });
    const a = renderRecipe({ recipe, map, channels });
    const b = renderRecipe({ recipe: generateRecipe({ map, style, intensity: 70, seed: "reproduce me" }), map, channels });
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < a.length; i++) assert.equal(a.channels[c][i], b.channels[c][i], `${style}: channel ${c} sample ${i}`);
    }
  }
});

// --- defensive -------------------------------------------------------------------------------

test("renderRecipe: empty or malformed input returns correctly-shaped silence rather than throwing", () => {
  const map = loopMap({ bars: 1 });
  const channels = sweep(map.totalSamples, 2);
  for (const recipe of [null, undefined, {}, { steps: [] }]) {
    const out = renderRecipe({ recipe, map, channels });
    assert.equal(out.length, map.totalSamples);
    assert.equal(out.channels.length, 2);
  }
  const empty = renderRecipe({ recipe: recipeOf(map, identitySteps(map.count)), map, channels: [] });
  assert.equal(empty.channels.length, 0);
});

test("renderRecipe: a step pointing at a slice that no longer exists renders as silence, not a crash", () => {
  const map = loopMap({ bars: 1 });
  const channels = sweep(map.totalSamples, 1);
  const steps = identitySteps(map.count);
  steps[2] = makeStep(9999, "broken");
  const out = renderRecipe({ recipe: recipeOf(map, steps), map, channels, crossfadeMs: 0 });
  assert.equal(out.length, map.totalSamples);
  for (let i = map.bounds[2]; i < map.bounds[3]; i++) assert.equal(out.channels[0][i], 0);
});

test("renderRecipe: audio too short for the requested crossfade still renders cleanly", () => {
  // 16 slices of 40 samples each - far shorter than a 1.5ms fade at any sane rate.
  const map = createSliceMap({ totalSamples: 640, sampleRate: SR, bpm: null, subdivision: "1/16" });
  const channels = sweep(640, 1);
  const out = renderRecipe({ recipe: generateRecipe({ map, style: "chaos", intensity: 100, seed: 5 }), map, channels });
  assert.equal(out.length, 640);
  for (const v of out.channels[0]) assert.ok(Number.isFinite(v));
});

// --- naming ----------------------------------------------------------------------------------

test("variationFileName: source stem, FLIP, zero-padded index, seed", () => {
  assert.equal(variationFileName("Dusty Piano Cm 80 BPM.wav", 1, 12345), "Dusty Piano Cm 80 BPM_FLIP_01_seed12345.wav");
  assert.equal(variationFileName("break.aiff", 12, 7), "break_FLIP_12_seed7.wav");
  assert.equal(variationFileName("loop.wav", 1, 12345), variationFileName("loop.wav", 1, 12345), "stable for the same inputs");
});

test("variationFileName: the seed in the name is what reproduces the arrangement", () => {
  // The point of putting it there at all: read it off a file, type it back in, get that take back.
  const name = variationFileName("loop.wav", 3, 987654321);
  const seed = Number(name.match(/_seed(\d+)\.wav$/)[1]);
  assert.equal(seed, 987654321);
});

test("sourceStem: strips the extension and anything a filesystem would object to", () => {
  assert.equal(sourceStem("plain.wav"), "plain");
  assert.equal(sourceStem("a/b\\c.wav").includes("/"), false);
  assert.equal(sourceStem("a/b\\c.wav").includes("\\"), false);
  assert.ok(sourceStem("").length > 0, "never produces an empty name");
  assert.ok(sourceStem("x".repeat(400)).length <= 60, "stays a sane length");
});

test("batchFolderName: one folder per source, per batch", () => {
  assert.equal(batchFolderName("amen_pt2.wav"), "amen_pt2_FLIP");
});

test("uniqueName: two identical names never silently overwrite each other", () => {
  const taken = new Set();
  assert.equal(uniqueName("a_FLIP_01_seed1.wav", taken), "a_FLIP_01_seed1.wav");
  assert.equal(uniqueName("a_FLIP_01_seed1.wav", taken), "a_FLIP_01_seed1_2.wav");
  assert.equal(uniqueName("a_FLIP_01_seed1.wav", taken), "a_FLIP_01_seed1_3.wav");
  assert.equal(taken.size, 3);
});

console.log(`\n${passed} test(s) passed.`);
