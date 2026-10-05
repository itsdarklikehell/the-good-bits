// Node-side unit tests for js/dsp/stretch/workspace-state.js - the pure staleness/randomise logic
// behind the Stretch workspace's "is this preview still current" indicator and its Randomise button.
// Run with: node test/stretch-workspace-state.test.mjs
import assert from "node:assert/strict";
import { stretchRenderSignature, isProcessedPreviewStale, randomiseMacroValues, randomSeed, mapPreviewPosition, RATIO_PCT_MIN, RATIO_PCT_MAX, RATIO_SLIDER_STEPS, sliderToRatioPct, ratioPctToSlider, tidyRatioPct } from "../js/dsp/stretch/workspace-state.js";

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

const baseSettings = { enabled: true, mode: "target-tempo", targetBpm: 120, ratio: 1, character: "clean", macroValues: { texture: 50 }, seed: 1 };
const baseLofi = { outputStage: { enabled: false }, drive: { enabled: false }, crunch: { enabled: false } };

test("stretchRenderSignature: identical inputs produce identical signatures", () => {
  const a = stretchRenderSignature(baseSettings, baseLofi);
  const b = stretchRenderSignature(JSON.parse(JSON.stringify(baseSettings)), JSON.parse(JSON.stringify(baseLofi)));
  assert.equal(a, b);
});

test("stretchRenderSignature: changing character, a macro value, or a lofi flag all change the signature", () => {
  const base = stretchRenderSignature(baseSettings, baseLofi);
  assert.notEqual(stretchRenderSignature({ ...baseSettings, character: "scatter" }, baseLofi), base);
  assert.notEqual(stretchRenderSignature({ ...baseSettings, macroValues: { texture: 51 } }, baseLofi), base);
  assert.notEqual(stretchRenderSignature(baseSettings, { ...baseLofi, drive: { enabled: true } }), base);
});

test("isProcessedPreviewStale: no rendered signature yet is never stale", () => {
  assert.equal(isProcessedPreviewStale(null, baseSettings, baseLofi), false);
  assert.equal(isProcessedPreviewStale(undefined, baseSettings, baseLofi), false);
});

test("isProcessedPreviewStale: matching signature is not stale, a settings change afterwards is", () => {
  const rendered = stretchRenderSignature(baseSettings, baseLofi);
  assert.equal(isProcessedPreviewStale(rendered, baseSettings, baseLofi), false);
  const changed = { ...baseSettings, character: "infinite" };
  assert.equal(isProcessedPreviewStale(rendered, changed, baseLofi), true);
});

// --- sourceBpm - user-correctable source tempo (ANALYSIS PROPOSES, USER OVERRIDES) --------------
//
// In "target-tempo" mode the rendered ratio is detectedBpm/targetBpm, so a source BPM correction
// must change the render exactly like a target-tempo change would; in "fixed-ratio" mode the ratio
// is user-set and doesn't depend on source tempo at all, so a correction there must NOT force a
// re-render of otherwise-identical audio.

test("stretchRenderSignature: in target-tempo mode, a different source BPM changes the signature", () => {
  const a = stretchRenderSignature(baseSettings, baseLofi, 70);
  const b = stretchRenderSignature(baseSettings, baseLofi, 140);
  assert.notEqual(a, b);
});

test("stretchRenderSignature: in fixed-ratio mode, source BPM is irrelevant and never changes the signature", () => {
  const fixedRatioSettings = { ...baseSettings, mode: "fixed-ratio" };
  const a = stretchRenderSignature(fixedRatioSettings, baseLofi, 70);
  const b = stretchRenderSignature(fixedRatioSettings, baseLofi, 140);
  const none = stretchRenderSignature(fixedRatioSettings, baseLofi, null);
  assert.equal(a, b);
  assert.equal(a, none);
});

test("isProcessedPreviewStale: a source BPM correction (½/×2/typed/Reset) marks a target-tempo preview stale", () => {
  const rendered = stretchRenderSignature(baseSettings, baseLofi, 70);
  assert.equal(isProcessedPreviewStale(rendered, baseSettings, baseLofi, 70), false);
  assert.equal(isProcessedPreviewStale(rendered, baseSettings, baseLofi, 140), true, "×2 (70 -> 140) must invalidate the cached preview");
});

