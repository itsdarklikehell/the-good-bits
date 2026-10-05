// generator.js
//
// LAB's evolutionary layer: turns a seed into a graph (NEW), and turns a graph + a seed into a
// related descendant (MUTATE). Both are pure functions of their inputs - all the randomness in this
// file runs through the same seeded `mulberry32` generator the rest of the app already uses for
// reproducible creative decisions (js/dsp/stretch/rng.js, see FLIP and STRETCH FX), never
// Math.random() - so "same seed in -> same graph out" holds exactly, forever, independent of when or
// how many times it's called.
//
// A GRAPH is plain, JSON-serialisable data - no functions, no class instances - so it can be copied,
// inspected, round-tripped through JSON, and stored in localStorage without any special handling:
//
//   {
//     version: 1,
//     seed: <uint32>,                    // this graph's own identity
//     stages: [ { primitive: <registry key>, params: {..concrete values..}, blend: 0-1, crossfeed: 0-1 }, ... ],
//     macros: { A: [{stage, param, invert}], B: [...], C: [...], D: [...] },
//     lineage: null | { parentSeed, mutationSeed },
//   }
//
// STAGES run in series; each stage's `params` are the concrete values baked in at generation time.
// `blend` (0-1) crossfades the stage's output back against its own input - low blend is effectively a
// parallel send rather than a full replace, which is the only "routing" freedom V1 needs: it's enough
// to make MUTATE's routing edits audible without a general graph-of-graphs executor. `crossfeed`
// mixes a little of the *other* channel in after the primitive runs, for primitives that aren't
// themselves stereo-aware.
//
// MACROS are a layer of indirection on top of the stages: each of the four macro letters owns a small
// list of (stage index, param key) bindings. A parameter that's macro-bound ignores its own baked-in
// value at render time and is recomputed from the live macro slider instead (see effectiveParamsFor) -
// that's what makes the four controls "continuous and explorable" rather than re-triggering
// generation. Everything NOT bound to a macro stays exactly as generation left it, which is what makes
// a mutant's *character* stable while A-D are still doing something real.
import { makeRng, hashSeed } from "../dsp/stretch/rng.js";
import { getPrimitive, primitiveKeys, mapCurve } from "./dsp.js";

export const MIN_STAGES = 3;
export const MAX_STAGES = 6;
export const MACRO_KEYS = ["A", "B", "C", "D"];
export const DEFAULT_MACRO_VALUES = { A: 0.5, B: 0.5, C: 0.5, D: 0.5 };

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function buildStage(rng) {
  const keys = primitiveKeys();
  const key = keys[rng.int(keys.length)];
  const prim = getPrimitive(key);
  const params = {};
  for (const spec of prim.params) params[spec.key] = mapCurve(spec, rng.next());
  return {
    primitive: key,
    params,
    blend: Math.round(rng.range(0.55, 1) * 1000) / 1000,
    crossfeed: rng.bool(0.25) ? Math.round(rng.range(0.05, 0.5) * 1000) / 1000 : 0,
  };
}

function shuffleInPlace(list, rng) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** Every macro-eligible (stage index, param key) pair currently in the graph. */
function macroCandidates(stages) {
  const out = [];
  stages.forEach((stage, idx) => {
    const prim = getPrimitive(stage.primitive);
    for (const spec of prim.params) if (spec.macroable) out.push({ stage: idx, param: spec.key });
  });
  return out;
}

