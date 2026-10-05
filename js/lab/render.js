// render.js
//
// Turns (source audio, graph) into (processed audio, safety facts) - the offline
// AudioBuffer -> AudioBuffer pipeline the spec asks for. Every function here is pure: no AI, no
// network, nothing but deterministic arithmetic over Float32Arrays, so a render is reproducible from
// (source audio, graph, macro values) alone.
//
// Two concerns are deliberately kept apart:
//
//   renderMutant()   ALWAYS renders whatever graph it's given and reports the facts. This is what
//                     backs playback for a typed seed, a KEEP recall, or dragging a macro slider -
//                     the user asked for exactly this graph, so it is never silently swapped out.
//                     Its own safety pass (DC-block, gentle limiter) still runs unconditionally: a
//                     rendered buffer is never handed to a speaker with NaN/Infinity/a catastrophic
//                     peak in it, no matter how it was reached.
//
//   searchGraph()    is what NEW and MUTATE use to pick a graph in the first place: it renders
//                     candidates and REJECTS ones that are broken, near-silent, or barely
//                     distinguishable from the source (see isAcceptable), trying derived seeds until
//                     one passes or a bounded number of attempts runs out. The seed it hands back is
//                     the one that actually produced the accepted graph, so re-entering that exact
//                     seed later reproduces it with no search involved (buildGraph/mutateGraph are
//                     pure) - the search is a generation-time convenience, not part of a mutant's
//                     identity.
import { buildGraph, mutateGraph, effectiveParamsFor, DEFAULT_MACRO_VALUES } from "./generator.js";
import { getPrimitive, dcBlock, softLimit } from "./dsp.js";
import { deriveSeed } from "../dsp/stretch/rng.js";
import { toMono } from "../dsp.js";

export { buildGraph, mutateGraph };

/** Reject a candidate whose processed audio reads as "the input, plus gain or polarity" - MUTATE and
 * NEW keep searching rather than hand back something that isn't actually a new discovery. */
export const NOVELTY_THRESHOLD = 0.1;
const NEAR_SILENT_RMS = 0.0008;
const EXTREME_DC = 0.35;

function rmsOf(mono) {
  let sum = 0;
  for (let i = 0; i < mono.length; i++) sum += mono[i] * mono[i];
  return mono.length ? Math.sqrt(sum / mono.length) : 0;
}

/** Facts about a rendered buffer - never throws, always returns numbers even on a broken buffer. */
export function analyzeSafety(channels) {
  let hasNaN = false;
  let hasInf = false;
  let peak = 0;
  let sumSq = 0;
  let dcSum = 0;
  let count = 0;
  for (const ch of channels) {
    for (let n = 0; n < ch.length; n++) {
      const v = ch[n];
      if (Number.isNaN(v)) hasNaN = true;
      else if (!Number.isFinite(v)) hasInf = true;
      else {
        peak = Math.max(peak, Math.abs(v));
        sumSq += v * v;
        dcSum += v;
        count++;
      }
    }
  }
  const rms = count ? Math.sqrt(sumSq / count) : 0;
  const dcOffset = count ? Math.abs(dcSum / count) : 0;
  return {
    finite: !hasNaN && !hasInf,
    hasNaN,
    hasInf,
    peak,
    rms,
    dcOffset,
    nearSilent: rms < NEAR_SILENT_RMS,
    extremeDc: dcOffset > EXTREME_DC,
  };
}

/** Sanitize + DC-block + a conservative, transparent-until-needed limiter. Always applied, on every
 * render, regardless of how the graph was chosen - this is listener protection, not a creative stage. */
export function applySafety(channels) {
  let out = channels.map((ch) => {
    const c = ch.slice();
    for (let n = 0; n < c.length; n++) if (!Number.isFinite(c[n])) c[n] = 0;
    return c;
  });
  out = dcBlock(out);
  let peak = 0;
  for (const ch of out) for (let n = 0; n < ch.length; n++) peak = Math.max(peak, Math.abs(ch[n]));
  if (peak > 1) {
    const g = 0.95 / peak;
    out = out.map((ch) => ch.map((v) => v * g));
  }
  return softLimit(out, 0.98);
}

/** How different `processed` is from `original`, gain- and polarity-normalized. ~0 means "the same
 * signal, louder/quieter or flipped" - not a new discovery. */
