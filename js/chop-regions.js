// chop-regions.js
//
// Pure decision logic for what Process/Export should do with a file's chop (or one-shot) regions,
// pulled out of app.js's processOneFile() so it can be unit-tested without a browser, a decoded
// file, or essentia. The actual detection (phraseRegions/computeDrumRegions/detectOneShotRegions)
// stays in app.js - this module only decides WHETHER to call it.
//
// The rule the whole "Process must preserve user-edited chops" fix rests on: if a cache entry
// already holds regions (from a fresh detection, a re-chop, or a manual edit - analysisCache doesn't
// distinguish, because the editor writes edits straight back into the same field), Process reuses
// them as-is. Fresh detection only ever runs when there is nothing yet to preserve - the entry is
// missing, or its own detectionSignature() went stale (a settings change that actually affects where
// cuts land, which is its own explicit trigger for re-detection, distinct from re-chop).

/**
 * @param {number[][]|null|undefined} existingRegions - already-canonical regions for this file, if
 *   any (main chops or one-shots - this module doesn't care which), straight from analysisCache
 * @param {number[][]|null|undefined} existingBaseline - that same cache entry's baseline snapshot
 * @param {() => number[][]} detectFresh - called only when there is nothing cached to reuse
 * @returns {{regions: number[][], baseline: number[][], reused: boolean}}
 */
export function resolveRegions(existingRegions, existingBaseline, detectFresh) {
  if (existingRegions) {
    const baseline = existingBaseline || existingRegions.map((r) => [...r]);
    return { regions: existingRegions, baseline, reused: true };
  }
  const regions = detectFresh();
  return { regions, baseline: regions.map((r) => [...r]), reused: false };
}

/**
 * Wholesale replacement of the canonical regions - what an explicit, intentionally destructive
 * action (Re-chop by count/bars, Clear) does. Unlike resolveRegions(), this always produces a fresh
 * baseline too: the whole point of these actions is that Revert should come back to THIS layout, not
 * whatever was detected before it.
 * @param {number[][]} newRegions
 */
export function replaceRegions(newRegions) {
  const regions = newRegions.map((r) => [...r]);
  return { regions, baseline: regions.map((r) => [...r]) };
}

/**
 * The chop (or one-shot) index that should stay selected after Process re-renders a file's editor,
 * given whatever was selected last time. Falls back to "nothing selected" if the previous index no
 * longer points at a real region (e.g. it was deleted, or the set is now shorter).
 * @param {number|null|undefined} previousIndex
 * @param {number} regionCount
 * @returns {number|null}
 */
export function resolveSelection(previousIndex, regionCount) {
  return previousIndex != null && previousIndex >= 0 && previousIndex < regionCount ? previousIndex : null;
}

/**
 * One branch of the double-click gesture (js/editor-waveform.js) - see addOrSplitRegionAt() below for
 * the general "create a new slice starting here" behaviour this is part of. Splits whichever
 * canonical region contains `time` into two, right at that point, leaving every other region
 * untouched. Refuses - returns null rather than clamping or fabricating an overlapping region - when
 * there's no containing region, or `time` sits close enough to either of that region's own edges that
 * one resulting half would be shorter than `minSliceSec`. That distance check is also what rejects a
 * click that's effectively ON an existing boundary: a point that close to an edge can't be more
 * than `minSliceSec` inside its region either.
 * @param {[number,number][]} regions - canonical regions, sorted by start, non-overlapping
 * @param {number} time
 * @param {number} minSliceSec
 * @returns {{regions:[number,number][], newIndex:number}|null}
 */
export function splitRegionAt(regions, time, minSliceSec) {
  const idx = regions.findIndex(([s, e]) => time >= s && time <= e);
  if (idx === -1) return null;
  const [s, e] = regions[idx];
  if (time - s < minSliceSec || e - time < minSliceSec) return null;
  const next = regions.map((r) => [...r]);
  next.splice(idx, 1, [s, time], [time, e]);
  return { regions: next, newIndex: idx + 1 };
}

/**
 * The general double-click gesture: "I want a slice beginning here." If `time` falls inside an
 * existing canonical region, splits that region (delegates to splitRegionAt() above, unchanged
 * behaviour and refusal rules). Otherwise - empty waveform space, whether before the first region,
 * in a gap between two regions, or after the last one - creates a brand-new region starting at `time`
 * and running up to whichever comes first: the start of the next canonical region, or `duration` (end
 * of the audio) if there is none. This can never overlap an existing region, by construction (the new
 * region's end is capped at the very next region's start), and never modifies any existing region
 * either way - only ever inserts one new entry or splits one existing one.
 *
 * `time` is assumed to already be the final, snap-adjusted click position (see js/editor-waveform.js,
 * which does its own zero-crossing snap before calling in - this module stays snap-agnostic, same as
 * splitRegionAt). Refuses (returns null) rather than fabricating a too-short sliver: creating a new
 * region still respects `minSliceSec` as its own minimum length.
 * @param {[number,number][]} regions - canonical regions, sorted by start, non-overlapping
 * @param {number} time
 * @param {number} minSliceSec
 * @param {number} duration - end of the audio, i.e. what a trailing new region should run to
 * @returns {{regions:[number,number][], newIndex:number}|null}
 */
export function addOrSplitRegionAt(regions, time, minSliceSec, duration) {
  const containingIdx = regions.findIndex(([s, e]) => time >= s && time <= e);
  if (containingIdx !== -1) return splitRegionAt(regions, time, minSliceSec);

  if (!(time >= 0) || time > duration) return null;
  const nextIdx = regions.findIndex(([s]) => s > time);
  const end = nextIdx === -1 ? duration : regions[nextIdx][0];
  if (end - time < minSliceSec) return null;

  const next = regions.map((r) => [...r]);
  const insertAt = nextIdx === -1 ? next.length : nextIdx;
  next.splice(insertAt, 0, [time, end]);
  return { regions: next, newIndex: insertAt };
}

/**
 * The regions for a "re-chop from here": everything before the chosen point kept as it was, and
 * `newRegions` from the point on. `start` is where the user asked for bar 1 and `anchor` is where it
 * actually landed (the two differ when the mark was snapped onto the beat). A region that ran up to
 * or across the point is cut or stretched to end exactly at `anchor`, so the intro and the first new
 * chop meet with no gap and no overlap; a region that ended well before it keeps its own end.
 * @param {[number,number][]} existing
 * @param {number} start
 * @param {number} anchor
 * @param {[number,number][]} newRegions
 * @returns {[number,number][]}
 */
export function spliceRegionsFrom(existing, start, anchor, newRegions, tol = 1e-3) {
  const kept = [];
  for (const [s, e] of existing) {
    // The chop the re-chop starts from goes too, even when snapping moved bar 1 a little past it.
    if (s >= Math.min(start, anchor) - tol) continue;
    const end = e >= start - tol || e > anchor ? anchor : e;
    if (end - s > tol) kept.push([s, end]);
  }
  kept.sort((a, b) => a[0] - b[0]);
  return [...kept, ...newRegions.map((r) => [...r])];
}
