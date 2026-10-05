// sources.js
//
// Which bits of the break are worth destroying. This is where STRETCH FX's musicality lives: it
// never picks an arbitrary microscopic slice of waveform. Every candidate is anchored on something
// a producer would actually reach for - a detected hit, a likely snare (extra credit on the
// backbeat), or a grid-aligned 1/16, 1/8 or 1/4 with a bonus for the places fills live: the end of
// a bar, the last bar of the phrase, and the fragment that runs straight into a strong downbeat.
// Grid fragments that start within a hair of a real transient are pulled onto it, so a "1/8 on
// beat 3" starts with the drum hit on beat 3 rather than a few milliseconds of its pre-echo.
//
// Pure. Candidate POOLS are built once per analysis; PICKING is seeded and diversity-aware, so a
// bank of eight doesn't come back as eight stretches of the same snare.
import { gridPosition } from "./analysis.js";

export const SOURCE_TYPES = [
  { key: "auto", label: "Auto", hint: "A mixture of whatever this break does best." },
  { key: "snare", label: "Snare", hint: "Likely snare hits, with enough tail to give the stretch something to chew." },
  { key: "hit", label: "Hit", hint: "Any detected hit - kicks, hats, ghosts, crashes." },
  { key: "1/16", label: "1/16", hint: "Sixteenth-note fragments on the grid." },
  { key: "1/8", label: "1/8", hint: "Eighth-note fragments on the grid - favours bar ends." },
  { key: "1/4", label: "1/4", hint: "Quarter-note fragments on the grid - favours the beat before a downbeat." },
];
export const DEFAULT_SOURCE_TYPE = "auto";

export function resolveSourceType(key) {
  return SOURCE_TYPES.find((s) => s.key === key) || SOURCE_TYPES[0];
}

/** Grid source types and their length in beats. */
const GRID_UNITS = { "1/16": 0.25, "1/8": 0.5, "1/4": 1 };

/** How far before a transient a fragment starts, so the attack is never cut. */
const PRE_ROLL_SEC = 0.003;
/** A grid start this close to a real onset is moved onto it. */
const TRANSIENT_PULL_SEC = 0.018;

/**
 * Candidate pools for every source type.
 * @param {object} analysis  from analyseBreak()
 * @param {Float32Array} mono
 * @param {number} sampleRate
 */
export function buildSourcePools(analysis, mono, sampleRate) {
  const { grid, hits, onsets, duration } = analysis;
  const fileRms = rmsOf(mono, 0, mono.length) || 1e-9;
  const pools = {
    snare: snarePool(hits, grid, duration),
    hit: hitPool(hits, grid, duration),
  };
  for (const [key, beats] of Object.entries(GRID_UNITS)) pools[key] = gridPool(key, beats, grid, onsets, mono, sampleRate, fileRms, duration);
  return pools;
}

function inBarPosition(grid, t) {
  const rel = (t - grid.downbeat) / grid.bar;
  return ((rel % 1) + 1) % 1;
}

function barIndex(grid, t) {
  return Math.floor((t - grid.downbeat) / grid.bar + 1e-6);
}

function snarePool(hits, grid, duration) {
  if (!hits.length) return [];
  const sorted = hits.map((h) => h.snareScore).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const sixteenthOfBar = 1 / 16;
  return hits
    .filter((h) => h.peak >= 0.15 && (h.label === "snare" || h.snareScore >= median))
    .map((h) => {
      const pos = inBarPosition(grid, h.onset);
      // Beats 2 and 4 - where the snare lives in almost every break ever sampled.
      const backbeat = Math.abs(pos - 0.25) <= sixteenthOfBar * 0.6 || Math.abs(pos - 0.75) <= sixteenthOfBar * 0.6;
      const score = h.snareScore + (backbeat ? 0.45 : 0) + (h.label === "snare" ? 0.2 : 0);
      return {
        type: "snare",
        anchor: h.onset,
        start: Math.max(0, h.onset - PRE_ROLL_SEC),
        minEnd: Math.min(duration, Math.max(h.end, h.onset + 0.1)),
        score,
        note: backbeat ? "backbeat snare" : "snare",
      };
    })
    .sort((a, b) => b.score - a.score);
}

