// dsp.js
//
// Pure signal-analysis functions used to find chop boundaries.
// Nothing in this file touches the DOM, the Web Audio API, or fetch/File -
// everything operates on plain Float32Array sample data and numbers, so it
// can be unit-tested in Node as easily as it runs in the browser.
//
// This is a from-scratch rework of a phrase/onset detection approach, with
// two structural changes aimed at a large, varied library of source
// recordings rather than a single mixed/mastered record:
//
//   1. Silence detection is loudness-ADAPTIVE. Instead of a fixed absolute
//      dBFS threshold (which behaves inconsistently across quiet vs. hot
//      recordings), the threshold is set relative to each file's own
//      estimated noise floor.
//   2. Drum chop boundaries can snap to a detected tempo grid, so that a
//      chop's length is an exact whole number of beats and loops cleanly.

// ---------------------------------------------------------------------------
// Basic envelope / energy analysis
// ---------------------------------------------------------------------------

/**
 * Compute a short-time RMS envelope of a mono signal.
 * @param {Float32Array} mono
 * @param {number} sampleRate
 * @param {number} winMs   analysis window length in ms
 * @param {number} hopMs   hop size in ms
 * @returns {{times:number[], vals:number[]}} vals are linear RMS (0..~1)
 */
export function computeRmsEnvelope(mono, sampleRate, winMs = 25, hopMs = 10) {
  const win = Math.max(1, Math.round((sampleRate * winMs) / 1000));
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const times = [];
  const vals = [];

  for (let pos = 0; pos < mono.length; pos += hop) {
    const end = Math.min(mono.length, pos + win);
    if (end <= pos) break;
    let sumSq = 0;
    for (let i = pos; i < end; i++) {
      const s = mono[i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / (end - pos));
    vals.push(rms);
    times.push(pos / sampleRate);
  }
  return { times, vals };
}

/** Linear amplitude -> dBFS. Silent/zero input maps to a very low floor. */
export function linToDb(v) {
  return v > 1e-9 ? 20 * Math.log10(v) : -180;
}

/**
 * Estimate the noise floor of a recording from its own RMS envelope, as a
 * low percentile of the (non -180) dB values. This is what makes silence
 * detection adapt to each file instead of using one fixed threshold for
 * every recording in the library.
 */
export function estimateNoiseFloorDb(vals, percentile = 0.10) {
  // Deliberately does NOT exclude true digital silence (-180dB) - some
  // sources have exact-zero gaps between phrases, and those samples are
  // exactly what should anchor the floor estimate low enough that real
  // playing (at any reasonable level) still reads as "loud".
  if (vals.length === 0) return -60;
  const dbs = vals.map(linToDb).sort((a, b) => a - b);
  const idx = Math.min(dbs.length - 1, Math.max(0, Math.floor(dbs.length * percentile)));
  return dbs[idx];
}

// ---------------------------------------------------------------------------
// Region utilities
// ---------------------------------------------------------------------------

/**
 * Find non-silent [start,end] regions from an RMS envelope, using an
 * absolute dB threshold and a minimum silence duration to bridge over.
 */
export function nonSilentRegions(times, vals, thresholdDb, minSilenceSec) {
  const n = times.length;
  if (n === 0) return [];
  const hop = n > 1 ? times[1] - times[0] : 0.01;
  const isLoud = vals.map((v) => linToDb(v) >= thresholdDb);

  // Collapse silent runs shorter than minSilenceSec back into "loud" so a
  // brief dip doesn't fragment a phrase.
  let i = 0;
  while (i < n) {
    if (!isLoud[i]) {
      let j = i;
      while (j < n && !isLoud[j]) j++;
      const runLen = (j - i) * hop;
      if (runLen < minSilenceSec) {
        for (let k = i; k < j; k++) isLoud[k] = true;
      }
      i = j;
    } else {
      i++;
    }
  }

  const regions = [];
  let start = null;
  for (let k = 0; k < n; k++) {
    if (isLoud[k] && start === null) {
      start = times[k];
    } else if (!isLoud[k] && start !== null) {
      regions.push([start, times[k]]);
      start = null;
    }
  }
  if (start !== null) {
    const total = times[n - 1] + hop;
    regions.push([start, total]);
  }
  return regions;
}

/** Merge regions separated by a gap of `gap` seconds or less. */
export function mergeRegions(regions, gap) {
  if (regions.length === 0) return [];
  const merged = [regions[0].slice()];
  for (let i = 1; i < regions.length; i++) {
    const [s, e] = regions[i];
    const last = merged[merged.length - 1];
    if (s - last[1] <= gap) {
      last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

/** Pad each region outward and drop anything still under minLen. */
export function padAndFilterRegions(regions, pad, minLen, totalDuration) {
  const out = [];
  for (const [s0, e0] of regions) {
    const s = Math.max(0, s0 - pad);
    const e = Math.min(totalDuration, e0 + pad);
    if (e - s >= minLen) out.push([s, e]);
  }
  return out;
}

/** Time of the lowest-energy sample of the envelope within [a,b]. */
export function lowestEnergyTime(times, vals, a, b, fallback) {
  let best = null;
  let bestVal = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (t < a || t > b) continue;
    if (vals[i] < bestVal) {
      bestVal = vals[i];
      best = t;
    }
  }
  return best === null ? fallback : best;
}

/**
 * Split any region longer than maxLen into pieces near `preferred` length,
 * choosing the cut point at the lowest-energy moment in a window around the
 * target rather than an arbitrary timestamp.
 */
export function splitLongNaturally(regions, times, vals, preferred, maxLen, minPiece) {
  const out = [];
  for (const [s, e] of regions) {
    let cur = s;
    while (e - cur > maxLen) {
      const target = cur + preferred;
      const searchA = Math.max(cur + minPiece, target - 3.0);
      const searchB = Math.min(e - minPiece, target + 3.0);
      let cut;
      if (searchB <= searchA) {
        cut = Math.min(cur + maxLen, e);
      } else {
        cut = lowestEnergyTime(times, vals, searchA, searchB, target);
      }
      if (cut - cur < minPiece) cut = Math.min(cur + maxLen, e);
      out.push([cur, cut]);
      cur = cut;
    }
    if (e - cur >= minPiece) {
      out.push([cur, e]);
    } else if (out.length && Math.abs(out[out.length - 1][1] - cur) < 1e-6) {
      out[out.length - 1][1] = e;
    }
  }
  return out;
}

/**
 * How far below a file's own playing level the gate sits, when that's higher than the noise-floor
 * margin. The floor alone is not a reliable reference: a file with true digital silence in it
 * reports a floor of -180dB, which puts the gate below anything that ever happens, and a hissy
 * tape transfer reports a floor so high that quiet playing reads as silence. Measuring down from
 * how loud the file actually plays is stable in both cases.
 */
const PHRASE_ACTIVE_DROP_DB = 26;

/** Gate ceiling: quiet playing this far under the file's own playing level still counts as playing. */
const PHRASE_ACTIVE_FLOOR_DB = 26;

/** Pre-roll kept in front of the note a phrase starts on, so the attack is never clipped. */
const PHRASE_PREROLL_SEC = 0.02;

/** How far from a chosen boundary to look for the attack it should actually sit on. */
const PHRASE_ATTACK_SEARCH_SEC = 0.35;

/** How far back a candidate boundary looks for the dip that makes it a phrase end. */
const PHRASE_DIP_WINDOW_SEC = 0.3;

/** A dip this far (dB) under the surrounding playing level counts as a phrase end without a full silence. */
const PHRASE_DIP_DB = 12;

/** ...and it has to stay down this long. A gap between two notes of one phrase is brief; a phrase end hangs. */
const PHRASE_DIP_MIN_SEC = 0.15;

/** Score a candidate boundary must reach to split continuous playing. */
const PHRASE_BOUNDARY_SCORE = 2.5;

/** Phrases are not one note long: boundaries stay at least this far apart, over and above minLen. */
const PHRASE_MIN_SPACING_SEC = 2;

/**
 * Musical phrase detection for melodic sources (sax/trumpet, Rhodes).
 *
 * Silence alone does not find phrases in this material. A horn player breathes, but a Rhodes part
 * can run for minutes with no gap that ever reaches the noise floor, and the old pipeline - gate,
 * merge, then cut anything too long at its quietest moment - had nothing musical to say about
 * those files: it cut every `preferred` seconds at whatever frame happened to be lowest, which
 * lands mid-note about as often as not.
 *
 * What actually marks the end of a phrase is a DIP followed by an ATTACK: the line falls away (a
 * breath, a released chord, a held note decaying) and then something new starts. Both parts matter.
 * A dip with no attack after it is just a quiet passage; an attack with no dip before it is the
 * next note of the phrase already in progress. Scoring the two together finds phrase boundaries in
 * continuous playing, and it puts the cut ON the attack, where the ear expects a sample to start.
 *
 * So: gate the file into runs of playing, split each run at every boundary that scores highly
 * enough, force a split in anything still longer than maxLen, and let the lengths fall where the
 * playing puts them. `preferred` is only a mild tiebreaker between two otherwise equal candidates,
 * not a target length.
 */
export function phraseRegions(mono, sampleRate, p) {
  const duration = mono.length / sampleRate;
  const { times, vals } = computeRmsEnvelope(mono, sampleRate, 25, 10);
  if (!vals.length) return { regions: [[0, duration]], noiseFloorDb: -180, thresholdDb: -180 };
  const hop = times.length > 1 ? times[1] - times[0] : 0.01;
  const dbs = vals.map(linToDb);

  const noiseFloorDb = estimateNoiseFloorDb(vals);
  const activeDb = percentile(dbs.filter((v) => v > -180), 0.9);
  // Never gate away material that is within PHRASE_ACTIVE_FLOOR_DB of how loud the file plays: on a
  // hissy transfer the floor is so high that "floor + margin" lands in the middle of the playing
  // and throws away a third of the file.
  const thresholdDb = Math.min(
    Math.max(noiseFloorDb + p.silenceMarginDb, activeDb - PHRASE_ACTIVE_DROP_DB),
    activeDb - PHRASE_ACTIVE_FLOOR_DB
  );

  // 1. Runs of playing, separated by gaps long enough to be real rests. A gap has to clear both
  // knobs: minSilenceDuration (how long counts as silence) and mergeGap (how long a gap has to be
  // before it's worth splitting on).
  const gapMin = Math.max(p.minSilenceDuration, p.mergeGap);
  const loud = dbs.map((v) => v >= thresholdDb);
  const runs = [];
  let runStart = null;
  let quietFrom = null;
  for (let i = 0; i < loud.length; i++) {
    if (loud[i]) {
      if (runStart == null) runStart = i;
      else if (quietFrom != null && (i - quietFrom) * hop >= gapMin) {
        runs.push([runStart, quietFrom]);
        runStart = i;
      }
      quietFrom = null;
    } else if (quietFrom == null) {
      quietFrom = i;
    }
  }
  if (runStart != null) runs.push([runStart, quietFrom != null ? quietFrom : loud.length]);
  if (!runs.length) return { regions: [], noiseFloorDb, thresholdDb };

  // 2. Attacks, for putting cuts on note starts rather than in the middle of them.
  const { diffs } = multiBandOnsetStrengthCurve(mono, sampleRate, 20, 10, { times, vals });
  const onsetStrength = new Map();
  const onsets = pickOnsets(times, diffs, 0.5, 0.12);
  for (const t of onsets) {
    const i = Math.round(t / hop);
    let peak = 0;
    for (let k = Math.max(0, i - 1); k <= Math.min(diffs.length - 1, i + 1); k++) peak = Math.max(peak, diffs[k]);
    onsetStrength.set(t, peak);
  }
  const strengthRef = Math.max(1e-6, percentile([...onsetStrength.values()], 0.75));

  /**
   * How good a phrase boundary the attack at `t` makes: how far the line dropped just before it
   * (in dB, against the playing level around it) and how hard it comes back in. Both are needed -
   * see this function's own doc comment above.
   */
  // Local playing level: a moving average of the envelope in dB, a few seconds wide. A phrase end
  // is a dip against what the player is doing HERE - one run of a Rhodes take can span a quiet
  // passage and a loud one, and a single level for the whole run finds boundaries in the loud part
  // and none in the quiet one.
  const localRef = (() => {
    const win = Math.max(1, Math.round(2.5 / hop));
    const out = new Float64Array(dbs.length);
    let sum = 0;
    let n = 0;
    const clean = dbs.map((v) => (v > -180 ? v : null));
    for (let i = 0; i < dbs.length; i++) {
      if (clean[i] != null) {
        sum += clean[i];
        n++;
      }
      const drop = i - win;
      if (drop >= 0 && clean[drop] != null) {
        sum -= clean[drop];
        n--;
      }
      out[i] = n ? sum / n : -180;
    }
    return out;
  })();

  const boundaryScore = (t) => {
    const i = Math.round(t / hop);
    const back = Math.max(0, i - Math.round(PHRASE_DIP_WINDOW_SEC / hop));
    const refDb = localRef[Math.min(localRef.length - 1, i)];
    let dipDb = Infinity;
    let quiet = 0;
    let longestQuiet = 0;
    for (let k = back; k < i; k++) {
      const v = dbs[k];
      if (v == null) continue;
      dipDb = Math.min(dipDb, v);
      // How long the line stayed down, not just how far it dipped: the brief gap between two notes
      // of the same phrase is as deep as a breath but nothing like as long.
      quiet = v <= localRef[k] - PHRASE_DIP_DB ? quiet + hop : 0;
      longestQuiet = Math.max(longestQuiet, quiet);
    }
    if (!isFinite(dipDb)) return 0;
    const dip = Math.max(0, refDb - dipDb);
    const rise = Math.min(2, (onsetStrength.get(t) || 0) / strengthRef);
    // Deliberately not gated to zero below the acceptance bar: continuous playing that never
    // produces a convincing phrase end still has to be cut somewhere when a piece runs past maxLen,
    // and the least-bad boundary available beats the quietest frame near an arbitrary target.
    return dip / PHRASE_DIP_DB + rise + longestQuiet / PHRASE_DIP_MIN_SEC;
  };

  // 3. Cut each run at the boundaries that score well enough, then force a split in anything still
  // over maxLen so nothing comes out unusable.
  const bounds = [];
  for (const [a, b] of runs) {
    const runStartT = times[a];
    const runEndT = b < times.length ? times[b] : duration;
    if (runEndT - runStartT < p.minLen * 1.5) {
      bounds.push([runStartT, runEndT]);
      continue;
    }
    const spacing = Math.max(p.minLen, PHRASE_MIN_SPACING_SEC);
    const inRun = onsets.filter((t) => t > runStartT + spacing && t < runEndT - spacing);
    const scored = inRun
      .map((t) => ({ t, score: boundaryScore(t) }))
      .filter((c) => c.score >= PHRASE_BOUNDARY_SCORE)
      .sort((x, y) => y.score - x.score);

    // Best first, so where two candidates are too close together the more convincing one wins.
    const cuts = [];
    for (const c of scored) {
      if (cuts.every((t) => Math.abs(t - c.t) >= spacing)) cuts.push(c.t);
    }
    cuts.sort((x, y) => x - y);

    // Anything still too long gets the best boundary available inside it, scoring or not: a
    // deliberate long-tone passage has no phrase end to find, but it still has to be cut somewhere,
    // and `preferred` decides roughly where.
    const pieces = [runStartT, ...cuts, runEndT];
    for (let i = 0; i < pieces.length - 1; ) {
      const len = pieces[i + 1] - pieces[i];
      if (len <= p.maxLen) {
        i++;
        continue;
      }
      const target = pieces[i] + Math.min(p.preferred, len / 2);
      const lo = pieces[i] + p.minLen;
      const hi = pieces[i + 1] - p.minLen;
      const candidates = onsets.filter((t) => t >= lo && t <= hi);
      const cut = candidates.length
        ? candidates.reduce((best, t) => {
            const s = boundaryScore(t) - Math.abs(t - target) / p.maxLen;
            return s > (best.s ?? -Infinity) ? { t, s } : best;
          }, {}).t
        : lowestEnergyTime(times, vals, lo, hi, target);
      pieces.splice(i + 1, 0, cut);
    }
    for (let i = 0; i < pieces.length - 1; i++) bounds.push([pieces[i], pieces[i + 1]]);
  }

  // 4. Trim to the playing: each phrase starts a hair before its first attack (never clipping it)
  // and ends where the sound actually stops, plus the padding the caller asked for. Pieces too
  // short to stand alone join the neighbour they came from rather than being thrown away - losing
  // audio is what forces the hand-editing this is supposed to save.
  // A 1ms peak envelope, for putting a start on the sample the note actually begins at. The onset
  // curve above is quantised to its 10ms hop and timestamped at its window's start, so a boundary
  // taken straight from it can sit over a hundred milliseconds before the attack - inside the
  // breath, not on the note.
  const attackHop = Math.max(1, Math.round(sampleRate * 0.001));
  const attackEnv = new Float32Array(Math.floor(mono.length / attackHop));
  for (let f = 0; f < attackEnv.length; f++) {
    let m = 0;
    for (let i = f * attackHop, end = i + attackHop; i < end; i++) {
      const v = mono[i] < 0 ? -mono[i] : mono[i];
      if (v > m) m = v;
    }
    attackEnv[f] = m;
  }

  /** The sample-accurate start of the attack nearest `t`, or null if nothing there looks like one. */
  const attackNear = (t) => {
    const frameSec = attackHop / sampleRate;
    const centre = Math.round(t / frameSec);
    const span = Math.round(PHRASE_ATTACK_SEARCH_SEC / frameSec);
    const from = Math.max(10, centre - span);
    const to = Math.min(attackEnv.length - 4, centre + span);
    if (to <= from) return null;
    let bestJump = 0;
    let bestF = -1;
    for (let f = from; f <= to; f++) {
      let pre = 1e-6;
      for (let k = f - 10; k < f; k++) if (attackEnv[k] > pre) pre = attackEnv[k];
      const post = Math.max(attackEnv[f], attackEnv[f + 1], attackEnv[f + 2], attackEnv[f + 3]);
      const jump = post / pre;
      // Nearer counts for something: two equally clear attacks either side, take the closer one.
      const scored = jump / (1 + Math.abs(f - centre) * frameSec);
      // A modest bar: on legato playing one note rises out of the last one's decay, so the jump at
      // a real note start can be well under the 4x a percussive attack gives.
      if (jump >= 1.8 && scored > bestJump) {
        bestJump = scored;
        bestF = f;
      }
    }
    return bestF < 0 ? null : bestF * frameSec;
  };

  const regions = [];
  for (const [s0, e0] of bounds) {
    const attack = attackNear(s0);
    let s = attack != null ? attack - PHRASE_PREROLL_SEC : s0 - p.pad;
    let lastLoud = Math.round(e0 / hop);
    while (lastLoud > Math.round(s0 / hop) && (dbs[lastLoud] == null || dbs[lastLoud] < thresholdDb)) lastLoud--;
    const e = Math.min(duration, times[lastLoud] != null ? times[lastLoud] + hop + p.pad : e0);
    const start = Math.max(0, s);
    if (e - start <= 0) continue;
    const prev = regions[regions.length - 1];
    if (e - start < p.minLen && prev && start - prev[1] < p.minLen) prev[1] = e;
    else regions.push([start, e]);
  }

  return { regions, noiseFloorDb, thresholdDb };
}

// ---------------------------------------------------------------------------
// Drum / onset analysis
// ---------------------------------------------------------------------------

function percentile(vals, p) {
  if (!vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((s.length - 1) * p));
  return s[idx];
}

/** Positive-going jumps in log energy, used as an onset-strength curve. */
export function onsetStrengthCurve(vals) {
  const logs = vals.map((v) => Math.log10(v + 1.0));
  const diffs = [0];
  for (let i = 1; i < logs.length; i++) {
    diffs.push(Math.max(0, logs[i] - logs[i - 1]));
  }
  return diffs;
}

/** Pick local-maxima onsets above an adaptive threshold, debounced by minSpacing. */
export function pickOnsets(times, diffs, sensitivity = 0.65, minSpacing = 0.12) {
  const threshold = Math.max(0.025, percentile(diffs, 0.82) * sensitivity);
  const onsets = [];
  let last = -999;
  for (let i = 1; i < diffs.length - 1; i++) {
    if (diffs[i] >= threshold && diffs[i] >= diffs[i - 1] && diffs[i] >= diffs[i + 1]) {
      const t = times[i];
      if (t - last >= minSpacing) {
        onsets.push(t);
        last = t;
      }
    }
  }
  return onsets;
}

/**
 * Multi-band onset-strength curve: splits the signal into low/mid/high bands (same ~150Hz/2000Hz
 * crossovers as bandEnergies below), computes a short-time RMS envelope and log-energy-jump onset
 * curve per band, then sums them after normalizing each band's curve by its own typical jump size
 * (its 82nd-percentile value, same statistic pickOnsets uses for its threshold). A single
 * full-spectrum curve tends to under-react to a hit whose energy is concentrated in one band - a
 * sub-heavy kick, a hats-only shaker - because its jump in *total* energy is smaller than a
 * broadband snare's, even though the hit is just as clear-cut within its own band. The
 * full-spectrum curve is folded in too (also normalized the same way) so broadband hits aren't
 * diluted relative to narrowband ones. Pass an already-computed `fullEnvelope` ({times, vals} from
 * computeRmsEnvelope with the same winMs/hopMs) to skip recomputing it.
 */
export function multiBandOnsetStrengthCurve(mono, sampleRate, winMs = 20, hopMs = 10, fullEnvelope = null) {
  const low = onePoleLowpass(mono, 150, sampleRate);
  const aboveLow = onePoleHighpass(mono, 150, sampleRate);
  const mid = onePoleLowpass(aboveLow, 2000, sampleRate);
  const high = onePoleHighpass(aboveLow, 2000, sampleRate);

  const { times, vals: fullVals } = fullEnvelope || computeRmsEnvelope(mono, sampleRate, winMs, hopMs);
  const bandVals = [low, mid, high].map((signal) => computeRmsEnvelope(signal, sampleRate, winMs, hopMs).vals);
  const bandCurves = [...bandVals, fullVals].map((vals) => onsetStrengthCurve(vals));

  const combined = new Array(times.length).fill(0);
  for (const diffs of bandCurves) {
    const norm = Math.max(1e-6, percentile(diffs, 0.82));
    for (let i = 0; i < combined.length; i++) {
      combined[i] += (diffs[i] || 0) / norm;
    }
  }
  return { times, diffs: combined };
}

/**
 * How far either side of a predicted bar line to look for that bar's attack. A sixteenth is
 * wide enough to find the downbeat when the coarse anchor is a few milliseconds out, and
 * narrow enough that it can never grab the hit on a neighbouring subdivision instead.
 */
const GRID_REFINE_SEARCH_DIV = 16;

/** Largest shift refineGridStart will apply. Beyond a 32nd this stops being editing slop and starts being a different beat. */
const GRID_REFINE_MAX_SHIFT_DIV = 32;

/** Bars that must contribute a usable attack before the refinement is trusted at all. */
const GRID_REFINE_MIN_VOTES = 4;

/**
 * Pull a coarse bar-grid start onto the sample where the downbeat attack actually begins.
 *
 * Every tempo-locked chop boundary is measured from this one number, and being late with it
 * is far worse than it sounds. `drumRegions` derives it from the first detected onset, which
 * comes off a 10ms-hop RMS envelope: quantised to 10ms before anything else goes wrong, and
 * timestamped at its window's start so it lags the attack that produced it. On a real file
 * that lands the grid 10-15ms late - past the peak of the downbeat kick. Every chop then
 * opens mid-kick with its transient sliced off and closes with the first few milliseconds of
 * the NEXT kick glued to its tail, so looping it flams on every cycle even though the chop is
 * an exact whole number of bars long.
 *
 * Fixing it needs more than a better reading of the first onset: the first hit in a file is
 * routinely a few milliseconds later than the rest (a fade-in on the bounce, a softer opening
 * hit), so anchoring on it alone just moves the error around. Instead every bar votes. At each
 * bar line predicted from the coarse anchor, the loudest sample nearby is found and walked
 * back to where its attack begins; the offsets from bars that carry a clean transient are
 * pooled, and a low percentile of them becomes the correction.
 *
 * A LOW percentile, not the median, and that asymmetry is the point. Cutting a hair early
 * costs a millisecond or two of the previous bar's tail, which on a downbeat is decaying or
 * silent and is inaudible. Cutting late destroys a transient. When the two errors are this
 * lopsided, aim early.
 *
 * The whole correction is bounded to a 32nd note and needs several agreeing bars, so on
 * material with no clear downbeat - or where the loudest thing near the line is a syncopated
 * hit rather than the beat - it declines to move and the caller keeps its coarse anchor.
 * Returns the refined grid start in seconds.
 */
export function refineGridStart(mono, sampleRate, bpm, coarseGridStart, beatsPerBar = 4) {
  if (!(bpm > 0) || !mono || !mono.length || !(sampleRate > 0)) return coarseGridStart;
  const barSamples = beatsPerBar * (60 / bpm) * sampleRate;
  if (!(barSamples >= 32)) return coarseGridStart;

  const search = Math.round(barSamples / GRID_REFINE_SEARCH_DIV);
  const preWindow = Math.max(1, Math.round(0.003 * sampleRate));
  const anchor = coarseGridStart * sampleRate;
  const offsets = [];

  for (let line = anchor; line + search < mono.length; line += barSamples) {
    const c = Math.round(line);
    const lo = Math.max(0, c - search);
    const hi = Math.min(mono.length, c + search);
    if (hi - lo < 8) continue;

    let peak = 0;
    let peakIdx = -1;
    for (let i = lo; i < hi; i++) {
      const v = Math.abs(mono[i]);
      if (v > peak) {
        peak = v;
        peakIdx = i;
      }
    }
    if (peakIdx < 0 || peak < 1e-4) continue;

    // Back from the peak to the first sample of the attack that produced it.
    const floor = peak * 0.08;
    let s = peakIdx;
    while (s > lo && Math.abs(mono[s]) > floor) s--;
    if (s <= lo) continue; // attack starts outside the window - this is sustain, not a hit

    // Only a genuine transient votes: it has to rise out of something quieter than itself.
    let pre = 0;
    for (let i = Math.max(0, s - preWindow); i < s; i++) {
      const v = Math.abs(mono[i]);
      if (v > pre) pre = v;
    }
    if (pre > peak * 0.25) continue;

    offsets.push(s - c);
  }

  if (offsets.length < GRID_REFINE_MIN_VOTES) return coarseGridStart;
  offsets.sort((a, b) => a - b);
  const shift = offsets[Math.floor(offsets.length * 0.25)];
  const maxShift = barSamples / GRID_REFINE_MAX_SHIFT_DIV;
  if (Math.abs(shift) > maxShift) return coarseGridStart;
  return Math.max(0, (anchor + shift) / sampleRate);
}

/** How far either side of the estimated tempo fitBeatGrid searches. Estimators miss by hundredths of a BPM, not by percent. */
const GRID_FIT_TEMPO_RANGE = 0.01;

/** Largest per-file phase correction fitBeatGrid applies from attack voting, in seconds. */
const GRID_FIT_MAX_ATTACK_SHIFT = 0.02;

/**
 * Coherence of the onset curve with a pulse train of period `period`, plus that pulse train's
 * phase. Each onset frame is a unit phasor at its position within the period, weighted by its
 * strength; if the attacks really repeat at this period the phasors line up and the sum is long,
 * and its angle IS the grid phase - no separate phase search needed.
 */
function periodicPhasor(frames, period) {
  let re = 0;
  let im = 0;
  let total = 0;
  const w = (2 * Math.PI) / period;
  for (const [t, v] of frames) {
    re += v * Math.cos(w * t);
    im += v * Math.sin(w * t);
    total += v;
  }
  const phase = ((Math.atan2(im, re) / w) % period + period) % period;
  return { coherence: total > 0 ? Math.hypot(re, im) / total : 0, phase };
}

/**
 * Fit the file's real beat grid: exact tempo, sample-accurate phase, and which beat is beat 1.
 *
 * Why this exists: a tempo estimator's answer is close, not exact. Essentia's Percival estimator
 * reports a straight 123.00 BPM break as 123.047 - a 0.04% error nobody would notice in a label,
 * but every chop boundary in the file is that number multiplied out from one anchor, so the error
 * accumulates: 28ms early by the 70-second mark, which is a bar line visibly sitting in front of
 * the kick it is supposed to cut on. Snapping to a grid only helps if the grid is right.
 *
 * Three stages, each answering the question the one before it is bad at:
 *
 *   1. Tempo + coarse phase. Every onset in the file votes (see periodicPhasor) across a narrow
 *      band of tempi around the estimate, coarse then fine. The whole file is the measurement,
 *      so a hundredth of a BPM is resolvable on anything longer than a few bars.
 *   2. Sample-accurate phase. The onset curve is an energy envelope with its own timestamp bias,
 *      so the phase from stage 1 is a few milliseconds out. Each predicted beat line then looks
 *      for the frame where the level jumps hardest on a 1ms peak envelope - not a walk back from
 *      the loudest sample, which on a kick finds a zero crossing of the kick's own low-frequency
 *      cycle - and a low percentile of those offsets becomes the correction (aim early: see
 *      refineGridStart for why cutting a hair early is the cheap error).
 *   3. Downbeat. Stages 1-2 know where the beats are, not which one is "1". Low-band (kick) vs
 *      high-band (snare/hat) accent per beat position picks it, but only when that evidence is
 *      clear; otherwise the beat nearest the first attack in the file stays beat 1, which is what
 *      the chopper always assumed.
 *
 * Returns {bpm, downbeat, confidence} - downbeat is the time of the first bar line at or after
 * 0 - or null when the material has no rhythmic evidence to fit (the caller keeps its old path).
 */
export function fitBeatGrid(mono, sampleRate, bpm, { beatsPerBar = 4 } = {}) {
  if (!(bpm > 0) || !mono || !(sampleRate > 0)) return null;
  const duration = mono.length / sampleRate;
  const estBeat = 60 / bpm;
  if (duration < estBeat * beatsPerBar * 2) return null;

  // --- 1. tempo and coarse phase --------------------------------------------------------
  const hopMs = 5;
  const { times, diffs } = multiBandOnsetStrengthCurve(mono, sampleRate, 10, hopMs);
  const frames = [];
  for (let i = 0; i < diffs.length; i++) if (diffs[i] > 0) frames.push([times[i], diffs[i]]);
  if (frames.length < 8) return null;

  // Scored on the eighth-note grid: kick, snare and hats all land on it, so far more of the
  // file votes than on the beat alone. Step sizes are set by how much drift they allow across
  // the file - ~25ms per coarse step (well inside the coherence of an 8th), ~1ms per fine step.
  let best = { coherence: -1, beat: estBeat, phase: 0 };
  const scan = (from, to, step) => {
    for (let rel = from; rel <= to + 1e-12; rel += step) {
      const beat = estBeat * (1 + rel);
      const r = periodicPhasor(frames, beat / 2);
      if (r.coherence > best.coherence) best = { coherence: r.coherence, beat, phase: r.phase, rel };
    }
  };
  const coarseStep = Math.min(0.002, 0.025 / duration);
  scan(-GRID_FIT_TEMPO_RANGE, GRID_FIT_TEMPO_RANGE, coarseStep);
  const fineStep = Math.min(coarseStep / 4, 0.001 / duration);
  scan(best.rel - coarseStep, best.rel + coarseStep, fineStep);
  // Weak coherence means no steady pulse to fit (a pad, a fill-only file, free time).
  if (best.coherence < 0.15) return null;

  // The eighth-note phase is either on the beat or on the "and". Whichever has more attack
  // energy at the beat period is the beat.
  const coarseBeat = best.beat;
  const beatPhasor = periodicPhasor(frames, coarseBeat);
  const onBeat = [best.phase, best.phase + coarseBeat / 2].reduce((a, b) => {
    const da = Math.abs(((a - beatPhasor.phase) % coarseBeat + coarseBeat * 1.5) % coarseBeat - coarseBeat / 2);
    const db = Math.abs(((b - beatPhasor.phase) % coarseBeat + coarseBeat * 1.5) % coarseBeat - coarseBeat / 2);
    return da <= db ? a : b;
  }) % coarseBeat;

  // --- 2. exact tempo and sample-accurate phase ------------------------------------------
  // Stage 1's answer is pulled around by everything that isn't a clean attack - ghost notes,
  // a late 16th, reverb - so it can still be a few hundredths of a BPM out, which is tens of
  // milliseconds by the end of a long file. So measure the attacks themselves: at each
  // predicted beat line, find the frame where the level jumps hardest on a 1ms peak envelope
  // (not a walk back from the loudest sample, which on a kick finds a zero crossing of the
  // kick's own low-frequency cycle), then fit a straight line through those attack times.
  // Slope is the tempo, intercept the phase. Done twice, the second pass searching a much
  // narrower window around the corrected grid.
  const envHop = Math.max(1, Math.round(sampleRate * 0.001));
  const env = new Float32Array(Math.floor(mono.length / envHop));
  let envPeak = 0;
  for (let f = 0; f < env.length; f++) {
    let m = 0;
    for (let i = f * envHop, end = i + envHop; i < end; i++) {
      const v = mono[i] < 0 ? -mono[i] : mono[i];
      if (v > m) m = v;
    }
    env[f] = m;
    if (m > envPeak) envPeak = m;
  }
  const frameSec = envHop / sampleRate;
  const preF = 10;
  const findAttacks = (beatSec, phaseSec, searchSec, minLevel = 0.1) => {
    const searchF = Math.max(2, Math.round(searchSec / frameSec));
    const found = [];
    for (let k = 0; phaseSec + k * beatSec < duration; k++) {
      const c = Math.round((phaseSec + k * beatSec) / frameSec);
      if (c - searchF - preF < 0 || c + searchF + 3 >= env.length) continue;
      let bestJump = 0;
      let bestF = -1;
      let bestLevel = 0;
      for (let f = c - searchF; f <= c + searchF; f++) {
        let pre = 1e-6;
        for (let j = f - preF; j < f; j++) if (env[j] > pre) pre = env[j];
        const post = Math.max(env[f], env[f + 1], env[f + 2]);
        if (post / pre > bestJump) {
          bestJump = post / pre;
          bestF = f;
          bestLevel = post;
        }
      }
      // ~12dB rise out of what came before, and loud enough to be a hit rather than bleed.
      if (bestF >= 0 && bestJump >= 4 && bestLevel >= envPeak * minLevel) found.push([k, bestF * frameSec]);
    }
    return found;
  };
  const fitLine = (pts) => {
    const n = pts.length;
    let sk = 0, st = 0, skk = 0, skt = 0;
    for (const [k, t] of pts) {
      sk += k;
      st += t;
      skk += k * k;
      skt += k * t;
    }
    const den = n * skk - sk * sk;
    if (!(den > 0)) return null;
    const slope = (n * skt - sk * st) / den;
    return { slope, intercept: (st - slope * sk) / n };
  };

  let beat = best.beat;
  let phase = onBeat;
  for (const searchSec of [0.04, 0.015]) {
    let pts = findAttacks(beat, phase, Math.min(searchSec, beat / 6));
    if (pts.length < 8) break;
    let line = fitLine(pts);
    if (!line) break;
    // Trim what doesn't sit on the line (a flam, a fill hit, a ghost note grabbed instead of the
    // beat) and fit again from the attacks that agree.
    pts = pts.filter(([k, t]) => Math.abs(t - (line.intercept + line.slope * k)) <= 0.008);
    if (pts.length < 8) break;
    line = fitLine(pts) || line;
    if (Math.abs(line.slope / estBeat - 1) > GRID_FIT_TEMPO_RANGE * 1.5) break;
    beat = line.slope;
    phase = line.intercept;
  }

  // Pin the phase to the hits that matter. The line runs through every attack, but a quiet hat
  // or ghost note tends to speak a few milliseconds ahead of the kick and snare, and a cut
  // placed by that average visibly leads the downbeat it's meant to sit on. So only the loud
  // hits decide the final offset - and a low percentile of theirs, aiming early: cutting a hair
  // before an attack is inaudible where cutting a hair after one isn't (see refineGridStart).
  let residuals = findAttacks(beat, phase, Math.min(0.015, beat / 6), 0.35);
  if (residuals.length < 8) residuals = findAttacks(beat, phase, Math.min(0.015, beat / 6));
  residuals = residuals
    .map(([k, t]) => t - (phase + k * beat))
    .sort((a, b) => a - b);
  if (residuals.length >= 4) {
    const shift = residuals[Math.floor(residuals.length * 0.25)];
    if (Math.abs(shift) <= GRID_FIT_MAX_ATTACK_SHIFT) phase += shift;
  }
  phase = ((phase % beat) + beat) % beat;
  // --- 3. which beat is beat 1 -----------------------------------------------------------
  const low = onePoleLowpass(onePoleLowpass(mono, 150, sampleRate), 150, sampleRate);
  const high = onePoleHighpass(mono, 2000, sampleRate);
  const lowCurve = onsetStrengthCurve(computeRmsEnvelope(low, sampleRate, 10, hopMs).vals);
  const highCurve = onsetStrengthCurve(computeRmsEnvelope(high, sampleRate, 10, hopMs).vals);
  const L = new Array(beatsPerBar).fill(0);
  const H = new Array(beatsPerBar).fill(0);
  const hopSec = hopMs / 1000;
  const firstOnsets = pickOnsets(times, diffs, 0.65, 0.12);
  const firstOnsetT = firstOnsets.length ? firstOnsets[0] : frames[0][0];
  // Beat index 0 is the beat nearest the first real attack in the file: the old anchor.
  const k0 = Math.round((firstOnsetT - phase) / beat);
  for (let k = 0; phase + k * beat < duration; k++) {
    // Envelope frames are stamped at their window's start, so the energy jump for an attack at
    // t shows up a window earlier; look across that whole span.
    const centre = Math.round((phase + k * beat) / hopSec);
    let l = 0;
    let h = 0;
    for (let i = centre - 3; i <= centre + 1; i++) {
      if (lowCurve[i] > l) l = lowCurve[i];
      if (highCurve[i] > h) h = highCurve[i];
    }
    const cls = (((k - k0) % beatsPerBar) + beatsPerBar) % beatsPerBar;
    L[cls] += l;
    H[cls] += h;
  }
  const sumL = L.reduce((a, b) => a + b, 0) || 1;
  const sumH = H.reduce((a, b) => a + b, 0) || 1;
  const kick = L.map((v, i) => v / sumL - H[i] / sumH);
  let downCls = 0;
  if (beatsPerBar === 4) {
    // Kick-on-1-and-3 against snare-on-2-and-4 decides the parity; a margin keeps a flat,
    // hats-everywhere pattern from flipping the bar on noise.
    // On a tie the earlier kick wins - the first one in the file, not one a bar later.
    if (kick[1] + kick[3] - (kick[0] + kick[2]) > 0.2) downCls = kick[3] > kick[1] + 0.15 ? 3 : 1;
    // Then 1 against 3, which only a clearly heavier kick can settle.
    const other = (downCls + 2) % 4;
    if (kick[other] - kick[downCls] > 0.15) downCls = other;
  } else {
    const strongest = kick.indexOf(Math.max(...kick));
    if (kick[strongest] - kick[0] > 0.15) downCls = strongest;
  }

  const bar = beat * beatsPerBar;
  const anchor = phase + (k0 + downCls) * beat;
  const downbeat = anchor - Math.floor(anchor / bar + 1e-9) * bar;
  return { bpm: 60 / beat, downbeat: Math.max(0, downbeat), confidence: best.coherence };
}

/**
 * Snap a candidate cut time to the nearest grid line for a given tempo, so that resulting
 * chop lengths are exact whole numbers of beats - or, when `step` says so, of bars - and loop
 * cleanly. gridStart is the time of beat 1 (see refineGridStart for why that has to be
 * sample-accurate, not merely close). Returns the original time unmodified if it's further
 * than `tolerance` seconds from any grid line.
 *
 * `step` defaults to one beat. Passing a bar is what keeps a chop a whole number of BARS: a
 * beat-snapped boundary can be a whole number of beats from the last one and still land on
 * beat 3, which loops as audio but not as music.
 */
export function snapToBeatGrid(t, bpm, gridStart, tolerance, step = null) {
  if (!bpm || bpm <= 0) return t;
  const period = step && step > 0 ? step : 60 / bpm;
  const n = Math.round((t - gridStart) / period);
  const grid = gridStart + n * period;
  return Math.abs(grid - t) <= tolerance ? grid : t;
}

/**
 * Break-sized drum phrase detection. Walks the file in ~preferred-length
 * chunks, choosing each boundary from a nearby detected onset (falling back
 * to the lowest-energy point), then - when a confident tempo is supplied -
 * snapping that boundary onto the tempo grid so the chop is loop-ready.
 *
 * When `p.preferred` is a whole number of bars (which is what computeDrumRegions hands over
 * whenever the tempo is confident), the grid is the BAR grid rather than the beat grid, and
 * every boundary - the first one included - sits on it. Three separate things have to hold
 * before a chop actually loops, and snapping alone only buys the first:
 *
 *   1. Every chop is an exact whole number of bars. Beat snapping is not enough: a boundary
 *      can be a whole number of beats from the last one and still land on beat 3.
 *   2. The FIRST boundary is on the grid too. Starting the walk at t=0 regardless, as this
 *      used to, made chop 1 the one chop in the file guaranteed not to loop - it ran from 0
 *      to the first grid line plus N bars, so its length was N bars plus the grid phase.
 *   3. The grid's phase and tempo are accurate to the sample, not to the 10ms envelope hop the
 *      onsets come off or to the tempo estimator's rounding. See fitBeatGrid - a grid a few
 *      hundredths of a BPM out walks off the downbeat over the length of a file.
 *
 * `grid` is a precomputed fitBeatGrid() result (callers that also draw the grid pass the same
 * one, so the drawn lines and the cuts can't disagree); pass null to skip fitting and fall back
 * to anchoring on the first onset. `p.anchorAtStart` treats t=0 as bar 1 instead of detecting
 * the downbeat - for files already trimmed to the bar in a DAW. Returns the tempo actually used
 * as `bpm`.
 */
export function drumRegions(mono, sampleRate, p, bpm = null, grid = undefined) {
  const duration = mono.length / sampleRate;
  const { times, vals } = computeRmsEnvelope(mono, sampleRate, 20, 10);
  if (!vals.length) return { regions: [[0, duration]], onsets: [] };

  const { diffs } = multiBandOnsetStrengthCurve(mono, sampleRate, 20, 10, { times, vals });
  const onsets = pickOnsets(times, diffs, p.onsetSensitivity, 0.12);
  const beatsPerBar = p.beatsPerBar || 4;
  const fit = bpm ? (grid === undefined ? fitBeatGrid(mono, sampleRate, bpm, { beatsPerBar }) : grid) : null;
  if (fit) {
    // Lengths the caller derived from the estimated tempo scale with it, so "4 bars" stays
    // exactly 4 bars at the tempo the grid actually runs at.
    const scale = bpm / fit.bpm;
    p = { ...p, preferred: p.preferred * scale, minLen: p.minLen * scale, maxLen: p.maxLen * scale };
    bpm = fit.bpm;
  }
  const barSec = bpm ? beatsPerBar * (60 / bpm) : 0;

  // A whole-bar preferred length means the caller is chopping in bars, so the grid to snap to
  // - and to step the tail along - is the bar, not the beat.
  const barsPerChop = barSec ? p.preferred / barSec : 0;
  const wholeBars = barsPerChop >= 1 && Math.abs(barsPerChop - Math.round(barsPerChop)) < 1e-6;
  const snapStep = wholeBars ? barSec : null;
  const chopStep = wholeBars ? Math.round(barsPerChop) * barSec : 0;

  let gridStart = 0;
  if (bpm && p.anchorAtStart) gridStart = 0;
  else if (fit) gridStart = fit.downbeat;
  else if (bpm && onsets.length) gridStart = refineGridStart(mono, sampleRate, bpm, onsets[0], beatsPerBar);
  const tolerance = bpm ? (snapStep || 60 / bpm) * 0.5 : 0;

  // The earliest grid line at or after the start of the file, so chop 1 is a whole number of
  // bars like every other chop. Anything before it is a partial bar that could never loop.
  const first = chopStep ? gridStart - Math.floor(gridStart / chopStep) * chopStep : 0;
  const bounds = [first];
  let cur = first;
  while (duration - cur > p.maxLen) {
    const target = cur + p.preferred;
    const lo = Math.max(cur + p.minLen, target - 2.5);
    const hi = Math.min(cur + p.maxLen, target + 2.5);

    const nearby = onsets.filter((t) => t >= lo && t <= hi);
    let cut;
    if (nearby.length) {
      cut = nearby.reduce((a, b) => (Math.abs(a - target) <= Math.abs(b - target) ? a : b));
    } else {
      cut = lowestEnergyTime(times, vals, lo, hi, target);
    }

    if (bpm) {
      const snapped = snapToBeatGrid(cut, bpm, gridStart, tolerance, snapStep);
      if (snapped >= lo - tolerance && snapped <= hi + tolerance && snapped - cur >= p.minLen) {
        cut = snapped;
      }
    }

    if (cut - cur < p.minLen) cut = Math.min(cur + p.preferred, duration);
    bounds.push(cut);
    cur = cut;
  }

  if (chopStep) {
    // Keep laying down whole-bar chops while a full one still fits. Without this the walk's
    // "stop once the remainder is under maxLen" rule hands the entire tail to the last chop,
    // which at the default maxLen of 1.5x makes it a 12-bar chop where 8 + a remainder was
    // asked for. Whatever is genuinely left over then becomes its own final region: it is the
    // tail of the file and was never going to be a loop, but dropping it would lose audio.
    while (duration - cur >= chopStep) {
      cur += chopStep;
      bounds.push(cur);
    }
    if (duration - cur > 1e-6) bounds.push(duration);
  } else if (duration - bounds[bounds.length - 1] < p.minLen && bounds.length > 1) {
    bounds[bounds.length - 1] = duration;
  } else {
    bounds.push(duration);
  }

  const regions = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i];
    const b = bounds[i + 1];
    if (b - a >= 0.5) regions.push([Math.max(0, a), Math.min(duration, b)]);
  }
  return { regions, onsets, gridStart, bpm };
}

/**
 * drumRegions() for everything from `startSec` on, with `startSec` as bar 1 - the "re-chop from
 * the selected chop" action. The point of it is carving out an intro: a count-in or opening fill
 * that isn't in the groove throws off both the tempo fit and the downbeat pick when the whole file
 * is analysed, so here only the audio from the chosen point is fitted, and the chosen point is
 * trusted as the downbeat rather than detected.
 *
 * A hand-placed mark is rarely sample-exact, so it's snapped onto the fitted beat line when one is
 * within `snapSec` (default: 50ms, or a tenth of a beat on faster material) - close enough that it
 * must be the beat the user meant, and under half a sixteenth, so a start deliberately on an
 * off-beat 16th is left where it is. The fit looks from a little before the mark so a mark placed just
 * AFTER the attack can still be pulled back onto it.
 *
 * Returns {regions, anchor, bpm}: the new regions (all at or after `anchor`), where bar 1 actually
 * landed after snapping, and the tempo used.
 */
export function drumRegionsFrom(mono, sampleRate, p, bpm, startSec, { snapSec = null } = {}) {
  const duration = mono.length / sampleRate;
  let anchor = Math.max(0, Math.min(duration, startSec));
  let grid = null;
  if (bpm > 0) {
    if (snapSec == null) snapSec = Math.min(0.05, 60 / bpm / 10);
    const leadSamples = Math.round(Math.min(anchor, snapSec * 2) * sampleRate);
    const fromSample = Math.round(anchor * sampleRate) - leadSamples;
    grid = fitBeatGrid(mono.subarray(fromSample), sampleRate, bpm, { beatsPerBar: p.beatsPerBar || 4 });
    if (grid) {
      const beat = 60 / grid.bpm;
      const mark = anchor - fromSample / sampleRate;
      const phase = grid.downbeat % beat;
      const line = phase + Math.round((mark - phase) / beat) * beat;
      if (line >= 0 && Math.abs(line - mark) <= snapSec) anchor = fromSample / sampleRate + line;
    }
  }
  const anchorSample = Math.round(anchor * sampleRate);
  anchor = anchorSample / sampleRate;
  const sub = mono.subarray(anchorSample);
  if (sub.length < sampleRate * 0.5) return { regions: [], anchor, bpm: grid ? grid.bpm : bpm };
  const result = drumRegions(sub, sampleRate, { ...p, anchorAtStart: true }, bpm, grid ? { ...grid, downbeat: 0 } : null);
  return { regions: result.regions.map(([a, b]) => [a + anchor, b + anchor]), anchor, bpm: result.bpm };
}

// ---------------------------------------------------------------------------
// Click-free boundaries
// ---------------------------------------------------------------------------

/**
 * Search outward from `sampleIndex` (within +/- windowSamples) for the
 * nearest sample where the signal crosses zero, to avoid an audible click
 * at a hard cut. Falls back to the original index if no crossing is found.
 */
export function findNearestZeroCrossing(mono, sampleIndex, windowSamples) {
  const n = mono.length;
  const start = Math.max(1, sampleIndex - windowSamples);
  const end = Math.min(n - 1, sampleIndex + windowSamples);
  let best = sampleIndex;
  let bestDist = Infinity;
  for (let i = start; i <= end; i++) {
    const prev = mono[i - 1];
    const cur = mono[i];
    if ((prev <= 0 && cur >= 0) || (prev >= 0 && cur <= 0)) {
      const dist = Math.abs(i - sampleIndex);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
  }
  return best;
}

/** Apply a linear fade-in/out in place to a set of per-channel Float32Arrays. */
export function applyFades(channels, fadeInSamples, fadeOutSamples) {
  for (const ch of channels) {
    const n = ch.length;
    const fi = Math.min(fadeInSamples, Math.floor(n / 2));
    const fo = Math.min(fadeOutSamples, Math.floor(n / 2));
    for (let i = 0; i < fi; i++) ch[i] *= i / fi;
    for (let i = 0; i < fo; i++) ch[n - 1 - i] *= i / fo;
  }
}

// ---------------------------------------------------------------------------
// Resampling (analysis only - export always uses full-resolution audio)
// ---------------------------------------------------------------------------

/** Downmix any number of channels to mono by averaging. */
export function toMono(channels) {
  const n = channels[0].length;
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i];
    out[i] = sum / channels.length;
  }
  return out;
}