function assignMacros(stages, rng) {
  const pool = shuffleInPlace(macroCandidates(stages), rng);
  const macros = { A: [], B: [], C: [], D: [] };
  let i = 0;
  for (const letter of MACRO_KEYS) {
    const bindCount = pool.length ? 1 + (rng.bool(0.35) ? 1 : 0) : 0;
    for (let b = 0; b < bindCount && i < pool.length; b++) {
      const c = pool[i++];
      macros[letter].push({ stage: c.stage, param: c.param, invert: rng.bool(0.2) });
    }
  }
  // Guarantee every macro does *something* - with >=3 stages there are always more candidates than
  // the four macros need, so this only ever reuses a pairing, never invents one out of nothing.
  const all = macroCandidates(stages);
  for (const letter of MACRO_KEYS) {
    if (macros[letter].length) continue;
    const c = all[rng.int(all.length)];
    if (c) macros[letter].push({ stage: c.stage, param: c.param, invert: rng.bool(0.2) });
  }
  return macros;
}

/** A brand-new graph from a seed alone. NEW never randomises one fixed algorithm - it draws a fresh
 * stage count, fresh primitives, fresh params and fresh macro wiring every time. */
export function buildGraph(seed) {
  const rng = makeRng(seed);
  const stageCount = MIN_STAGES + rng.int(MAX_STAGES - MIN_STAGES + 1);
  const stages = [];
  for (let i = 0; i < stageCount; i++) stages.push(buildStage(rng));
  return {
    version: 1,
    seed: hashSeed(seed),
    stages,
    macros: assignMacros(stages, rng),
    lineage: null,
  };
}

/** The concrete params a stage should render with right now: baked-in values, overridden wherever a
 * macro currently owns that param. */
export function effectiveParamsFor(graph, stageIndex, macroValues = DEFAULT_MACRO_VALUES) {
  const stage = graph.stages[stageIndex];
  const prim = getPrimitive(stage.primitive);
  const params = { ...stage.params };
  for (const letter of MACRO_KEYS) {
    const bindings = graph.macros[letter] || [];
    for (const b of bindings) {
      if (b.stage !== stageIndex) continue;
      const spec = prim.params.find((p) => p.key === b.param);
      if (!spec) continue;
      const raw = macroValues[letter] ?? 0.5;
      const t = b.invert ? 1 - raw : raw;
      params[b.param] = mapCurve(spec, t);
    }
  }
  return params;
}

/**
 * A related descendant of `graph`, seeded so MUTATE is itself reproducible: the same (graph, seed)
 * always mutates the same way. Never a reroll - at least one change always happens, but most of the
 * parent survives, which is what makes a run of MUTATEs read as "turning knobs on the same
 * discovery" rather than a new NEW every click.
 */