function hitPool(hits, grid, duration) {
  return hits
    .filter((h) => h.peak >= 0.12)
    .map((h) => ({
      type: "hit",
      anchor: h.onset,
      start: Math.max(0, h.onset - PRE_ROLL_SEC),
      minEnd: Math.min(duration, Math.max(h.end, h.onset + 0.07)),
      maxEnd: Math.min(duration, h.onset + grid.beat),
      score: 0.6 * h.strength + 0.4 * h.peak + (h.label === "cymbal" ? 0.15 : 0),
      note: h.label,
      label: h.label,
    }))
    .sort((a, b) => b.score - a.score);
}

function gridPool(type, beats, grid, onsets, mono, sampleRate, fileRms, duration) {
  const len = beats * grid.beat;
  const out = [];
  // Walk the grid from the first whole unit at or after 0 (a pickup before bar 1 is fair game).
  const unit = len;
  let k = Math.ceil((0 - grid.downbeat) / unit - 1e-6);
  const nearestOnset = (t, radius) => {
    let best = null;
    for (const o of onsets) {
      const d = Math.abs(o.time - t);
      if (d <= radius && (!best || d < Math.abs(best.time - t))) best = o;
    }
    return best;
  };
  for (; ; k++) {
    const gridStart = grid.downbeat + k * unit;
    const end = gridStart + len;
    if (end > duration + 0.001) break;
    if (gridStart < 0) continue;
    const hitAtStart = nearestOnset(gridStart, TRANSIENT_PULL_SEC);
    const start = hitAtStart ? Math.max(0, hitAtStart.time - PRE_ROLL_SEC) : gridStart;
    const s = Math.round(start * sampleRate);
    const e = Math.min(mono.length, Math.round(end * sampleRate));
    const energy = rmsOf(mono, s, e) / fileRms;
    if (energy < 0.15) continue; // silence is not a fragment

    const pos = inBarPosition(grid, gridStart);
    const bar = barIndex(grid, gridStart);
    let score = (hitAtStart ? 0.6 + 0.6 * hitAtStart.strength : 0.15) + Math.min(0.5, 0.3 * energy);
    // Transient + decay: a hit that rings out inside the fragment is far more interesting to stretch
    // than a flat wash of hats.
    score += 0.35 * decayContrast(mono, s, e);
    const notes = [];
    const endPos = pos + beats / 4;
    if (endPos >= 0.999) {
      score += type === "1/16" ? 0.3 : 0.5;
      notes.push("bar end");
    } else if (pos >= 0.749) {
      score += 0.25;
      notes.push("last beat");
    }
    if (grid.loopBars >= 2 && bar === grid.loopBars - 1 && pos >= 0.5) {
      score += 0.3;
      notes.push("phrase end");
    }
    const next = nearestOnset(end, 0.03);
    const endInBar = inBarPosition(grid, end);
    if (next && next.strength >= 0.5 && Math.min(endInBar, 1 - endInBar) < 0.02) {
      score += 0.35;
      notes.push("into downbeat");
    }
    out.push({ type, anchor: gridStart, start, end, gridStart, score, note: notes[0] || describeBeat(grid, gridStart) });
  }
  return out.sort((a, b) => b.score - a.score);
}

function describeBeat(grid, t) {
  const p = gridPosition(grid, t);
  return p ? `beat ${p.beat}` : "";
}

/** 0-1: how much louder the first third of a region is than its last third. */
function decayContrast(mono, s, e) {
  const n = e - s;
  if (n < 16) return 0;
  const head = rmsOf(mono, s, s + Math.floor(n / 3));
  const tail = rmsOf(mono, e - Math.floor(n / 3), e);
  if (head <= 1e-9) return 0;
  return Math.max(0, Math.min(1, 1 - tail / head));
}

