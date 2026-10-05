// Node-side tests for LAB - js/lab/{dsp,generator,render}.js.
//
// LAB's whole premise is a deterministic, reproducible search over low-level DSP primitives, so most
// of what's worth testing isn't "does it sound good" (it's explicitly fine if it doesn't) but the
// promises the spec makes: a seed reproduces its graph exactly, a graph survives a JSON round trip,
// MUTATE is itself reproducible from its own seed, and nothing that comes out of render.js can be
// NaN, infinite, or a catastrophic peak, however hostile the graph that produced it.
//
// Synthetic audio only, no files in the repo - same approach as test/stretch-fx.test.mjs.
// Run with: node test/lab.test.mjs
import assert from "node:assert/strict";
import { buildGraph, mutateGraph, effectiveParamsFor, describeGraph, DEFAULT_MACRO_VALUES, MACRO_KEYS, MIN_STAGES, MAX_STAGES } from "../js/lab/generator.js";
import { renderMutant, renderGraphRaw, analyzeSafety, applySafety, noveltyScore, isAcceptable, searchGraph, NOVELTY_THRESHOLD } from "../js/lab/render.js";
import { PRIMITIVES, allPrimitives, primitiveKeys, getPrimitive, registerPrimitive, mapCurve, dcBlock, softLimit } from "../js/lab/dsp.js";

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

function toneSource(seconds = 1.5, stereo = true) {
  const n = Math.round(SR * seconds);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    l[i] = 0.35 * Math.sin(2 * Math.PI * 220 * t) + 0.12 * Math.sin(2 * Math.PI * 900 * t) * Math.exp(-2 * (t % 0.4));
    r[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t + 0.3);
  }
  return stereo ? [l, r] : [l];
}

const src = toneSource();

// ---------------------------------------------------------------------------
// Primitive registry
// ---------------------------------------------------------------------------

test("registry: has a real vocabulary, every entry declares params with valid ranges", () => {
  const prims = allPrimitives();
  assert.ok(prims.length >= 10, `only ${prims.length} primitives registered`);
  for (const p of prims) {
    assert.ok(p.key && p.label && typeof p.run === "function", p.key);
    for (const spec of p.params) {
      assert.ok(spec.max > spec.min, `${p.key}.${spec.key}: max must exceed min`);
      assert.ok(spec.default >= spec.min && spec.default <= spec.max, `${p.key}.${spec.key}: default out of range`);
    }
  }
});

test("registry: none of the primitives are named after a conventional effect", () => {
  // "delay" itself is fine - a signal-dependent delay TAP is an explicitly encouraged low-level
  // primitive (see the spec's "delayed state" category); what's banned is the *named effect units*
  // it explicitly rules out as generator vocabulary.
  const banned = /reverb|chorus|flanger|phaser|distortion|compress|bitcrush|ring.?mod|\bEQ\b|equali[sz]/i;
  for (const p of allPrimitives()) {
    assert.ok(!banned.test(p.key) && !banned.test(p.label), `${p.key} reads like a named effect`);
  }
});

test("registerPrimitive: extending the vocabulary needs no changes elsewhere", () => {
  const before = allPrimitives().length;
  registerPrimitive({
    key: "__testOnlyPassthrough",
    label: "Test-only passthrough",
    category: "test",
    params: [{ key: "mix", label: "Mix", min: 0, max: 1, default: 1, curve: "linear", macroable: true }],
    run: (channels) => channels.map((ch) => ch.slice()),
  });
  assert.equal(allPrimitives().length, before + 1);
  assert.equal(getPrimitive("__testOnlyPassthrough").label, "Test-only passthrough");
  PRIMITIVES.delete("__testOnlyPassthrough");
});

