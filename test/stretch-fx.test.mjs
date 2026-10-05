// Node-side tests for STRETCH FX - js/stretch-fx/{analysis,sources,recipe,render,snap-back,naming}.js.
//
// The feature makes musical promises, so most of these check music rather than plumbing: snares are
// found on the backbeat, grid fragments start on the grid (or on the transient right next to it), a
// bank actually varies, MELT actually melts, and Snap Back comes back in on a beat with the break's
// real audio. Then the audio promises: every result is finite, never clips, has quiet edges, and a
// Snap Back join never clicks.
//
// Breaks are synthesised (test/fixtures-break.mjs) - no audio files in the repo.
// Run with: node test/stretch-fx.test.mjs
import assert from "node:assert/strict";
import { makeBreak } from "./fixtures-break.mjs";
import { analyseBreak, gridPosition, snareTempoOctave } from "../js/stretch-fx/analysis.js";
import { buildSourcePools, pickSource, manualSource, SOURCE_TYPES } from "../js/stretch-fx/sources.js";
import { planBank, mutateRecipe, RATIO_LADDER, MAX_FX_SECONDS, FLAVOURS, CHARACTER_HEAT } from "../js/stretch-fx/recipe.js";
import { renderFx, sliceFragment } from "../js/stretch-fx/render.js";
import { renderSnapBack } from "../js/stretch-fx/snap-back.js";
import { fxFileName, fxFolderName } from "../js/stretch-fx/naming.js";
import { CHARACTERS } from "../js/dsp/stretch/characters.js";
import { makeRng } from "../js/dsp/stretch/rng.js";
import { toMono } from "../js/dsp.js";

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

function setup(opts = {}, bpm = opts.bpm ?? 170) {
  const brk = makeBreak(opts);
  const mono = toMono(brk.channels);
  const analysis = analyseBreak({ mono, sampleRate: brk.sampleRate, bpm });
  const pools = buildSourcePools(analysis, mono, brk.sampleRate);
  return { brk, mono, analysis, pools };
}

function bank(ctx, { count = 8, melt = 0.55, flavour = "any", sourceType = "auto", manual = null, seed = 1 } = {}) {
  let s = seed * 1000;
  return planBank({ pools: ctx.pools, grid: ctx.analysis.grid, count, melt, flavour, sourceType, manual, rng: makeRng(seed), mintSeed: () => s++ });
}

function render(ctx, recipe) {
  const frag = sliceFragment(ctx.brk.channels, ctx.brk.sampleRate, recipe.source.start, recipe.source.end);
  return renderFx({ channels: frag, sampleRate: ctx.brk.sampleRate, recipe });
}

function stats(channels) {
  let peak = 0;
  let finite = true;
  for (const ch of channels)
    for (let i = 0; i < ch.length; i++) {
      if (!Number.isFinite(ch[i])) finite = false;
      peak = Math.max(peak, Math.abs(ch[i]));
    }
  return { peak, finite };
}

/** Max difference between a[aStart..+n) and b[bStart..+n), at the best of -1/0/+1 samples of alignment. */
function alignedDiff(a, aStart, b, bStart, n) {
  let best = Infinity;
  for (const shift of [-1, 0, 1]) {
    let d = 0;
    for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(a[aStart + i] - (b[(bStart + shift + i) % b.length] || 0)));
    best = Math.min(best, d);
  }
  return best;
}

/** Largest sample-to-sample jump in [a, b), per channel max. */
function maxJump(channels, a, b) {
  let j = 0;
  for (const ch of channels) for (let i = Math.max(1, a); i < Math.min(ch.length, b); i++) j = Math.max(j, Math.abs(ch[i] - ch[i - 1]));
  return j;
}

const clean = setup();
const messy = setup({ messy: true, seed: 9 });

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

test("analysis: bar 1 lands on the first kick, not the 1-and kick (backbeat vote)", () => {
  const g = clean.analysis.grid;
  const off = Math.abs(((g.downbeat % g.bar) + g.bar) % g.bar);
  assert.ok(Math.min(off, g.bar - off) < 0.02, `downbeat ${g.downbeat.toFixed(3)} should be ~0`);
  assert.equal(g.loopBars, 4);
});