export function noveltyScore(original, processed) {
  const a = toMono(original);
  const b = toMono(processed);
  const ra = rmsOf(a);
  const rb = rmsOf(b);
  if (ra < 1e-9 || rb < 1e-9) return 0;
  const ga = 1 / ra;
  const gb = 1 / rb;
  const n = Math.min(a.length, b.length);
  let sumDirect = 0;
  let sumInverted = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i] * ga;
    const bv = b[i] * gb;
    const d = av - bv;
    const s = av + bv;
    sumDirect += d * d;
    sumInverted += s * s;
  }
  return Math.sqrt(Math.min(sumDirect, sumInverted) / Math.max(1, n));
}

/** One stage: run its primitive, blend the result back against the stage's own input, then apply
 * stereo crossfeed. This is the whole "routing" model - see generator.js's module doc. */
export function applyStage(channels, sampleRate, stage) {
  const prim = getPrimitive(stage.primitive);
  const minChannels = prim.stereoOnly ? 2 : 1;
  const wet = channels.length >= minChannels ? prim.run(channels, sampleRate, stage.effectiveParams) : channels.map((ch) => ch.slice());
  const blend = stage.blend ?? 1;
  let out = wet.map((ch, c) => {
    const dry = channels[c];
    const res = new Float32Array(ch.length);
    for (let n = 0; n < ch.length; n++) res[n] = dry[n] * (1 - blend) + ch[n] * blend;
    return res;
  });
  const cf = stage.crossfeed || 0;
  if (cf > 0 && out.length >= 2) {
    const [l, r] = out;
    const outL = new Float32Array(l.length);
    const outR = new Float32Array(r.length);
    for (let n = 0; n < l.length; n++) {
      outL[n] = l[n] * (1 - cf) + r[n] * cf;
      outR[n] = r[n] * (1 - cf) + l[n] * cf;
    }
    out = [outL, outR, ...out.slice(2)];
  }
  return out;
}

/** The graph, run stage by stage, with no safety pass - exposed for tests that want the raw signal. */
export function renderGraphRaw(sourceChannels, sampleRate, graph, macroValues = DEFAULT_MACRO_VALUES) {
  let channels = sourceChannels.map((ch) => ch.slice());
  graph.stages.forEach((stage, i) => {
    channels = applyStage(channels, sampleRate, { ...stage, effectiveParams: effectiveParamsFor(graph, i, macroValues) });
  });
  return channels;
}

/** Full pipeline: render + safety + facts. Always renders exactly the graph it's given. */
export function renderMutant({ sourceChannels, sampleRate, graph, macroValues = DEFAULT_MACRO_VALUES }) {
  const raw = renderGraphRaw(sourceChannels, sampleRate, graph, macroValues);
  const rawAnalysis = analyzeSafety(raw);
  const channels = applySafety(raw);
  const analysis = analyzeSafety(channels);
  const novelty = noveltyScore(sourceChannels, channels);
  return { channels, rawAnalysis, analysis, novelty };
}

/** Whether a candidate is worth keeping: finite going in, not near-silent coming out, and different
 * enough from the source to be a discovery rather than a gain change. */
export function isAcceptable({ rawAnalysis, analysis, novelty }) {
  if (rawAnalysis.hasNaN || rawAnalysis.hasInf) return false;
  if (analysis.nearSilent) return false;
  if (novelty < NOVELTY_THRESHOLD) return false;
  return true;
}

/**
 * NEW / MUTATE's search: try `seed`, and if it's rejected, keep trying seeds derived from it
 * (deriveSeed is itself deterministic) until one passes or `maxAttempts` runs out - at which point
 * the last attempt is returned anyway, flagged `gaveUp`, so the UI always has *something* to show
 * rather than spinning forever chasing perfect novelty (the spec is explicit that V1 doesn't need to
 * solve that perfectly).
 * @param {object} opts
 * @param {Float32Array[]} opts.sourceChannels
 * @param {number} opts.sampleRate
 * @param {number} opts.seed
 * @param {"new"|"mutate"} [opts.mode]
 * @param {object|null} [opts.parentGraph]  required when mode is "mutate"
 * @param {number} [opts.maxAttempts]
 */
export function searchGraph({ sourceChannels, sampleRate, seed, mode = "new", parentGraph = null, maxAttempts = 24 }) {
  let attemptSeed = seed;
  let last = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const graph = mode === "mutate" ? mutateGraph(parentGraph, attemptSeed) : buildGraph(attemptSeed);
    const rendered = renderMutant({ sourceChannels, sampleRate, graph, macroValues: DEFAULT_MACRO_VALUES });
    last = { graph, seed: graph.seed, attempts: attempt + 1, ...rendered };
    if (isAcceptable(rendered)) return { ...last, gaveUp: false };
    attemptSeed = deriveSeed(seed, attempt + 1);
  }
  return { ...last, gaveUp: true };
}