test("isProcessedPreviewStale: the same correction is a no-op in fixed-ratio mode - no forced re-render where source BPM is irrelevant", () => {
  const fixedRatioSettings = { ...baseSettings, mode: "fixed-ratio" };
  const rendered = stretchRenderSignature(fixedRatioSettings, baseLofi, 70);
  assert.equal(isProcessedPreviewStale(rendered, fixedRatioSettings, baseLofi, 140), false);
});

test("randomiseMacroValues: only touches the character's own macros, leaves other keys and the object identity untouched", () => {
  const character = { macros: ["texture", "variation"] };
  const current = { texture: 10, variation: 20, smear: 77, roughness: 5 };
  let call = 0;
  const rng = () => [0.1, 0.9][call++]; // deterministic sequence for the test
  const next = randomiseMacroValues(character, current, rng);
  assert.notEqual(next, current, "should return a new object");
  assert.equal(current.texture, 10, "should not mutate the input");
  assert.equal(next.texture, 10); // round(0.1*100)
  assert.equal(next.variation, 90); // round(0.9*100)
  assert.equal(next.smear, 77, "untouched macro should pass through unchanged");
  assert.equal(next.roughness, 5, "untouched macro should pass through unchanged");
});

test("randomiseMacroValues: a character with no macros returns an equivalent (but new) object", () => {
  const character = {};
  const current = { texture: 50 };
  const next = randomiseMacroValues(character, current, Math.random);
  assert.deepEqual(next, current);
  assert.notEqual(next, current);
});

test("randomiseMacroValues: handles a null/undefined currentMacroValues without throwing", () => {
  const character = { macros: ["smear"] };
  const next = randomiseMacroValues(character, undefined, () => 0.5);
  assert.equal(next.smear, 50);
});

test("randomSeed: stays within [0, 999999] and is driven by the supplied rng", () => {
  assert.equal(randomSeed(() => 0), 0);
  assert.equal(randomSeed(() => 0.999999), 999999);
  const seeds = new Set(Array.from({ length: 20 }, () => randomSeed(Math.random)));
  assert.ok(seeds.size > 1, "should vary across calls with Math.random");
  for (const s of seeds) assert.ok(s >= 0 && s <= 999999);
});

test("mapPreviewPosition: maps by proportion of duration, not raw seconds", () => {
  // 10s into a 20s original (50%) -> 50% of a 30s processed take = 15s, NOT 10s.
  assert.equal(mapPreviewPosition(10, 20, 30), 15);
  assert.equal(mapPreviewPosition(0, 20, 30), 0);
  assert.equal(mapPreviewPosition(20, 20, 30), 30);
});

test("mapPreviewPosition: clamps an out-of-range position instead of extrapolating past either end", () => {
  assert.equal(mapPreviewPosition(25, 20, 30), 30); // position beyond its own duration clamps to 100%
  assert.equal(mapPreviewPosition(-5, 20, 30), 0);
});

test("mapPreviewPosition: falls back to 0 for an unusable (zero/negative/NaN) duration on either side", () => {
  assert.equal(mapPreviewPosition(10, 0, 30), 0);
  assert.equal(mapPreviewPosition(10, 20, 0), 0);
  assert.equal(mapPreviewPosition(10, -1, 30), 0);
  assert.equal(mapPreviewPosition(10, 20, NaN), 0);
});

console.log(`\n${passed} test(s) passed.`);

test("ratio slider: log scale spans 5%..100000% with 100% near the middle-left and round-trips typed values", () => {
  assert.equal(sliderToRatioPct(0), RATIO_PCT_MIN);
  assert.equal(sliderToRatioPct(RATIO_SLIDER_STEPS), RATIO_PCT_MAX);
  assert.equal(sliderToRatioPct(ratioPctToSlider(100)), 100);
  for (const pct of [5, 50, 100, 250, 1000, 5000, 100000]) {
    const back = sliderToRatioPct(ratioPctToSlider(pct));
    assert.ok(Math.abs(back - pct) / pct < 0.02, `${pct}% -> slider -> ${back}%`);
  }
});

test("tidyRatioPct: clamps into range and rounds big values to readable steps", () => {
  assert.equal(tidyRatioPct(1), RATIO_PCT_MIN);
  assert.equal(tidyRatioPct(999999), RATIO_PCT_MAX);
  assert.equal(tidyRatioPct("abc"), 100);
  assert.equal(tidyRatioPct(137.4), 137);
  assert.equal(tidyRatioPct(1234), 1230);
  assert.equal(tidyRatioPct(23456), 23500);
});