test("analysis: messy break - grid still on the bar, loop still 4 bars", () => {
  const g = messy.analysis.grid;
  const off = ((g.downbeat % g.bar) + g.bar) % g.bar;
  assert.ok(Math.min(off, g.bar - off) < 0.03, `downbeat ${g.downbeat.toFixed(3)}`);
  assert.equal(g.loopBars, 4);
});

test("sources: the top SNARE candidates are the real backbeat snares", () => {
  for (const ctx of [clean, messy]) {
    const top = ctx.pools.snare.slice(0, 8);
    const real = top.filter((c) => ctx.brk.snareTimes.some((t) => Math.abs(c.anchor - t) < 0.03));
    assert.ok(real.length >= 6, `only ${real.length}/8 top snare picks are real snares`);
    for (const c of top) assert.ok(c.start < c.anchor, "a snare fragment starts before its transient");
  }
});

test("sources: grid fragments start on the grid or on the transient right next to it, and are the right length", () => {
  const g = clean.analysis.grid;
  for (const [type, beats] of [["1/16", 0.25], ["1/8", 0.5], ["1/4", 1]]) {
    assert.ok(clean.pools[type].length > 0, `${type} pool is empty`);
    for (const c of clean.pools[type]) {
      const unit = beats * g.beat;
      const k = Math.round((c.gridStart - g.downbeat) / unit);
      assert.ok(Math.abs(c.gridStart - (g.downbeat + k * unit)) < 1e-6, `${type} off grid`);
      assert.ok(Math.abs(c.start - c.gridStart) <= 0.022, `${type} start pulled too far from the grid`);
      assert.ok(Math.abs(c.end - c.gridStart - unit) < 1e-6, `${type} wrong length`);
    }
  }
});

test("sources: bar ends and phrase ends score above mid-bar fragments", () => {
  const top = clean.pools["1/8"].slice(0, 5);
  assert.ok(top.filter((c) => /bar end|phrase end|into downbeat/.test(c.note)).length >= 3, top.map((c) => c.note).join(", "));
});

// ---------------------------------------------------------------------------
// Banks
// ---------------------------------------------------------------------------

test("bank: AUTO gives 8 varied results - several source types, characters and stretch amounts", () => {
  const recipes = bank(clean);
  assert.equal(recipes.length, 8);
  assert.ok(new Set(recipes.map((r) => r.source.type)).size >= 4, "source types");
  assert.ok(new Set(recipes.map((r) => r.passes[0].character)).size >= 6, "characters");
  assert.ok(new Set(recipes.map((r) => r.totalRatio)).size >= 4, "stretch amounts");
  for (let i = 1; i < recipes.length; i++) assert.ok(recipes[i].heat >= recipes[i - 1].heat, "mildest first");
  for (const r of recipes) for (const p of r.passes) assert.ok(CHARACTERS[p.character], `unknown character ${p.character}`);
});

test("bank: across a few banks there's reversing (both kinds) and pitching (both ways)", () => {
  const all = [1, 2, 3, 4, 5, 6].flatMap((seed) => bank(clean, { seed, count: 12 }));
  assert.ok(all.some((r) => r.reverse === "pre"));
  assert.ok(all.some((r) => r.reverse === "post"));
  assert.ok(all.some((r) => r.pitch < 0), "pitched down");
  assert.ok(all.some((r) => r.pitch > 0), "pitched up");
  assert.ok(all.some((r) => r.passes.length === 2), "some results are stretched twice");
});

test("bank: a range, not a level - every bank has something mild and something wrecked", () => {
  for (const seed of [1, 2, 3]) {
    const heats = bank(clean, { seed }).map((r) => r.heat);
    assert.ok(Math.max(...heats) - Math.min(...heats) >= 0.3, `heat range ${Math.min(...heats).toFixed(2)}-${Math.max(...heats).toFixed(2)}`);
  }
});

