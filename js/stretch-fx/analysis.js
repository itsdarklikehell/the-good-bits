// analysis.js
//
// What STRETCH FX needs to know about a break before it can pick anything worth destroying: where
// the hits are, which of them are probably snares, how hard each one lands, and where the bars
// are. None of the detection is new - it is the same onset curve, one-shot windowing, band-energy
// classifier and beat-grid fit the CHOP task already uses (js/dsp.js), called in the same order as
// app.js's detectOneShotRegions(). This module only adds the bookkeeping STRETCH FX wants on top:
// a strength per onset, a snare score per hit, and a grid object with the loop's length in bars,
// which is what Snap Back wraps around.
//
// Pure: no DOM, no Web Audio. Runs in Node for the tests.
import { computeRmsEnvelope, multiBandOnsetStrengthCurve, pickOnsets, findOneShotWindows, bandEnergies, classifyHit, fitBeatGrid, peakAbs } from "../dsp.js";

/** Tempo the grid-based source types fall back to when no tempo was detected or typed. Jungle-ish on purpose. */
export const FALLBACK_BPM = 170;

/** How much of each hit's opening is used to decide what drum it is - the attack, not the ring-out or whatever follows. */
const CLASSIFY_BODY_SEC = 0.12;

/**
 * @param {object} opts
 * @param {Float32Array} opts.mono
 * @param {number} opts.sampleRate
 * @param {number|null} opts.bpm   effective tempo (detected, or the user's correction), or null
 * @returns {{duration:number, onsets:{time:number,strength:number}[], hits:object[], grid:object}}
 */
export function analyseBreak({ mono, sampleRate, bpm }) {
  const duration = mono.length / sampleRate;
  const onsets = detectOnsets(mono, sampleRate);
  const hits = describeHits(mono, sampleRate, onsets);
  const grid = buildGrid(mono, sampleRate, bpm, onsets, duration, hits);
  return { duration, onsets, hits, grid };
}

/** Onsets with a 0-1 strength, from the same curve and thresholds detectOneShotRegions() uses. */
function detectOnsets(mono, sampleRate) {
  const env = computeRmsEnvelope(mono, sampleRate, 20, 10);
  if (!env.vals.length) return [];
  const { diffs } = multiBandOnsetStrengthCurve(mono, sampleRate, 20, 10, env);
  const times = pickOnsets(env.times, diffs, 0.65, 0.08);
  const indexOf = new Map(env.times.map((t, i) => [t, i]));
  const raw = times.map((time) => ({ time, strength: diffs[indexOf.get(time)] || 0 }));
  const max = raw.reduce((m, o) => Math.max(m, o.strength), 0) || 1;
  const out = raw.map((o) => ({ time: o.time, strength: o.strength / max }));
  // A break trimmed to start ON its first hit - which is how almost every break is cut - has no
  // rise into that hit for the onset curve to see, so the downbeat kick at 0:00 goes missing. If the
  // file opens loud, that opening is a hit.
  if (opensOnAHit(mono, sampleRate, env.vals) && !(out.length && out[0].time < 0.05)) out.unshift({ time: 0, strength: 1 });
  return out;
}

function opensOnAHit(mono, sampleRate, envVals) {
  const n = Math.min(mono.length, Math.round(0.01 * sampleRate));
  if (n < 8 || !envVals.length) return false;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += mono[i] * mono[i];
  const opening = Math.sqrt(sum / n);
  const sorted = [...envVals].sort((a, b) => a - b);
  const typicalLoud = sorted[Math.floor(sorted.length * 0.9)] || 0;
  return typicalLoud > 0 && opening >= typicalLoud * 0.5;
}

/** One entry per onset: its one-shot window, drum label and snare score. */
function describeHits(mono, sampleRate, onsets) {
  if (!onsets.length) return [];
  const windows = findOneShotWindows(
    mono,
    sampleRate,
    onsets.map((o) => o.time)
  );
  const loudest = Math.max(1e-9, peakAbs(mono, 0, mono.length));
  const hits = [];
  // findOneShotWindows returns one window per onset, in order, each starting a fixed pre-roll
  // before its onset - matched by position rather than assumed index-aligned, so a dropped window
  // can't shift every later hit onto the wrong onset.
  let w = 0;
  for (const onset of onsets) {
    while (w < windows.length && windows[w][0] < onset.time - 0.02) w++;
    const win = w < windows.length && Math.abs(windows[w][0] - onset.time) <= 0.02 ? windows[w] : [Math.max(0, onset.time - 0.004), onset.time + 0.15];
    const [start, end] = win;
    const s = Math.max(0, Math.round(start * sampleRate));
    const bodyEnd = Math.min(mono.length, Math.round(Math.min(end, onset.time + CLASSIFY_BODY_SEC) * sampleRate));
    const { low, mid, high } = bandEnergies(mono, sampleRate, s, bodyEnd);
    const total = low + mid + high || 1e-9;
    const lowR = low / total;
    const midR = mid / total;
    const highR = high / total;
    const label = classifyHit({ low, mid, high, durationSec: end - start });
    const peak = peakAbs(mono, s, Math.min(mono.length, Math.round(end * sampleRate))) / loudest;
    hits.push({
      onset: onset.time,
      start,
      end,
      strength: onset.strength,
      peak,
      label,
      lowR,
      midR,
      highR,
      // Snares are mid-heavy and broadband with little sub: reward mid and top, punish low. A crude
      // score, but only ever used to RANK hits against each other within one break.
      snareScore: midR + 0.6 * highR - 0.8 * lowR + 0.35 * onset.strength + 0.25 * peak,
    });
  }
  return hits;
}

