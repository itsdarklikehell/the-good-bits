// slice-map.js
//
// FLIP stage 1: ANALYSE SOURCE -> CREATE SLICE MAP.
//
// Pure. Given a duration, a sample rate and whatever the existing key/tempo detection managed to
// work out (see js/essentia-bridge.js - FLIP deliberately reuses that rather than growing a second
// analysis system), this decides where the rhythmic slice boundaries are and what each slice MEANS
// musically: which beat it belongs to, whether it's a bar downbeat, how strong its metric position
// is. Everything downstream - the transformation weights, the downbeat protection, the group sizes -
// reads that meaning rather than re-deriving it from indices.
//
// THE ONE HARD RULE: the slice map always covers the WHOLE source, start to end, with no gaps and
// no overlap, and the boundaries are integer sample offsets computed from the exact ideal positions
// rather than accumulated. A recipe is a permutation of these slots, so if the map tiles the source
// exactly then every rendered variation is bit-for-bit the same length as the original - which is
// the whole timing guarantee FLIP makes. See js/flip/render.js.
//
// WHEN THE FILE ISN'T A WHOLE NUMBER OF SLICES: the grid is fitted to the file rather than the file
// being trimmed to the grid. A 4.02-bar recording sliced at 1/16 gets 64 slices that are each 0.5%
// long, not 64 slices plus a 0.02-bar orphan that any rearrangement would audibly drop. The error
// is reported (see `fit`) so the UI can say so when it gets big enough to matter.

/**
 * The chop sizes the UI offers, coarsest first. `slicesPerBar` is the primary number.
 *
 * SIZED PER BAR, NOT PER BEAT, and that inversion is the whole point. Deriving the grid from a
 * musical subdivision of the BEAT structurally forbids a chop bigger than one - the atom could
 * never be a half-bar, so the smallest thing FLIP could physically move was always a beat or less,
 * and bar-scale operations could only ever be built out of runs of small pieces.
 *
 * The RS7000's Loop Remix works the other way round: it detects the phrase length and you choose
 * how many chops to cut it into, so "8 bars in 8 chops" makes a whole bar the atom. Expressing the
 * choice as a musical size rather than a raw count keeps it readable (and keeps the grid on the
 * bar line), while the chop COUNT is what the readout shows, because that is the number you are
 * really picking.
 */
export const SUBDIVISIONS = [
  { key: "1bar", label: "1 bar", slicesPerBar: 1, hint: "whole bars" },
  { key: "1/2bar", label: "½ bar", slicesPerBar: 2, hint: "half-bars" },
  { key: "1/4", label: "1/4", slicesPerBar: 4, hint: "beats" },
  { key: "1/8", label: "1/8", slicesPerBar: 8, hint: "eighths" },
  { key: "1/16", label: "1/16", slicesPerBar: 16, hint: "sixteenths" },
  { key: "1/32", label: "1/32", slicesPerBar: 32, hint: "thirty-seconds" },
];

export const DEFAULT_SUBDIVISION = "1/16";

/** Anything below this and there is nothing to rearrange - see sliceMapReadiness(). */
export const MIN_SLICES = 4;
/** Above this the UI is unusable and the edit density is pure noise, whatever the intensity says. */
export const MAX_SLICES = 512;

export function resolveSubdivision(key) {
  return SUBDIVISIONS.find((s) => s.key === key) || SUBDIVISIONS.find((s) => s.key === DEFAULT_SUBDIVISION);
}

/**
 * Metric weight of a slice, 0..1 - "how much does moving this one hurt?".
 *
 * Bar downbeat is 1, beat 3 of a 4/4 bar is next, other beats next, then off-beat subdivisions by
 * how coarse a grid they land on. The transformation layer multiplies its mutation probabilities by
 * the inverse of this at low intensity, which is what produces "it kept the downbeats" without any
 * operation needing to know what a downbeat is.
 */
export function metricStrength(sliceIndex, perBeat, perBar) {
  if (perBar <= 0 || perBeat <= 0) return 0.5;
  const beatsPerBar = Math.max(1, Math.round(perBar / perBeat));
  const inBar = sliceIndex % perBar;
  if (inBar === 0) return 1;
  if (inBar % perBeat !== 0) {
    // Off the beat: weight by how coarse a subdivision it still lands on (an eighth inside a
    // sixteenth grid beats a stray sixteenth).
    const offset = inBar % perBeat;
    for (let div = perBeat >> 1; div >= 1; div >>= 1) {
      if (offset % div === 0) return 0.1 + 0.25 * (div / perBeat);
    }
    return 0.1;
  }
  const beatInBar = inBar / perBeat;
  // Beat 3 of four is the secondary strong beat; 2 and 4 are weaker.
  if (beatsPerBar % 2 === 0 && beatInBar === beatsPerBar / 2) return 0.75;
  return 0.55;
}