test("bank: MELT moves the whole bank - more stretch and hotter characters at 100 than at 0", () => {
  const avg = (list) => list.reduce((a, b) => a + b, 0) / list.length;
  const at = (melt) => [1, 2, 3, 4].flatMap((seed) => bank(clean, { melt, seed }));
  const cold = at(0);
  const hot = at(1);
  assert.ok(avg(hot.map((r) => Math.log(r.totalRatio))) > avg(cold.map((r) => Math.log(r.totalRatio))) + 0.3, "ratio");
  assert.ok(avg(hot.map((r) => CHARACTER_HEAT[r.passes[0].character] ?? 0.5)) > avg(cold.map((r) => CHARACTER_HEAT[r.passes[0].character] ?? 0.5)) + 0.1, "character heat");
});

test("bank: each SOURCE type is respected", () => {
  for (const { key } of SOURCE_TYPES.filter((s) => s.key !== "auto")) {
    const recipes = bank(clean, { sourceType: key });
    assert.ok(recipes.length === 8, key);
    for (const r of recipes) assert.equal(r.source.type, key);
  }
});

test("bank: CHARACTER flavours only use their own characters", () => {
  for (const f of FLAVOURS.filter((x) => x.chars)) {
    for (const r of bank(clean, { flavour: f.key })) assert.ok(f.chars.includes(r.passes[0].character), `${f.key}: ${r.passes[0].character}`);
  }
});

test("bank: a manual selection is used exactly as drawn, for every result", () => {
  const recipes = bank(clean, { manual: { start: 1.75, end: 2.1 } });
  assert.equal(recipes.length, 8);
  for (const r of recipes) {
    assert.equal(r.source.type, "manual");
    assert.equal(r.source.start, 1.75);
    assert.equal(r.source.end, 2.1);
  }
});

test("mutate: keeps the fragment, changes the processing, and is reproducible from its seed", () => {
  const [r] = bank(clean);
  const a = mutateRecipe(r, makeRng(77), 77);
  const b = mutateRecipe(r, makeRng(77), 77);
  assert.deepEqual(a, b);
  assert.deepEqual(a.source, r.source);
  const changed = a.totalRatio !== r.totalRatio || a.pitch !== r.pitch || a.reverse !== r.reverse || a.passes[0].character !== r.passes[0].character || JSON.stringify(a.drive) !== JSON.stringify(r.drive) || JSON.stringify(a.crunch) !== JSON.stringify(r.crunch);
  assert.ok(changed, "a mutation must change something audible");
  for (let seed = 1; seed < 30; seed++) {
    const m = mutateRecipe(r, makeRng(seed), seed);
    assert.ok(RATIO_LADDER.includes(m.totalRatio) || m.totalRatio >= 1.25, "ratio stays sane");
  }
});

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

test("render: every result of several banks is finite, below full scale, the right length, with quiet edges", () => {
  for (const ctx of [clean, messy]) {
    for (const seed of [1, 2]) {
      for (const recipe of bank(ctx, { seed, melt: seed === 1 ? 0.3 : 0.9 })) {
        const out = render(ctx, recipe);
        const { peak, finite } = stats(out.channels);
        assert.ok(finite, `${recipe.name}: non-finite samples`);
        assert.ok(peak <= 0.921, `${recipe.name}: peak ${peak.toFixed(3)}`);
        assert.ok(peak > 0.05, `${recipe.name}: came out near-silent`);
        const want = (recipe.source.end - recipe.source.start) * recipe.totalRatio;
        assert.ok(Math.abs(out.duration - want) / want < 0.2, `${recipe.name}: ${out.duration.toFixed(3)}s, wanted ~${want.toFixed(3)}s`);
        for (const ch of out.channels) {
          assert.ok(Math.abs(ch[0]) < 0.02 && Math.abs(ch[ch.length - 1]) < 0.02, `${recipe.name}: edge not faded`);
        }
        assert.equal(out.channels.length, 2, "stereo stays stereo");
      }
    }
  }
});

test("render: extreme melt - 16 results, nothing runs past the length cap, still clean", () => {
  const recipes = bank(clean, { count: 16, melt: 1, seed: 4 });
  assert.equal(recipes.length, 16);
  assert.ok(recipes.some((r) => r.totalRatio >= 8), "an extreme bank reaches 800%+");
  const t0 = Date.now();
  for (const recipe of recipes) {
    const out = render(clean, recipe);
    assert.ok(out.duration <= MAX_FX_SECONDS + 0.5, `${recipe.name}: ${out.duration.toFixed(1)}s`);
    const { peak, finite } = stats(out.channels);
    assert.ok(finite && peak <= 0.921);
  }
  assert.ok(Date.now() - t0 < 30000, "a 16-bank at full melt renders in reasonable time");
});