/**
 * The bar grid everything musical is measured against. Uses the shared fitBeatGrid() when there is
 * enough of a break to fit (two bars or more); otherwise anchors bar 1 on the strongest early onset.
 * Always returns a grid - `assumed` says the tempo was a fallback guess and `fitted` whether the
 * phase came from a real fit.
 */
function buildGrid(mono, sampleRate, bpm, onsets, duration, hits = []) {
  const assumed = !(bpm > 0);
  const tempo = assumed ? FALLBACK_BPM : bpm;
  let fit = null;
  if (!assumed) {
    try {
      fit = fitBeatGrid(mono, sampleRate, tempo);
    } catch (_) {
      fit = null;
    }
  }
  const useBpm = fit && fit.bpm > 0 ? fit.bpm : tempo;
  const beat = 60 / useBpm;
  const bar = beat * 4;
  let downbeat = fit ? fit.downbeat : firstStrongOnset(onsets);
  let phaseSource = fit ? "fit" : "first hit";
  // A short break (too short to fit) that opens on a hit is anchored by that hit: a bar or so of
  // ghost notes and stray hats isn't enough evidence for the snare vote to overrule "it starts on 1".
  const trustOpening = !fit && downbeat < 0.01 && duration < 2 * bar + 0.1;
  if (!assumed && !trustOpening) {
    const voted = backbeatVote(hits, beat, downbeat);
    if (voted !== downbeat) {
      downbeat = voted;
      phaseSource = "backbeat";
    }
  }
  // Walk bar 1 back to the first bar line in the file. It may land a hair BEFORE 0 - a break
  // trimmed a few ms into its first kick - and stays there rather than being clamped, so every grid
  // line keeps its true phase; only the loop start is clamped to the file.
  while (downbeat - bar >= -0.1 * beat) downbeat -= bar;

  const span = duration - Math.max(0, downbeat);
  let loopBars = Math.floor(span / bar + 0.12);
  let loopStart = Math.max(0, downbeat);
  let loopEnd = loopStart + loopBars * bar;
  if (loopBars < 1 || loopEnd > duration + 0.02) {
    loopBars = Math.max(0, Math.min(loopBars, Math.floor(span / bar)));
    loopEnd = loopBars >= 1 ? loopStart + loopBars * bar : duration;
    if (loopBars < 1) loopStart = 0;
  }
  return { bpm: useBpm, beat, bar, downbeat, loopStart, loopEnd: Math.min(duration, loopEnd), loopBars, assumed, fitted: !!fit, phaseSource };
}

/**
 * Which beat is beat 1, settled by the snares. fitBeatGrid() decides the bar phase from kick energy
 * and the on-beat/off-beat split from overall attack energy - which is exactly what breakbeats
 * confuse, because half their kicks are on the "and" (the Amen's 1-and, 3-and). Snares are far
 * more dependable: they are on 2 and 4. So every half-beat rotation of the bar is scored by how many
 * snare-labelled hits land on 2 and 4 and kick-labelled hits on 1 and 3, and the fit is only
 * overruled when the backbeat clearly disagrees with it.
 */
/** How well the hits fit a 4/4 backbeat with bar 1 at `d`: snares on 2 and 4, kicks on 1 and 3. */
function backbeatScore(hits, beat, d) {
  const tol = 0.14; // beats - a little over a 32nd either side
  let s = 0;
  for (const h of hits) {
    if (h.peak < 0.2) continue;
    const pos = ((((h.onset - d) / beat) % 4) + 4) % 4;
    const near = (target) => Math.min(Math.abs(pos - target), 4 - Math.abs(pos - target)) <= tol;
    const w = h.peak * (0.5 + h.strength);
    if (h.label === "snare") s += near(1) || near(3) ? w : near(0) || near(2) ? -0.6 * w : 0;
    else if (h.label === "kick") s += near(0) ? 0.5 * w : near(2) ? 0.25 * w : 0;
  }
  return s;
}

/**
 * How convincingly the snares make a two-and-four backbeat at this tempo, for the octave check.
 * Unlike backbeatScore, a bar only counts when BOTH backbeats have a snare: at double the true tempo
 * a break's snares all land on the same beat of every (half-length) bar, which any rotation can line
 * up with "2" - but never with 2 and 4 at once. Best over every half-beat rotation.
 */
