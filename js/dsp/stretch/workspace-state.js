// workspace-state.js
//
// Small, pure (no DOM) helpers behind the Stretch workspace's "is the audio you're looking at
// actually what your current settings would produce" state model, and its Randomise button. Kept
// separate from app.js so this logic - which has real edge cases worth locking down with tests - is
// unit-testable in Node like the rest of the dsp modules, instead of only reachable through a
// browser.

/**
 * A stable, comparable snapshot of everything that affects a stretch render: if this string is the
 * same before and after a settings change, re-processing would produce byte-identical audio, so
 * there's nothing to mark stale. Key order doesn't matter for correctness (JSON.stringify on a
 * plain object is deterministic for a given engine, and both sides of every comparison here are
 * produced by this same function), only that the same shape of input always produces the same string.
 *
 * `sourceBpm` (the source file's EFFECTIVE tempo - see effectiveTempo() in app.js) only ever affects
 * the render in "target-tempo" mode, where it feeds the stretch ratio; "fixed-ratio" mode's ratio is
 * user-set and doesn't depend on it at all. Folding it in unconditionally would mark a fixed-ratio
 * preview stale (and force a byte-identical re-render) every time a source BPM correction happened to
 * touch the active file, so it's only mixed into the signature for the mode where it actually matters.
 */
export function stretchRenderSignature(timestretchSettings, lofiSnapshot, sourceBpm) {
  const bpm = timestretchSettings.mode === "target-tempo" ? sourceBpm ?? null : null;
  return JSON.stringify({ ts: timestretchSettings, lofi: lofiSnapshot, bpm });
}

/**
 * Whether a previously-rendered "processed" preview (captured with `renderedSignature` at the time
 * it was computed) still matches the CURRENT settings (and, in target-tempo mode, the current source
 * BPM). `null`/`undefined` renderedSignature (nothing has been processed yet) is never stale - there's
 * no stale preview on screen to warn about.
 */
export function isProcessedPreviewStale(renderedSignature, timestretchSettings, lofiSnapshot, sourceBpm) {
  if (!renderedSignature) return false;
  return renderedSignature !== stretchRenderSignature(timestretchSettings, lofiSnapshot, sourceBpm);
}

/**
 * New macro values for Randomise: every macro the character actually uses gets a fresh value in
 * [0,100] from `rng` (a () => [0,1) function, e.g. Math.random or a seeded generator - callers that
 * want a reproducible randomisation can pass their own); every other key in `currentMacroValues` is
 * left untouched, so randomising e.g. Scatter's texture/variation can't clobber a smear value another
 * character was using. Returns a new object - never mutates `currentMacroValues`.
 */
export function randomiseMacroValues(character, currentMacroValues, rng = Math.random) {
  const next = { ...(currentMacroValues || {}) };
  for (const key of character.macros || []) {
    next[key] = Math.round(rng() * 100);
  }
  return next;
}

/** A new integer seed in the same [0, 999999] range the Variation seed field accepts. */
export function randomSeed(rng = Math.random) {
  return Math.floor(rng() * 1000000);
}

/**
 * Maps a playhead position from one preview's timeline to the other's by proportion (fraction of
 * duration elapsed), not raw seconds - since stretching changes duration, "10s into a 20s original"
 * and "10s into a 29s processed take" are not remotely the same musical moment, but "50% through"
 * is a reasonable stand-in for it in both. Falls back to 0 if either duration is unusable (silent/
 * unloaded audio), rather than propagating NaN/Infinity into a seek call.
 */
export function mapPreviewPosition(fromPositionSec, fromDurationSec, toDurationSec) {
  if (!(fromDurationSec > 0) || !(toDurationSec > 0)) return 0;
  const proportion = Math.max(0, Math.min(1, fromPositionSec / fromDurationSec));
  return proportion * toDurationSec;
}

// Stretch-amount control. The range runs from 5% to 100000% (1000x), so a linear slider would spend
// nearly all its travel on absurd lengths and leave 50-200% crammed into a pixel. The slider is a
// log scale over RATIO_SLIDER_STEPS positions instead; the number box beside it takes the % as typed.
export const RATIO_PCT_MIN = 5;
export const RATIO_PCT_MAX = 100000;
export const RATIO_SLIDER_STEPS = 1000;

/** Clamp a typed/saved % into range and round it to a readable value - finer steps at small amounts. */
export function tidyRatioPct(pct) {
  const v = Math.min(RATIO_PCT_MAX, Math.max(RATIO_PCT_MIN, Number(pct) || 100));
  const step = v >= 10000 ? 100 : v >= 1000 ? 10 : 1;
  return Math.max(RATIO_PCT_MIN, Math.round(v / step) * step);
}

/** Slider position (0..RATIO_SLIDER_STEPS) -> stretch %. */
export function sliderToRatioPct(pos) {
  const t = Math.min(1, Math.max(0, Number(pos) / RATIO_SLIDER_STEPS));
  return tidyRatioPct(RATIO_PCT_MIN * Math.pow(RATIO_PCT_MAX / RATIO_PCT_MIN, t));
}

/** Stretch % -> slider position. */
export function ratioPctToSlider(pct) {
  const v = Math.min(RATIO_PCT_MAX, Math.max(RATIO_PCT_MIN, Number(pct) || 100));
  return Math.round((Math.log(v / RATIO_PCT_MIN) / Math.log(RATIO_PCT_MAX / RATIO_PCT_MIN)) * RATIO_SLIDER_STEPS);
}