/**
 * Build the slice map.
 *
 * @param {object} opts
 * @param {number} opts.totalSamples   length of the source in sample frames
 * @param {number} opts.sampleRate
 * @param {number|null} opts.bpm       the EFFECTIVE tempo (detection or manual correction), or null
 * @param {string} opts.subdivision    a SUBDIVISIONS key
 * @param {number} [opts.beatsPerBar]
 * @returns {object} slice map
 */
export function createSliceMap({ totalSamples, sampleRate, bpm, subdivision = DEFAULT_SUBDIVISION, beatsPerBar = 4 }) {
  const sub = resolveSubdivision(subdivision);
  const duration = totalSamples > 0 && sampleRate > 0 ? totalSamples / sampleRate : 0;
  // A chop can now be BIGGER than a beat, so slices-per-bar is what's given and slices-per-beat is
  // what's derived - clamped at 1, because at half-bar and whole-bar chop sizes a "beat" in the
  // hierarchy is simply one chop. levelExists() in js/flip/hierarchy.js collapses the levels that
  // stop being distinct, so nothing downstream has to know which regime it is in.
  const perBar = sub.slicesPerBar;
  const perBeat = Math.max(1, Math.round(perBar / beatsPerBar));

  let count;
  let fit = { source: "tempo", requested: 0, error: 0, aligned: "bar" };

  if (bpm && bpm > 0 && duration > 0) {
    const barSeconds = (60 / bpm) * beatsPerBar;
    const nominal = barSeconds / perBar; // one chop, in seconds, at the detected tempo
    const requested = duration / nominal;
    // PREFER A WHOLE NUMBER OF BARS. Detection is rarely exact - a true 120 BPM four-bar loop comes
    // back as 119.87 and asks for 256.3 sixteenths - and plain rounding then lands on 256 by luck
    // and on 385 (24.06 bars) just as easily. Snapping to the nearest whole bar when one is close
    // enough is what makes the phrase-level operations (repeat a bar, swap neighbouring bars, A/B/A)
    // line up with the music instead of drifting a slice further out of phase every bar.
    //
    // When nothing musical is within reach the count falls back to plain rounding and `aligned`
    // says so, which is the honest signal that the tempo is probably just wrong for this file -
    // see sliceMapReadiness(), which turns that into something the user can act on.
    const rel = (n) => (requested > 0 ? Math.abs(requested - n) / requested : 1);
    const nearestBar = Math.max(perBar, Math.round(requested / perBar) * perBar);
    const nearestBeat = Math.max(perBeat, Math.round(requested / perBeat) * perBeat);
    let aligned = "slice";
    if (rel(nearestBar) <= 0.02) {
      count = nearestBar;
      aligned = "bar";
    } else if (rel(nearestBeat) <= 0.02) {
      count = nearestBeat;
      aligned = "beat";
    } else {
      count = Math.max(1, Math.round(requested));
    }
    fit = { source: "tempo", requested, error: count > 0 ? Math.abs(requested - count) / count : 0, aligned };
  } else {
    // NO TEMPO. Rather than refusing, fall back to the assumption that a loop is a loop: divide it
    // into a power-of-two count in the right ballpark for the chosen subdivision, so the slices
    // still land on plausible musical positions even though nothing told us where the beats are.
    // The UI says so, and typing a tempo switches this branch off.
    const assumedBars = 4;
    const ideal = assumedBars * perBar;
    count = ideal;
    fit = { source: "even", requested: ideal, error: 0, aligned: "bar" };
  }

  count = Math.max(1, Math.min(MAX_SLICES, count));

  // Exact positions, rounded independently - NOT accumulated - so the boundaries tile
  // [0, totalSamples) with no drift and no leftover samples at the end.
  const bounds = new Int32Array(count + 1);
  for (let i = 0; i <= count; i++) bounds[i] = Math.round((i * totalSamples) / count);
  bounds[count] = totalSamples;

  const slices = [];
  for (let i = 0; i < count; i++) {
    const inBar = i % perBar;
    slices.push({
      index: i,
      startSample: bounds[i],
      endSample: bounds[i + 1],
      length: bounds[i + 1] - bounds[i],
      beat: Math.floor(i / perBeat),
      bar: Math.floor(i / perBar),
      isBeat: inBar % perBeat === 0,
      isDownbeat: inBar === 0,
      strength: metricStrength(i, perBeat, perBar),
    });
  }

  return {
    subdivision: sub.key,
    perBeat,
    beatsPerBar,
    perBar,
    bpm: bpm || null,
    sampleRate,
    totalSamples,
    duration,
    count,
    bars: count / perBar,
    slices,
    bounds,
    fit,
  };
}