test("mapCurve: linear and exp curves land on min/max at t=0/1 and are monotonic", () => {
  for (const spec of [
    { min: 0, max: 1, curve: "linear" },
    { min: 1, max: 300, curve: "exp" },
  ]) {
    assert.ok(Math.abs(mapCurve(spec, 0) - spec.min) < 1e-9);
    assert.ok(Math.abs(mapCurve(spec, 1) - spec.max) < 1e-9);
    assert.ok(mapCurve(spec, 0.7) > mapCurve(spec, 0.3));
  }
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("buildGraph: the same seed produces byte-identical graph JSON, every time", () => {
  for (const seed of [1, 42, 4821, 999999]) {
    const a = buildGraph(seed);
    const b = buildGraph(seed);
    assert.deepEqual(a, b, `seed ${seed}`);
    assert.ok(a.stages.length >= MIN_STAGES && a.stages.length <= MAX_STAGES);
  }
});

test("buildGraph: different seeds (usually) produce different graphs", () => {
  const graphs = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => JSON.stringify(buildGraph(s)));
  assert.ok(new Set(graphs).size >= 6, "seeds should mostly land on distinct graphs");
});

test("buildGraph: every macro letter is bound to at least one real, macroable param", () => {
  for (const seed of [1, 2, 3, 4821]) {
    const g = buildGraph(seed);
    for (const letter of MACRO_KEYS) {
      const bindings = g.macros[letter];
      assert.ok(bindings.length > 0, `seed ${seed}, macro ${letter} unbound`);
      for (const b of bindings) {
        const stage = g.stages[b.stage];
        assert.ok(stage, `seed ${seed}: macro ${letter} points at a missing stage`);
        const spec = getPrimitive(stage.primitive).params.find((p) => p.key === b.param);
        assert.ok(spec && spec.macroable, `seed ${seed}: macro ${letter} -> ${b.param} isn't macroable`);
      }
    }
  }
});

test("effectiveParamsFor: moving a macro changes only the params it's bound to", () => {
  const g = buildGraph(123);
  const at = (v) => g.stages.map((_, i) => effectiveParamsFor(g, i, { A: v, B: 0.5, C: 0.5, D: 0.5 }));
  const low = at(0);
  const high = at(1);
  let anyDiffer = false;
  g.stages.forEach((stage, i) => {
    for (const key of Object.keys(low[i])) {
      const boundToA = g.macros.A.some((b) => b.stage === i && b.param === key);
      if (boundToA) {
        anyDiffer = true;
        assert.notEqual(low[i][key], high[i][key], `stage ${i} ${key} should move with macro A`);
      } else {
        assert.equal(low[i][key], high[i][key], `stage ${i} ${key} should NOT move with macro A`);
      }
    }
  });
  assert.ok(anyDiffer, "macro A should have moved at least one param");
});

// ---------------------------------------------------------------------------
// Serialization / reconstruction
// ---------------------------------------------------------------------------

test("graph: a JSON round trip reproduces byte-identical structure and identical rendered audio", () => {
  const g = buildGraph(4821);
  const round = JSON.parse(JSON.stringify(g));
  assert.deepEqual(round, g);
  const a = renderGraphRaw(src, SR, g, DEFAULT_MACRO_VALUES);
  const b = renderGraphRaw(src, SR, round, DEFAULT_MACRO_VALUES);
  for (let c = 0; c < a.length; c++) assert.deepEqual(Array.from(a[c]), Array.from(b[c]), `channel ${c}`);
});

test("graph: no functions or non-plain values anywhere in a generated graph (genuinely serialisable)", () => {
  const g = buildGraph(77);
  const seen = new Set();
  (function walk(v) {
    if (v === null || typeof v !== "object") {
      assert.ok(["number", "string", "boolean"].includes(typeof v) || v === null, `unexpected leaf type ${typeof v}`);
      return;
    }
    assert.ok(!seen.has(v), "unexpected cycle");
    seen.add(v);
    for (const k of Object.keys(v)) walk(v[k]);
  })(g);
});

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

test("mutateGraph: the same (parent, seed) mutates identically every time", () => {
  const parent = buildGraph(4821);
  const a = mutateGraph(parent, 77);
  const b = mutateGraph(parent, 77);
  assert.deepEqual(a, b);
  assert.equal(a.lineage.parentSeed, parent.seed);
  assert.equal(a.lineage.mutationSeed, b.lineage.mutationSeed);
});

test("mutateGraph: always changes something audible, and stays within stage-count bounds", () => {
  const parent = buildGraph(55);
  for (let seed = 1; seed <= 25; seed++) {
    const child = mutateGraph(parent, seed);
    assert.notDeepEqual(child, { ...parent, seed: child.seed, lineage: child.lineage }, `mutation seed ${seed} produced an identical graph`);
    assert.ok(child.stages.length >= MIN_STAGES && child.stages.length <= MAX_STAGES);
  }
});

test("mutateGraph: different mutation seeds on the same parent (usually) diverge from each other", () => {
  const parent = buildGraph(200);
  const children = [1, 2, 3, 4, 5, 6].map((s) => JSON.stringify(mutateGraph(parent, s)));
  assert.ok(new Set(children).size >= 5);
});

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

test("analyzeSafety: flags NaN and Infinity without throwing", () => {
  const withNaN = [Float32Array.from([0, NaN, 0.2])];
  const withInf = [Float32Array.from([0, Infinity, -Infinity])];
  assert.equal(analyzeSafety(withNaN).hasNaN, true);
  assert.equal(analyzeSafety(withNaN).finite, false);
  assert.equal(analyzeSafety(withInf).hasInf, true);
  assert.equal(analyzeSafety(withInf).finite, false);
});

test("applySafety: sanitizes NaN/Infinity to finite samples and never exceeds the limiter ceiling", () => {
  const broken = [Float32Array.from([NaN, Infinity, -Infinity, 5, -5, 0.2])];
  const fixed = applySafety(broken);
  const a = analyzeSafety(fixed);
  assert.ok(a.finite, "still broken after applySafety");
  assert.ok(a.peak <= 1.0001, `peak ${a.peak} above ceiling`);
});

test("renderMutant: every stock primitive, run alone, produces finite bounded audio from ordinary input", () => {
  for (const key of primitiveKeys()) {
    const graph = { version: 1, seed: 1, stages: [{ primitive: key, params: paramsAtDefault(key), blend: 1, crossfeed: 0 }], macros: { A: [], B: [], C: [], D: [] }, lineage: null };
    const out = renderMutant({ sourceChannels: src, sampleRate: SR, graph, macroValues: DEFAULT_MACRO_VALUES });
    const a = analyzeSafety(out.channels);
    assert.ok(a.finite, `${key}: not finite`);
    assert.ok(a.peak <= 1.0001, `${key}: peak ${a.peak}`);
  }
});

function paramsAtDefault(key) {
  const params = {};
  for (const spec of getPrimitive(key).params) params[spec.key] = spec.default;
  return params;
}

test("renderMutant: adversarial hand-built graphs (extreme feedback, extreme drive) stay finite and bounded", () => {
  const adversarial = [
    { primitive: "nonlinearShortFeedback", params: { delaySamples: 2, feedback: 0.95, drive: 4, mix: 1 }, blend: 1, crossfeed: 0 },
    { primitive: "signalDelayTap", params: { baseDelay: 1, depth: 300, feedback: 0.85, mix: 1 }, blend: 1, crossfeed: 0.5 },
    { primitive: "leakyIntegrator", params: { leak: 0.995, mix: 1 }, blend: 1, crossfeed: 0 },
    { primitive: "peakRatioFold", params: { decayMs: 400, foldAmt: 6, mix: 1 }, blend: 1, crossfeed: 0 },
  ];
  for (const stage of adversarial) {
    const graph = { version: 1, seed: 1, stages: [stage], macros: { A: [], B: [], C: [], D: [] }, lineage: null };
    const out = renderMutant({ sourceChannels: src, sampleRate: SR, graph, macroValues: DEFAULT_MACRO_VALUES });
    const a = analyzeSafety(out.channels);
    assert.ok(a.finite, `${stage.primitive}: not finite`);
    assert.ok(a.peak <= 1.0001, `${stage.primitive}: peak ${a.peak}`);
  }
  // Chained together (worst-case interaction of several extreme stages at once).
  const chained = { version: 1, seed: 1, stages: adversarial, macros: { A: [], B: [], C: [], D: [] }, lineage: null };
  const out = renderMutant({ sourceChannels: src, sampleRate: SR, graph: chained, macroValues: DEFAULT_MACRO_VALUES });
  const a = analyzeSafety(out.channels);
  assert.ok(a.finite, "chained adversarial graph: not finite");
  assert.ok(a.peak <= 1.0001, `chained adversarial graph: peak ${a.peak}`);
});

test("renderMutant: silence in stays silence-safe out - no crash, still finite", () => {
  const silence = [new Float32Array(SR), new Float32Array(SR)];
  for (const seed of [1, 2, 3]) {
    const g = buildGraph(seed);
    const out = renderMutant({ sourceChannels: silence, sampleRate: SR, graph: g, macroValues: DEFAULT_MACRO_VALUES });
    assert.ok(analyzeSafety(out.channels).finite, `seed ${seed}`);
  }
});

test("renderMutant: mono source through a stereo-only primitive is a safe no-op, not a crash", () => {
  const mono = toneSource(1, false);
  const graph = { version: 1, seed: 1, stages: [{ primitive: "crossChannelEnvelope", params: paramsAtDefault("crossChannelEnvelope"), blend: 1, crossfeed: 0 }], macros: { A: [], B: [], C: [], D: [] }, lineage: null };
  const out = renderMutant({ sourceChannels: mono, sampleRate: SR, graph, macroValues: DEFAULT_MACRO_VALUES });
  assert.equal(out.channels.length, 1);
  assert.ok(analyzeSafety(out.channels).finite);
});

test("dcBlock / softLimit: a large DC offset is removed, an over-scale signal is brought back in range", () => {
  const withDc = [new Float32Array(2000).fill(0.9)];
  const blocked = dcBlock(withDc);
  const settled = blocked[0].slice(-200);
  const meanAbs = settled.reduce((a, b) => a + Math.abs(b), 0) / settled.length;
  assert.ok(meanAbs < 0.05, `DC not removed, residual ${meanAbs}`);

  const hot = [Float32Array.from({ length: 100 }, () => 2.5)];
  const limited = softLimit(hot, 0.98);
  for (const v of limited[0]) assert.ok(Math.abs(v) <= 1.0001, `limiter let ${v} through`);
});

// ---------------------------------------------------------------------------
// Novelty
// ---------------------------------------------------------------------------

test("noveltyScore: identical audio scores ~0, a gain-only change scores ~0, a polarity flip scores ~0", () => {
  assert.ok(noveltyScore(src, src) < 1e-6);
  const louder = src.map((ch) => ch.map((v) => v * 2));
  assert.ok(noveltyScore(src, louder) < 1e-6, `gain change scored ${noveltyScore(src, louder)}`);
  const flipped = src.map((ch) => ch.map((v) => -v));
  assert.ok(noveltyScore(src, flipped) < 1e-6, `polarity flip scored ${noveltyScore(src, flipped)}`);
});

test("noveltyScore: a genuinely different signal scores well above the rejection threshold", () => {
  const noise = src.map((ch) => ch.map((v, i) => Math.sin(i * 1.7) * 0.4 - v));
  assert.ok(noveltyScore(src, noise) > NOVELTY_THRESHOLD * 3);
});

test("isAcceptable: rejects non-finite, near-silent, and non-novel results; accepts a real difference", () => {
  const finite = { finite: true, hasNaN: false, hasInf: false, nearSilent: false };
  assert.equal(isAcceptable({ rawAnalysis: { hasNaN: true, hasInf: false }, analysis: { nearSilent: false }, novelty: 1 }), false);
  assert.equal(isAcceptable({ rawAnalysis: { hasNaN: false, hasInf: false }, analysis: { nearSilent: true }, novelty: 1 }), false);
  assert.equal(isAcceptable({ rawAnalysis: { hasNaN: false, hasInf: false }, analysis: { nearSilent: false }, novelty: 0 }), false);
  assert.equal(isAcceptable({ rawAnalysis: { hasNaN: false, hasInf: false }, analysis: { nearSilent: false }, novelty: 1 }), true);
  void finite;
});

test("searchGraph: an accepted mutant's seed, re-built directly, reproduces the identical graph (no search needed on reload)", () => {
  for (const seed of [4821, 1, 55555]) {
    const result = searchGraph({ sourceChannels: src, sampleRate: SR, seed, mode: "new", maxAttempts: 24 });
    const reloaded = buildGraph(result.seed);
    assert.deepEqual(reloaded, result.graph, `seed ${seed}`);
  }
});

test("searchGraph: MUTATE search likewise reproduces from its accepted seed with no further search", () => {
  const parent = buildGraph(4821);
  const result = searchGraph({ sourceChannels: src, sampleRate: SR, seed: 321, mode: "mutate", parentGraph: parent, maxAttempts: 24 });
  const reloaded = mutateGraph(parent, result.seed);
  assert.deepEqual(reloaded, result.graph);
});

test("searchGraph: a hopeless search (silence, tiny attempt budget) still returns something finite rather than throwing", () => {
  const silence = [new Float32Array(SR)];
  const result = searchGraph({ sourceChannels: silence, sampleRate: SR, seed: 1, mode: "new", maxAttempts: 3 });
  assert.ok(analyzeSafety(result.channels).finite);
  assert.equal(result.attempts, 3);
});

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

test("describeGraph: one heading per stage, one line per macro, and it reflects live macro values", () => {
  const g = buildGraph(4821);
  const atLow = describeGraph(g, { A: 0, B: 0, C: 0, D: 0 });
  const atHigh = describeGraph(g, { A: 1, B: 1, C: 1, D: 1 });
  assert.equal(atLow.stages.length, g.stages.length);
  assert.equal(atLow.macros.length, MACRO_KEYS.length);
  assert.notDeepEqual(atLow, atHigh, "moving every macro to its opposite extreme should change the description");
});

console.log(`\n${passed} passed`);