test("render: stretch-then-reverse ends on the transient; reverse-then-stretch doesn't start on it", () => {
  const [base] = bank(clean, { sourceType: "snare" });
  const energyHalves = (out) => {
    const ch = out.channels[0];
    const h = Math.floor(ch.length / 2);
    let a = 0;
    let b = 0;
    for (let i = 0; i < h; i++) a += ch[i] * ch[i];
    for (let i = h; i < ch.length; i++) b += ch[i] * ch[i];
    return { a, b };
  };
  const recipe = { ...base, pitch: 0, drive: null, crunch: null, passes: [{ character: "cyclic", ratio: 3, macroValues: {} }], totalRatio: 3 };
  const fwd = energyHalves(render(clean, { ...recipe, reverse: "none" }));
  const post = energyHalves(render(clean, { ...recipe, reverse: "post" }));
  assert.ok(fwd.a > fwd.b, "forward: loud start");
  assert.ok(post.b > post.a, "post-reversed: loud end (the suck into the hit)");
});

test("render: a forward result keeps its transient - it's loud within the first few ms", () => {
  const [recipe] = bank(clean, { sourceType: "snare", melt: 0 });
  const out = render(clean, { ...recipe, reverse: "none" });
  const ch = out.channels[0];
  const early = Math.round(0.02 * clean.brk.sampleRate);
  let peakEarly = 0;
  for (let i = 0; i < early; i++) peakEarly = Math.max(peakEarly, Math.abs(ch[i]));
  assert.ok(peakEarly > stats(out.channels).peak * 0.3, `first 20ms peak ${peakEarly.toFixed(3)}`);
});

// ---------------------------------------------------------------------------
// Snap Back
// ---------------------------------------------------------------------------

test("snap back: lead-in from a bar line, stretch in place, return on a grid line with the break's own audio", () => {
  const g = clean.analysis.grid;
  const sr = clean.brk.sampleRate;
  for (const recipe of bank(clean, { seed: 3 })) {
    const fx = render(clean, recipe);
    const sb = renderSnapBack({ channels: clean.brk.channels, sampleRate: sr, grid: g, source: recipe.source, fx: fx.channels });
    // The lead-in starts on a bar line at least two beats before the fragment.
    const preStart = recipe.source.start - sb.fxStart;
    const barPhase = (((preStart - g.downbeat) / g.bar) % 1 + 1) % 1;
    assert.ok(Math.min(barPhase, 1 - barPhase) < 0.002, `lead-in starts off the bar (${barPhase.toFixed(4)})`);
    assert.ok(sb.fxStart >= 2 * g.beat - 0.01, "at least two beats of break before the stretch");
    // The return is on a beat line (in break time), within 3ms pre-roll.
    const returnTime = recipe.source.start + (sb.returnAt - sb.fxStart) + 0.003;
    const beatPhase = (((returnTime - g.downbeat) / g.beat) % 1 + 1) % 1;
    assert.ok(Math.min(beatPhase, 1 - beatPhase) < 0.01, `return off the beat (${beatPhase.toFixed(4)})`);
    // At most a fifth of a beat of the result is sacrificed to make the line.
    assert.ok(sb.returnAt - sb.fxStart >= fx.duration - 0.2 * g.beat - 0.005, "too much of the stretch was cut");
    // After the return it IS the break: compare against the source at the same (looped) position.
    const loopLen = g.loopEnd - g.loopStart;
    const srcT = g.loopStart + ((((returnTime - 0.003 - g.loopStart) % loopLen) + loopLen) % loopLen);
    const s0 = Math.round(srcT * sr);
    const o0 = Math.round(sb.returnAt * sr);
    // The return time is rebuilt here from rounded sample counts, so allow a one-sample alignment slip.
    const diff = alignedDiff(sb.channels[0], o0 + Math.round(0.01 * sr), clean.brk.channels[0], s0 + Math.round(0.01 * sr), Math.round(0.04 * sr));
    assert.ok(diff < 1e-4, `returned audio isn't the break (max diff ${diff})`);
    const { finite, peak } = stats(sb.channels);
    assert.ok(finite && peak <= 1);
  }
});