/** Simple linear-interpolation resampler, good enough for analysis use. */
export function resampleLinear(mono, fromRate, toRate) {
  if (fromRate === toRate) return mono;
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(mono.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(mono.length - 1, i0 + 1);
    const frac = srcPos - i0;
    out[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Waveform preview
// ---------------------------------------------------------------------------

/** Downsample mono audio to `binCount` peak (max-abs) values in [0,1], for drawing a waveform. */
export function computePeaks(mono, binCount) {
  return computePeaksInRange(mono, 0, mono.length, binCount);
}

/**
 * Same as computePeaks, but over an arbitrary [startSample, endSample) slice
 * of the array instead of the whole thing - used to redraw just the visible
 * window at full detail when the manual chop editor is zoomed in, without
 * having to hold a second high-resolution copy of the audio around.
 */
export function computePeaksInRange(mono, startSample, endSample, binCount) {
  const n = mono.length;
  const out = new Float32Array(binCount);
  if (n === 0 || binCount <= 0) return out;
  const s0 = Math.max(0, Math.min(n, Math.floor(startSample)));
  const s1 = Math.max(s0, Math.min(n, Math.ceil(endSample)));
  const span = s1 - s0;
  if (span <= 0) return out;
  const binSize = span / binCount;
  for (let b = 0; b < binCount; b++) {
    const start = s0 + Math.floor(b * binSize);
    const end = b === binCount - 1 ? s1 : Math.max(start + 1, s0 + Math.floor((b + 1) * binSize));
    let peak = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(mono[i]);
      if (v > peak) peak = v;
    }
    out[b] = peak;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

/**
 * Strip characters that are unsafe in a file/folder name on any common OS,
 * collapse whitespace, and (if maxLen is given) truncate - some hardware
 * samplers have fairly tight filename length limits.
 */
export function sanitizeForPath(str, maxLen) {
  let out = str.replace(/[\/\\:*?"<>|,[\]]/g, "-").replace(/\s+/g, " ").trim();
  if (maxLen && out.length > maxLen) out = truncateStem(out, maxLen);
  return out;
}

/** Truncate a name to maxLen characters, trimming any trailing separator left dangling by the cut. */
export function truncateStem(str, maxLen) {
  if (!maxLen || str.length <= maxLen) return str;
  return str.slice(0, maxLen).replace(/[\s_-]+$/, "");
}

/** Join non-empty name parts with a separator, dropping any empty ones. */
export function joinNameParts(parts, sep = " ") {
  return parts.filter((p) => p !== null && p !== undefined && p !== "").join(sep);
}

/**
 * Build a short, plain-text key/tempo tag from a detected key/tempo result,
 * e.g. "C#m 120bpm" (sep=" ") or "C#m_120bpm" (sep="_"), "C 118bpm", "Cm", or
 * "" if nothing was detected. Deliberately has no brackets, commas, or space
 * between the number and "bpm" - some hardware samplers choke on punctuation
 * or have narrow name-length budgets, so the plainest form is the default.
 * Since key/tempo are detected once per source recording (not per chop),
 * this tag is meant to be combined once with the source name (see
 * joinNameParts) rather than being rebuilt separately for every chop.
 */
export function buildKeyTempoTag({ key, scale, bpm } = {}, sep = " ") {
  const parts = [];
  if (key) parts.push(scale === "minor" ? `${key}m` : key);
  if (bpm) parts.push(`${Math.round(bpm)}bpm`);
  return joinNameParts(parts, sep);
}

// ---------------------------------------------------------------------------
// Tempo / bar-length helpers
// ---------------------------------------------------------------------------

/** Seconds spanned by `bars` bars of `beatsPerBar` beats at `bpm`. Returns null if bpm is unknown. */
export function barsToSeconds(bars, bpm, beatsPerBar = 4) {
  if (!bpm || bpm <= 0 || !bars || bars <= 0) return null;
  return bars * beatsPerBar * (60 / bpm);
}

// ---------------------------------------------------------------------------
// Manual re-chop helpers (editor-triggered re-chopping, see createEditableWaveform's
// consumer in app.js)
// ---------------------------------------------------------------------------

/**
 * Time of the first sample whose short-time RMS clears the file's own noise floor by `marginDb`,
 * i.e. where the audio actually starts. Used to align a re-chop's grid to the real content instead
 * of counting leading silence as part of the first slice. Returns 0 if nothing clears the floor
 * (silent file, or `marginDb` set higher than the loudest part of the file).
 */
export function findAudibleStart(mono, sampleRate, marginDb = 12) {
  const { times, vals } = computeRmsEnvelope(mono, sampleRate, 20, 10);
  if (!vals.length) return 0;
  const thresholdDb = estimateNoiseFloorDb(vals) + marginDb;
  for (let i = 0; i < vals.length; i++) {
    if (linToDb(vals[i]) >= thresholdDb) return times[i];
  }
  return 0;
}

/** `count` equal-length [start,end] regions spanning [rangeStart, rangeEnd]. Minimum 1 region. */
export function equalSliceRegions(rangeStart, rangeEnd, count) {
  const n = Math.max(1, Math.round(count));
  const span = Math.max(0, rangeEnd - rangeStart);
  const step = span / n;
  const regions = [];
  for (let i = 0; i < n; i++) {
    regions.push([rangeStart + i * step, i === n - 1 ? rangeEnd : rangeStart + (i + 1) * step]);
  }
  return regions;
}

// ---------------------------------------------------------------------------
// One-shot hit extraction (drums)
// ---------------------------------------------------------------------------
//
// Heuristic, not a trained classifier: a hit is bucketed into kick / snare /
// hat / cymbal / perc from three simple time-domain band-energy measurements
// (no FFT needed) plus its duration. It's good enough to sort a break's hits
// into sensible piles, not a substitute for listening to what you got.

/** One-pole low-pass filter (RC filter), used for cheap band-splitting without an FFT. */
function onePoleLowpass(x, cutoffHz, sampleRate) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const alpha = dt / (rc + dt);
  const y = new Float32Array(x.length);
  let prev = 0;
  for (let i = 0; i < x.length; i++) {
    prev = prev + alpha * (x[i] - prev);
    y[i] = prev;
  }
  return y;
}

/** Complementary one-pole high-pass (input minus its low-pass). */
function onePoleHighpass(x, cutoffHz, sampleRate) {
  const low = onePoleLowpass(x, cutoffHz, sampleRate);
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] - low[i];
  return y;
}

/** Peak absolute sample value of mono[startSample:endSample], used to rank hits within a dedupe cluster. */
export function peakAbs(mono, startSample, endSample) {
  const a = Math.max(0, startSample);
  const b = Math.min(mono.length, endSample);
  let peak = 0;
  for (let i = a; i < b; i++) {
    const v = Math.abs(mono[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

function rms(x, start, end) {
  const a = Math.max(0, start);
  const b = Math.min(x.length, end);
  if (b <= a) return 0;
  let sumSq = 0;
  for (let i = a; i < b; i++) sumSq += x[i] * x[i];
  return Math.sqrt(sumSq / (b - a));
}

/**
 * Rough low/mid/high RMS energy split of mono[startSample:endSample] using
 * two cascaded one-pole filters (~150Hz and ~2000Hz crossovers).
 */
export function bandEnergies(mono, sampleRate, startSample, endSample) {
  const a = Math.max(0, startSample);
  const b = Math.min(mono.length, endSample);
  if (b <= a) return { low: 0, mid: 0, high: 0 };
  const slice = mono.slice(a, b);
  const low = onePoleLowpass(slice, 150, sampleRate);
  const aboveLow = onePoleHighpass(slice, 150, sampleRate);
  const mid = onePoleLowpass(aboveLow, 2000, sampleRate);
  const high = onePoleHighpass(aboveLow, 2000, sampleRate);
  return { low: rms(low, 0, low.length), mid: rms(mid, 0, mid.length), high: rms(high, 0, high.length) };
}

/**
 * Bucket a hit into a rough drum-voice label from its band-energy balance
 * and duration. Heuristic thresholds tuned by ear, not measurement - treat
 * the labels as a starting sort, not ground truth.
 */
export function classifyHit({ low, mid, high, durationSec }) {
  const total = low + mid + high;
  if (total <= 1e-9) return "perc";
  const lowR = low / total;
  const midR = mid / total;
  const highR = high / total;

  if (lowR >= 0.5 && durationSec < 0.5) return "kick";
  if (highR >= 0.45) return durationSec < 0.18 ? "hat" : "cymbal";
  if (midR >= 0.32 || (lowR < 0.5 && highR < 0.45)) return "snare";
  return "perc";
}

/**
 * From a set of onset times, find candidate one-shot windows: each hit runs
 * from its onset (minus a small pre-roll) until the envelope decays back to
 * the noise floor, the next onset arrives, or maxHitSec is reached -
 * whichever comes first. Very short blips (below minHitSec) are dropped.
 */
export function findOneShotWindows(
  mono,
  sampleRate,
  onsets,
  { minHitSec = 0.05, maxHitSec = 1.2, preRollSec = 0.004, bleedSec = 0.09, decayDropDb = 26 } = {}
) {
  const { times, vals } = computeRmsEnvelope(mono, sampleRate, 15, 5);
  const duration = mono.length / sampleRate;

  const windows = [];
  for (let i = 0; i < onsets.length; i++) {
    const onset = onsets[i];
    const nextOnset = i + 1 < onsets.length ? onsets[i + 1] : duration;

    // The next onset is a soft limit, not a hard one. Cutting exactly there was the bug that made
    // extracted hits useless: in a busy break onsets are ~75ms apart, so every "one-shot" came out
    // as a 0.0s stub with its tail chopped off. A real hit is allowed to ring a little way into
    // whatever follows it, which is what a sampler would capture.
    const hardEnd = Math.min(duration, onset + maxHitSec);
    const softEnd = Math.min(hardEnd, nextOnset + bleedSec);

    // Decay is measured against THIS hit's own peak, not a whole-file noise floor. The global
    // floor is meaningless on a dense break (it sits at digital silence, so the test never fired
    // and the decay logic did nothing at all).
    let hitPeak = 0;
    for (let k = 0; k < times.length; k++) {
      if (times[k] < onset) continue;
      if (times[k] > softEnd) break;
      if (vals[k] > hitPeak) hitPeak = vals[k];
    }
    const decayThresholdDb = linToDb(hitPeak) - decayDropDb;

    let end = softEnd;
    for (let k = 0; k < times.length; k++) {
      if (times[k] <= onset + 0.01) continue; // let the transient itself through before testing decay
      if (times[k] >= softEnd) break;
      if (linToDb(vals[k]) <= decayThresholdDb) {
        end = times[k];
        break;
      }
    }

    const start = Math.max(0, onset - preRollSec);

    // minHitSec is a floor to grow to, not a reason to throw the hit away. A closed hat really is
    // only ~40ms of sound, and dropping it would lose a legitimate one-shot; padding it out to a
    // usable length costs nothing but a little silence at the tail.
    if (end - start < minHitSec) end = Math.min(hardEnd, duration, start + minHitSec);
    if (end - start > 0) windows.push([start, end]);
  }
  return windows;
}

/**
 * A hit's spectral shape as a short vector, for telling two hits apart.
 *
 * Five one-pole bands rather than the three used for labelling, log-scaled (loudness is
 * perceptually logarithmic, and a linear ratio is dominated by whichever band is loudest) and
 * mean-centred so the comparison is about spectral SHAPE rather than level - the same snare hit
 * softer should still read as the same snare.
 */
export function hitFingerprint(mono, sampleRate, startSample, endSample) {
  const a = Math.max(0, startSample);
  const b = Math.min(mono.length, endSample);
  if (b <= a) return [0, 0, 0, 0, 0];
  const slice = mono.slice(a, b);

  const b0 = onePoleLowpass(slice, 120, sampleRate);
  const above120 = onePoleHighpass(slice, 120, sampleRate);
  const b1 = onePoleLowpass(above120, 500, sampleRate);
  const above500 = onePoleHighpass(above120, 500, sampleRate);
  const b2 = onePoleLowpass(above500, 2000, sampleRate);
  const above2k = onePoleHighpass(above500, 2000, sampleRate);
  const b3 = onePoleLowpass(above2k, 6000, sampleRate);
  const b4 = onePoleHighpass(above2k, 6000, sampleRate);

  const raw = [b0, b1, b2, b3, b4].map((band) => Math.log10(rms(band, 0, band.length) + 1e-6));
  const mean = raw.reduce((s, v) => s + v, 0) / raw.length;
  const centred = raw.map((v) => v - mean);
  const norm = Math.hypot(...centred) || 1;
  return centred.map((v) => v / norm);
}

/**
 * Greedily dedupe hits that look like repeats of the same sound, keeping the loudest of each
 * cluster. Returns hits sorted by start time.
 *
 * Clustering is GLOBAL and on `hit.fingerprint`, not grouped by the kick/snare/hat label. Grouping
 * by label made the unreliable part of the pipeline load-bearing twice over: a mislabelled hit
 * could never match its own twin, while everything sharing a label got compared on three coarse
 * band ratios and collapsed together. On a real break that reduced 32 detected hits to 2. The
 * threshold here is a cosine distance between normalised log-band vectors, so it is much tighter
 * and much less willing to declare two different drums identical.
 */
export function dedupeHits(hits, { simThreshold = 0.06, maxKept = 24, minPeakRatio = 0.08 } = {}) {
  if (hits.length === 0) return [];

  // Ghost notes and bleed between hits are not samples anyone wants; drop anything far below the
  // loudest hit in the file.
  const loudest = hits.reduce((m, h) => Math.max(m, h.peak || 0), 0);
  const candidates = loudest > 0 ? hits.filter((h) => (h.peak || 0) >= loudest * minPeakRatio) : hits.slice();

  const clusters = [];
  for (const hit of candidates) {
    const vec = hit.fingerprint;
    let cluster = null;
    if (vec) {
      cluster = clusters.find((c) => {
        if (!c.vec) return false;
        // cosine distance; both vectors are already unit-length
        let dot = 0;
        for (let i = 0; i < vec.length; i++) dot += c.vec[i] * vec[i];
        return 1 - dot <= simThreshold;
      });
    }
    if (!cluster) {
      clusters.push({ vec, rep: hit });
    } else if ((hit.peak || 0) > (cluster.rep.peak || 0)) {
      cluster.rep = hit;
    }
  }

  return clusters
    .sort((a, b) => (b.rep.peak || 0) - (a.rep.peak || 0))
    .slice(0, maxKept)
    .map((c) => c.rep)
    .sort((a, b) => a.start - b.start);
}