/**
 * Is this map worth generating from, and what should the UI say if not?
 * @returns {{ok:boolean, reason:string|null, warning:string|null}}
 */
export function sliceMapReadiness(map) {
  if (!map || !map.count || !map.totalSamples) {
    return { ok: false, reason: "There's no audio to slice yet.", warning: null };
  }
  if (map.count < MIN_SLICES) {
    // Only suggest a finer slice size when a finer one would actually get there. On a 0.15s file
    // nothing will, and "try 1/32" is advice that wastes the user's next click.
    const finer = SUBDIVISIONS.filter((s) => s.slicesPerBar > map.perBar);
    const rescue = finer.find((s) => map.count * (s.slicesPerBar / map.perBar) >= MIN_SLICES);
    const advice = rescue ? `Try ${rescue.label}, or a longer loop.` : "FLIP needs a loop, not a one-shot - a bar or more.";
    return {
      ok: false,
      reason: `That's only ${map.count} chop${map.count === 1 ? "" : "s"} at ${chopLabel(map)} - too short to rearrange. ${advice}`,
      warning: null,
    };
  }
  const shortest = map.slices.reduce((min, s) => Math.min(min, s.length), Infinity);
  if (shortest < 32) {
    return { ok: false, reason: `Chops are down to ${shortest} samples at ${chopLabel(map)}. Use a coarser chop size.`, warning: null };
  }

  let warning = null;
  if (map.fit.source === "even") {
    warning = `No confident tempo, so the loop was divided evenly into ${map.count} chops - four bars' worth, assumed. Type a tempo above to chop on the real grid.`;
  } else if (map.fit.aligned === "slice") {
    // Nothing musical was within reach of the detected tempo, which on a file that really is a
    // loop almost always means the detection is wrong rather than the loop being strange. Say that,
    // and point at the control that fixes it, rather than quietly generating against a grid that
    // slides a little further out of phase every bar.
    const bars = map.bars.toFixed(2);
    warning = `At ${Math.round(map.bpm)} BPM this is ${bars} bars - not a whole number, so the grid doesn't line up with the music. If it really is a loop, the detected tempo is probably wrong: correct it above (½ and ×2 fix the usual half/double-time error) and the slices follow.`;
  } else if (map.count === MAX_SLICES) {
    warning = `Capped at ${MAX_SLICES} chops - a coarser chop size will follow the grid more closely.`;
  }
  // Deliberately NO warning when `aligned` is "bar" or "beat", however far the detected tempo was
  // from landing on it. That case is the grid being snapped onto the music and then fitted to the
  // file's exact length - which is the good outcome, not a compromise worth interrupting for. The
  // only honest warning is the one above, where nothing musical was within reach at all.
  return { ok: true, reason: null, warning };
}

/** The label for this map's chop size, e.g. "1/16" or "½ bar". */
export function chopLabel(map) {
  const sub = SUBDIVISIONS.find((s) => s.key === (map && map.subdivision));
  return sub ? sub.label : (map && map.subdivision) || "";
}

/** "4 bars · 64 × 1/16 · 120 BPM" - the one-line description of what's being chopped. */
export function describeSliceMap(map) {
  if (!map) return "";
  const bars = map.bars;
  const barText = Number.isFinite(bars) ? (Math.abs(bars - Math.round(bars)) < 0.02 ? `${Math.round(bars)} bar${Math.round(bars) === 1 ? "" : "s"}` : `${bars.toFixed(2)} bars`) : "";
  const tempo = map.bpm ? `${Math.round(map.bpm)} BPM` : "no tempo";
  return [barText, `${map.count} × ${chopLabel(map)}`, tempo].filter(Boolean).join(" · ");
}