test("snap back: no clicks at the joins", () => {
  const sr = clean.brk.sampleRate;
  const w = Math.round(0.004 * sr);
  for (const recipe of bank(clean, { seed: 5 })) {
    const fx = render(clean, recipe);
    const sb = renderSnapBack({ channels: clean.brk.channels, sampleRate: sr, grid: clean.analysis.grid, source: recipe.source, fx: fx.channels });
    const a = Math.round(sb.fxStart * sr);
    const b = Math.round(sb.returnAt * sr);
    // A click is a jump far bigger than the audio's own movement around it.
    const joinA = maxJump(sb.channels, a - 2, a + 2);
    const joinB = maxJump(sb.channels, b - 2, b + 2);
    const around = maxJump(sb.channels, a - w, a + w) + maxJump(sb.channels, b - w, b + w);
    assert.ok(joinA < 0.25 && joinB < 0.25, `${recipe.name}: join jumps ${joinA.toFixed(3)} / ${joinB.toFixed(3)} (local ${around.toFixed(3)})`);
  }
});

test("snap back: a lead-in before the start of the file wraps round the loop", () => {
  const [recipe] = bank(clean, { manual: { start: 0.35, end: 0.6 } });
  const fx = render(clean, recipe);
  const sb = renderSnapBack({ channels: clean.brk.channels, sampleRate: clean.brk.sampleRate, grid: clean.analysis.grid, source: recipe.source, fx: fx.channels });
  assert.ok(sb.fxStart > 0.6, "lead-in exists even for a fragment near 0:00");
  // The first bar of the lead-in is the break's LAST bar (bar 1 of the grid may sit a hair before 0:00,
  // so "the last bar" is measured from the wrapped lead-in start, not from the end of the file).
  const g = clean.analysis.grid;
  const sr = clean.brk.sampleRate;
  const preStart = recipe.source.start - sb.fxStart;
  assert.ok(preStart < 0, "this fragment's lead-in really does start before the file");
  const loopLen = g.loopEnd - g.loopStart;
  const wrapped = g.loopStart + ((((preStart - g.loopStart) % loopLen) + loopLen) % loopLen);
  assert.ok(wrapped > g.loopEnd - g.bar - 0.01, "wrapped into the last bar");
  const diff = alignedDiff(sb.channels[0], Math.round(0.05 * sr), clean.brk.channels[0], Math.round((wrapped + 0.05) * sr), 1000);
  assert.ok(diff < 1e-3, `lead-in didn't come from the end of the loop (diff ${diff})`);
});

test("tempo octave: a jungle break read at half time is flagged at its real tempo; a right reading is left alone", () => {
  const a = setup({}, null).analysis;
  assert.equal(snareTempoOctave(a.hits, 85), 170, "85 read of a 170 break");
  assert.equal(snareTempoOctave(a.hits, 170), 170, "correct reading kept");
  const slow = makeBreak({ bpm: 85, bars: 4 });
  const sa = analyseBreak({ mono: toMono(slow.channels), sampleRate: slow.sampleRate, bpm: null });
  assert.equal(snareTempoOctave(sa.hits, 85), 85, "a genuine 85 BPM break isn't doubled");
});

// ---------------------------------------------------------------------------
// Awkward breaks
// ---------------------------------------------------------------------------

test("no tempo: grid is a labelled guess and Snap Back doesn't pretend to know the beat", () => {
  const ctx = setup({}, null);
  assert.ok(ctx.analysis.grid.assumed);
  const recipes = bank(ctx);
  assert.equal(recipes.length, 8);
  const fx = render(ctx, recipes[0]);
  const sb = renderSnapBack({ channels: ctx.brk.channels, sampleRate: ctx.brk.sampleRate, grid: ctx.analysis.grid, source: recipes[0].source, fx: fx.channels });
  assert.ok(Math.abs(sb.fxStart - 1.5) < 0.01, "flat 1.5s lead-in");
  assert.ok(Math.abs(sb.returnAt - sb.fxStart - fx.duration) < 0.01, "returns when the result ends");
});