function rmsOf(x, a, b) {
  const lo = Math.max(0, a);
  const hi = Math.min(x.length, b);
  if (hi <= lo) return 0;
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / (hi - lo));
}

/** Source types AUTO falls back through, per requested type, when a pool comes back empty. */
const FALLBACKS = {
  snare: ["snare", "hit", "1/8"],
  hit: ["hit", "1/8", "1/16"],
  "1/16": ["1/16", "hit", "1/8"],
  "1/8": ["1/8", "1/4", "hit"],
  "1/4": ["1/4", "1/8", "hit"],
};

/**
 * Pick one fragment of `type` from the pools. Weighted towards the best-scoring candidates, but
 * spread out: anything overlapping a fragment already in `used` is heavily discounted, so a bank
 * visits different parts of the break.
 *
 * @param {object} pools     from buildSourcePools()
 * @param {string} type      snare | hit | 1/16 | 1/8 | 1/4
 * @param {object} grid
 * @param {object} rng       makeRng() instance
 * @param {{start:number,end:number}[]} used
 * @param {object} [opts]    {tailBeats} snare/hit tail length in beats; {preferLabel} a drum label
 *                           ("cymbal") or {preferNotes} candidate notes ("bar end") to look for first
 * @returns {object|null}    {type, start, end, anchor, note, requestedType}
 */
export function pickSource(pools, type, grid, rng, used = [], opts = {}) {
  for (const t of FALLBACKS[type] || [type]) {
    const pool = pools[t] || [];
    if (!pool.length) continue;
    // A preferred drum (the crash for "pitched-down crash") or place (a bar end for the phrase-end
    // mangle) is looked for first, if the break has one.
    const liked = opts.preferLabel ? pool.filter((c) => c.label === opts.preferLabel) : opts.preferNotes ? pool.filter((c) => opts.preferNotes.includes(c.note)) : [];
    const ranked = liked.length ? liked : pool;
    const top = ranked.slice(0, Math.max(4, Math.min(10, Math.ceil(ranked.length * 0.5))));
    const weights = top.map((c) => {
      const overlap = used.some((u) => c.start < u.end - 0.01 && (c.end || c.minEnd) > u.start + 0.01);
      const reuse = used.some((u) => Math.abs(u.start - c.start) < 0.01);
      return Math.max(0.01, c.score) ** 2 * (reuse ? 0.03 : overlap ? 0.25 : 1);
    });
    const c = top[weightedIndex(weights, rng)];
    return { ...materialise(c, grid, rng, opts), requestedType: type };
  }
  return null;
}

/** Turn a pool candidate into a concrete [start, end] fragment. */
function materialise(c, grid, rng, opts) {
  if (c.type === "snare") {
    // "The transient plus enough following material": half a beat to a beat of it, never less
    // than the hit's own ring-out.
    const tail = opts.tailBeats ?? [0.5, 0.75, 1][rng.int(3)];
    const end = Math.max(c.minEnd, c.anchor + tail * grid.beat);
    return { type: c.type, start: c.start, end, anchor: c.anchor, note: c.note };
  }
  if (c.type === "hit") {
    const want = opts.tailBeats != null ? c.anchor + opts.tailBeats * grid.beat : c.minEnd;
    const end = Math.min(c.maxEnd, Math.max(c.minEnd, want));
    return { type: c.type, start: c.start, end, anchor: c.anchor, note: c.note, label: c.label };
  }
  return { type: c.type, start: c.start, end: c.end, anchor: c.anchor, note: c.note };
}

function weightedIndex(weights, rng) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/** A user-dragged region as a source. Taken exactly as drawn - they know which snare they meant. */
export function manualSource(startSec, endSec) {
  const start = Math.max(0, Math.min(startSec, endSec));
  const end = Math.max(startSec, endSec);
  return { type: "manual", requestedType: "manual", start, end, anchor: start, note: "your selection" };
}