export function mutateGraph(graph, seed) {
  const rng = makeRng(seed);
  const next = JSON.parse(JSON.stringify(graph));
  let changed = 0;

  // Swap one stage's primitive outright (fresh params for its new identity, same position and routing).
  if (rng.bool(0.3) && next.stages.length) {
    const idx = rng.int(next.stages.length);
    const keys = primitiveKeys().filter((k) => k !== next.stages[idx].primitive);
    if (keys.length) {
      const newKey = keys[rng.int(keys.length)];
      const params = {};
      for (const spec of getPrimitive(newKey).params) params[spec.key] = mapCurve(spec, rng.next());
      next.stages[idx] = { ...next.stages[idx], primitive: newKey, params };
      changed++;
    }
  }

  // Nudge a handful of baked-in param values (audible even when the param isn't macro-bound).
  for (const stage of next.stages) {
    const prim = getPrimitive(stage.primitive);
    for (const spec of prim.params) {
      if (!rng.bool(0.22)) continue;
      const jitter = rng.signed() * 0.25;
      const base = spec.curve === "exp" ? Math.log(Math.max(stage.params[spec.key], 1e-6) / Math.max(spec.min, 1e-6)) / Math.log(Math.max(spec.max, 1e-6) / Math.max(spec.min, 1e-6) || 1) : (stage.params[spec.key] - spec.min) / (spec.max - spec.min || 1);
      stage.params[spec.key] = mapCurve(spec, clamp01((Number.isFinite(base) ? base : 0.5) + jitter));
      changed++;
    }
  }

  // Reorder two adjacent stages.
  if (rng.bool(0.25) && next.stages.length > 1) {
    const i = rng.int(next.stages.length - 1);
    [next.stages[i], next.stages[i + 1]] = [next.stages[i + 1], next.stages[i]];
    changed++;
  }

  // Nudge routing (blend / crossfeed) on a stage.
  if (rng.bool(0.3) && next.stages.length) {
    const stage = next.stages[rng.int(next.stages.length)];
    if (rng.bool(0.5)) stage.blend = clamp01(stage.blend + rng.signed() * 0.3);
    else stage.crossfeed = clamp01((stage.crossfeed || 0) + rng.signed() * 0.3);
    changed++;
  }

  // Add or drop a stage.
  if (rng.bool(0.18)) {
    if (next.stages.length < MAX_STAGES && (next.stages.length === MIN_STAGES || rng.bool(0.5))) {
      next.stages.splice(rng.int(next.stages.length + 1), 0, buildStage(rng));
      changed++;
    } else if (next.stages.length > MIN_STAGES) {
      next.stages.splice(rng.int(next.stages.length), 1);
      changed++;
    }
  }

  // Rewire one macro binding to a different (stage, param) pair.
  if (rng.bool(0.3)) {
    const letter = MACRO_KEYS[rng.int(MACRO_KEYS.length)];
    const pool = macroCandidates(next.stages);
    if (pool.length) {
      const c = pool[rng.int(pool.length)];
      next.macros[letter] = [{ stage: c.stage, param: c.param, invert: rng.bool(0.2) }];
      changed++;
    }
  }

  if (!changed) {
    // Never a no-op mutation: fall back to a guaranteed audible nudge.
    const stage = next.stages[rng.int(next.stages.length)];
    stage.blend = clamp01(stage.blend + (rng.bool() ? 0.2 : -0.2));
  }

  // Stage/macro indices can drift out of range after an add/remove - reassign anything now invalid
  // rather than leaving a dangling reference into a stage that no longer exists.
  for (const letter of MACRO_KEYS) {
    next.macros[letter] = next.macros[letter].filter((b) => b.stage < next.stages.length);
  }
  const stillNeeds = MACRO_KEYS.filter((l) => !next.macros[l].length);
  if (stillNeeds.length) {
    const pool = macroCandidates(next.stages);
    for (const letter of stillNeeds) {
      const c = pool[rng.int(pool.length)];
      if (c) next.macros[letter] = [{ stage: c.stage, param: c.param, invert: rng.bool(0.2) }];
    }
  }

  next.seed = hashSeed(seed);
  next.lineage = { parentSeed: graph.seed, mutationSeed: hashSeed(seed) };
  return next;
}

/** Human-readable lines for the inspector - "does not need to be beautiful", just not opaque. */
export function describeGraph(graph, macroValues = DEFAULT_MACRO_VALUES) {
  const lines = [];
  graph.stages.forEach((stage, i) => {
    const prim = getPrimitive(stage.primitive);
    const params = effectiveParamsFor(graph, i, macroValues);
    const paramText = prim.params.map((spec) => `${spec.key} ${formatNum(params[spec.key])}`).join(", ");
    lines.push({
      heading: `Primitive ${i + 1}: ${prim.label}`,
      body: `${paramText} · blend ${formatNum(stage.blend)}${stage.crossfeed ? ` · crossfeed ${formatNum(stage.crossfeed)}` : ""}`,
    });
  });
  const macroLines = MACRO_KEYS.map((letter) => {
    const bindings = graph.macros[letter] || [];
    if (!bindings.length) return `${letter}: unassigned`;
    const text = bindings.map((b) => `#${b.stage + 1} ${b.param}${b.invert ? " (inverted)" : ""}`).join(", ");
    return `${letter}: ${text}`;
  });
  return { stages: lines, macros: macroLines };
}

function formatNum(v) {
  if (!Number.isFinite(v)) return String(v);
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3);
}