test("short breaks: a one-bar break that opens on its kick has bar 1 at 0:00, messy or not", () => {
  for (const messy of [false, true]) {
    const brk = makeBreak({ bars: 1, messy, seed: 9 });
    const g = analyseBreak({ mono: toMono(brk.channels), sampleRate: brk.sampleRate, bpm: 170 }).grid;
    assert.ok(Math.abs(g.downbeat) < 0.01, `messy=${messy}: downbeat ${g.downbeat.toFixed(3)}`);
    assert.equal(g.loopBars, 1);
  }
});

test("short breaks: one bar and half a bar still make a full bank", () => {
  for (const bars of [1, 0.5]) {
    const brk = makeBreak({ bars: Math.max(1, bars) });
    const n = Math.round(brk.channels[0].length * bars);
    const channels = brk.channels.map((ch) => ch.slice(0, n));
    const mono = toMono(channels);
    const analysis = analyseBreak({ mono, sampleRate: brk.sampleRate, bpm: 170 });
    const pools = buildSourcePools(analysis, mono, brk.sampleRate);
    const ctx = { brk: { ...brk, channels }, analysis, pools };
    const recipes = bank(ctx);
    assert.equal(recipes.length, 8, `${bars} bar`);
    for (const r of recipes.slice(0, 3)) {
      const fx = render(ctx, r);
      const sb = renderSnapBack({ channels, sampleRate: brk.sampleRate, grid: analysis.grid, source: r.source, fx: fx.channels });
      assert.ok(stats(sb.channels).finite);
      assert.ok(sb.duration > fx.duration * 0.8);
    }
  }
});

test("long break: 32 bars analyse quickly and a bank spreads across it", () => {
  const t0 = Date.now();
  const ctx = setup({ bars: 32, seed: 11 });
  const ms = Date.now() - t0;
  assert.ok(ms < 8000, `analysis took ${ms}ms`);
  assert.equal(ctx.analysis.grid.loopBars, 32);
  const recipes = bank(ctx, { count: 12 });
  const starts = recipes.map((r) => r.source.start);
  assert.ok(Math.max(...starts) - Math.min(...starts) > 10, "fragments come from across the whole break");
});

test("mono and silence: mono renders mono; silence yields an empty bank, not a crash", () => {
  const mono = setup({ stereo: false });
  const [r] = bank(mono);
  assert.equal(render(mono, r).channels.length, 1);
  const silent = new Float32Array(44100 * 2);
  const analysis = analyseBreak({ mono: silent, sampleRate: 44100, bpm: 170 });
  const pools = buildSourcePools(analysis, silent, 44100);
  assert.deepEqual(bank({ analysis, pools }), []);
  assert.equal(pickSource(pools, "snare", analysis.grid, makeRng(1)), null);
});

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

test("naming: breakname_stretch_<source>_<percent>[_rev][_pitch].wav", () => {
  const base = { source: { type: "snare" }, totalRatio: 3, reverse: "none", pitch: 0 };
  assert.equal(fxFileName("amen.wav", base), "amen_stretch_snare_300.wav");
  assert.equal(fxFileName("amen.wav", { ...base, source: { type: "1/8" }, totalRatio: 6, reverse: "pre" }), "amen_stretch_1-8_600_rev.wav");
  assert.equal(fxFileName("amen.wav", { ...base, source: { type: "hit" }, totalRatio: 4, reverse: "post", pitch: -12 }), "amen_stretch_hit_400_revpost_dn12.wav");
  assert.equal(fxFileName("my break.aif", { ...base, source: manualSource(0, 1), totalRatio: 1.5, pitch: 7 }), "my break_stretch_sel_150_up7.wav");
  assert.equal(fxFolderName("amen.wav"), "amen_STRETCH_FX");
  assert.ok(gridPosition(clean.analysis.grid, clean.analysis.grid.downbeat + clean.analysis.grid.beat).text === "1.2.1");
});

console.log(`\n${passed} passed`);