function backbeatPairs(hits, beat, anchor) {
  const snares = hits.filter((h) => h.label === "snare" && h.peak >= 0.2);
  const bar = beat * 4;
  const tol = 0.14;
  let best = -Infinity;
  for (let r = 0; r < 8; r++) {
    const d = anchor + (r * beat) / 2;
    const bars = new Map();
    let wrong = 0;
    for (const h of snares) {
      const rel = (h.onset - d) / beat;
      const barIdx = Math.floor(rel / 4);
      const pos = rel - barIdx * 4;
      const near = (target) => Math.abs(pos - target) <= tol || Math.abs(pos - target - 4) <= tol;
      const w = h.peak * (0.5 + h.strength);
      if (!bars.has(barIdx)) bars.set(barIdx, [0, 0]);
      if (near(1)) bars.get(barIdx)[0] = Math.max(bars.get(barIdx)[0], w);
      else if (near(3)) bars.get(barIdx)[1] = Math.max(bars.get(barIdx)[1], w);
      else if (near(0) || near(2)) wrong += w;
    }
    let score = -0.6 * wrong;
    for (const [two, four] of bars.values()) score += Math.min(two, four);
    best = Math.max(best, score);
  }
  return best / Math.max(1, bar);
}

/**
 * Half-time / double-time check, settled by the snares. Tempo detectors routinely read a 170 BPM
 * jungle break as 85, and the two readings are easy to tell apart by ear and by snare: at the true
 * tempo the snares sit on 2 and 4; at half tempo they land on off-beats; and a genuine 85 BPM break
 * read at double time puts its snares on 3. So the tempo, its double and its half are all scored,
 * and a clearly better fit is returned. It's a SUGGESTION (the UI offers it as one click), never
 * applied on its own: on a busy break full of loud ghost notes it can be wrong in either direction,
 * and a silent wrong "correction" would be worse than the detector's own answer. Returns the input
 * tempo when nothing is clearly better.
 *
 * @param {object[]} hits   analyseBreak().hits
 * @param {number} bpm
 */
export function snareTempoOctave(hits, bpm) {
  if (!(bpm > 0)) return bpm;
  const snares = hits.filter((h) => h.label === "snare" && h.peak >= 0.2);
  if (snares.length < 3) return bpm;
  const anchor = hits.length ? hits[0].onset : 0;
  const candidates = [bpm, ...[bpm * 2, bpm / 2].filter((b) => b >= 60 && b <= 220)];
  // Per second, so readings with longer bars (half tempo) don't win just by having fewer of them.
  const scored = candidates.map((b) => ({ bpm: b, score: backbeatPairs(hits, 60 / b, anchor) }));
  const current = scored[0];
  const best = scored.reduce((a, b) => (b.score > a.score ? b : a), current);
  // Clearly better, not marginally: a wrong "correction" is worse than the detector's own answer.
  return best !== current && best.score > 0 && best.score >= current.score * 1.5 + 0.05 ? best.bpm : bpm;
}

function backbeatVote(hits, beat, downbeat) {
  const snares = hits.filter((h) => h.label === "snare" && h.peak >= 0.2);
  if (snares.length < 2) return downbeat;
  const score = (d) => backbeatScore(hits, beat, d);
  const bar = beat * 4;
  // Distance of a bar line from the start of the file: breaks are nearly always trimmed to bar 1,
  // so of two equally good readings (on a single bar, "snares on 2 and 4" fits two rotations) the
  // one that starts the bar at 0:00 wins.
  const fromStart = (d) => {
    const ph = ((d % bar) + bar) % bar;
    return Math.min(ph, bar - ph);
  };
  const current = score(downbeat);
  let best = downbeat;
  let bestScore = current;
  for (let halfBeats = 1; halfBeats < 8; halfBeats++) {
    const d = downbeat + (halfBeats * beat) / 2;
    const s = score(d);
    if (s > bestScore + 1e-6 || (Math.abs(s - bestScore) <= 1e-6 && best !== downbeat && fromStart(d) < fromStart(best))) {
      bestScore = s;
      best = d;
    }
  }
  if (best === downbeat) return downbeat;
  const beatsBetter = bestScore >= current + Math.max(0.6, Math.abs(current) * 0.3);
  // An equally good reading that puts bar 1 at the top of the file also wins over the fit's.
  const tiedButAtStart = Math.abs(bestScore - current) <= 1e-6 && fromStart(best) + 0.01 < fromStart(downbeat);
  if (!beatsBetter && !tiedButAtStart) return downbeat;
  return best - Math.floor(best / bar) * bar;
}

function firstStrongOnset(onsets) {
  const strong = onsets.find((o) => o.strength >= 0.35);
  return strong ? strong.time : onsets.length ? onsets[0].time : 0;
}

/** Position of time `t` on the grid as 1-based bar.beat.sixteenth, the way a sampler would print it. */
export function gridPosition(grid, t) {
  if (!grid) return null;
  const sixteenth = grid.beat / 4;
  const rel = t - grid.downbeat;
  const idx = Math.round(rel / sixteenth);
  const barIdx = Math.floor(idx / 16);
  const inBar = ((idx % 16) + 16) % 16;
  return { bar: barIdx + 1, beat: Math.floor(inBar / 4) + 1, sixteenth: (inBar % 4) + 1, text: `${barIdx + 1}.${Math.floor(inBar / 4) + 1}.${(inBar % 4) + 1}` };
}
