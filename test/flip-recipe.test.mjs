// Node-side unit tests for FLIP's decision layer - slice-map, hierarchy, recipe, operations,
// styles, pitch-plan and diversity. Nothing here touches audio (see flip-render.test.mjs).
//
// These assert the MUSICAL properties, not the code paths, because the failure mode this feature
// actually has is "it works and sounds like a glitch plugin". So: does Gentle really leave material
// alone, does Fill really concentrate at boundaries, does Phrase really differ structurally from
// Cut-up, does pitch really stay in key, and does a batch really contain different ideas.
// Run with: node test/flip-recipe.test.mjs
import assert from "node:assert/strict";
import { createSliceMap, sliceMapReadiness, describeSliceMap, metricStrength, chopLabel, SUBDIVISIONS, MIN_SLICES } from "../js/flip/slice-map.js";
import { buildHierarchy, availableLevels, levelSpan, nodesAtLevel, positionAppeal, LEVELS } from "../js/flip/hierarchy.js";
import { generateRecipe, describeRecipe, recipePattern, recipeDeparture, isIdentityRecipe, identitySteps } from "../js/flip/recipe.js";
import { OPERATIONS, operationByKey, operationKeys, FAMILIES } from "../js/flip/operations.js";
import { STYLES, resolveStyle, styleKeys, DEFAULT_STYLE } from "../js/flip/styles.js";
import { pitchCandidates, choosePitch, melodicPattern, scaleDegreeOffsets, resolveKey, SCALE_INTERVALS, PITCH_MODES } from "../js/flip/pitch-plan.js";
import { PROFILES, profilesForBatch, profileByKey } from "../js/flip/diversity.js";
import { PRESETS, DEFAULT_SETTINGS, matchPreset } from "../js/flip/presets.js";
import { makeRng } from "../js/dsp/stretch/rng.js";

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
const KEY = { root: "A", mode: "minor", known: true };

/** A clean four-bar loop at 120 BPM - the shape FLIP is designed around. */
const loopMap = (subdivision = "1/16", bpm = 120, bars = 4) =>
  createSliceMap({ totalSamples: Math.round(((bars * 4 * 60) / bpm) * SR), sampleRate: SR, bpm, subdivision });

/** Generate with FLIP's own defaults unless a test says otherwise. */
const gen = (map, over = {}) => generateRecipe({ map, style: "mixed", structure: 65, activity: 45, depth: 50, rollAmount: 35, pitchMode: "inkey", pitchAmount: 20, key: KEY, seed: 1, ...over });

/** Averages over a spread of seeds - every behavioural claim here is statistical. */
function sample(map, over, fn, takes = 60) {
  let total = 0;
  for (let seed = 1; seed <= takes; seed++) total += fn(gen(map, { ...over, seed: seed * 104729 }));
  return total / takes;
}

// --- slice map -------------------------------------------------------------------------------

test("createSliceMap: boundaries tile the whole source with no gaps, no overlap, no leftover", () => {
  for (const sub of SUBDIVISIONS) {
    const total = 191237; // deliberately awkward, so this can't pass by the numbers dividing
    const map = createSliceMap({ totalSamples: total, sampleRate: SR, bpm: 93.7, subdivision: sub.key });
    assert.equal(map.slices[0].startSample, 0);
    assert.equal(map.slices[map.count - 1].endSample, total);
    let covered = 0;
    for (let i = 0; i < map.count; i++) {
      if (i > 0) assert.equal(map.slices[i].startSample, map.slices[i - 1].endSample, `${sub.key}: slice ${i} joins ${i - 1}`);
      covered += map.slices[i].length;
    }
    assert.equal(covered, total, `${sub.key}: slices sum to the source length exactly`);
  }
});

test("createSliceMap: prefers a whole number of bars when the detected tempo is slightly off", () => {
  const map = createSliceMap({ totalSamples: Math.round(8 * SR), sampleRate: SR, bpm: 119.87, subdivision: "1/16" });
  assert.equal(map.count, 64);
  assert.equal(map.fit.aligned, "bar");
});

test("createSliceMap: says so when no musical count is within reach of the detected tempo", () => {
  const map = createSliceMap({ totalSamples: Math.round(5.644 * SR), sampleRate: SR, bpm: 132.51, subdivision: "1/16" });
  assert.equal(map.fit.aligned, "slice");
  assert.match(sliceMapReadiness(map).warning, /not a whole number/);
  // ...and correcting the tempo by hand snaps it back onto the bar.
  const fixed = createSliceMap({ totalSamples: Math.round(5.644 * SR), sampleRate: SR, bpm: 85, subdivision: "1/16" });
  assert.equal(fixed.fit.aligned, "bar");
  assert.equal(sliceMapReadiness(fixed).warning, null);
});

test("sliceMapReadiness: refuses audio too short, and only suggests a finer grid when one would help", () => {
  const tiny = createSliceMap({ totalSamples: Math.round(0.15 * SR), sampleRate: SR, bpm: 120, subdivision: "1/16" });
  assert.equal(sliceMapReadiness(tiny).ok, false);
  assert.ok(tiny.count < MIN_SLICES);
  assert.doesNotMatch(sliceMapReadiness(tiny).reason, /Try 1\//);
  const shortish = createSliceMap({ totalSamples: Math.round(0.6 * SR), sampleRate: SR, bpm: 120, subdivision: "1/4" });
  assert.match(sliceMapReadiness(shortish).reason, /Try 1\/16/);
});

test("metricStrength: downbeat beats beat 3 beats other beats beats off-beats", () => {
  // (sliceIndex, slicesPerBeat, slicesPerBar) - a 1/16 grid in 4/4.
  assert.ok(metricStrength(0, 4, 16) > metricStrength(8, 4, 16));
  assert.ok(metricStrength(8, 4, 16) > metricStrength(4, 4, 16));
  assert.ok(metricStrength(4, 4, 16) > metricStrength(1, 4, 16));
  // At whole-bar chops every chop IS a downbeat, and the function should say so rather than
  // inventing off-beats that cannot exist at that grid.
  assert.equal(metricStrength(3, 1, 1), 1);
});

test("chop size: the grid can be coarser than a beat, which is what allows whole-bar movement", () => {
  const eightBars = (key) => createSliceMap({ totalSamples: Math.round(16 * SR), sampleRate: SR, bpm: 120, subdivision: key });
  assert.equal(eightBars("1bar").count, 8, "8 bars in whole-bar chops is 8 chops");
  assert.equal(eightBars("1/2bar").count, 16);
  assert.equal(eightBars("1/4").count, 32);
  assert.equal(eightBars("1/16").count, 128);
  for (const sub of SUBDIVISIONS) {
    const map = eightBars(sub.key);
    assert.equal(map.fit.aligned, "bar", `${sub.label}: lands on the bar line`);
    assert.equal(map.perBar, sub.slicesPerBar, `${sub.label}: perBar is what was asked for`);
    assert.ok(map.perBeat >= 1, `${sub.label}: slices-per-beat never goes below one chop`);
    assert.ok(Math.abs(map.bars - 8) < 0.01, `${sub.label}: still eight bars`);
  }
  // At whole-bar chops the smallest thing that can move IS a bar.
  const coarse = eightBars("1bar");
  assert.equal(levelSpan(coarse, "bar"), 1);
  assert.ok(!availableLevels(coarse).includes("halfBeat"), "no half-beats exist at this grid");
});

test("describeSliceMap: one readable line", () => {
  assert.equal(describeSliceMap(loopMap("1/16")), "4 bars · 64 × 1/16 · 120 BPM");
  assert.equal(describeSliceMap(loopMap("1/2bar")), "4 bars · 8 × ½ bar · 120 BPM");
  assert.equal(chopLabel(loopMap("1bar")), "1 bar");
});

// --- hierarchy -------------------------------------------------------------------------------

test("hierarchy: a four-bar loop resolves into phrase, bars, half-bars, beats and below", () => {
  const map = loopMap("1/16");
  assert.deepEqual(availableLevels(map), ["phrase", "bar", "halfBar", "beat", "halfBeat", "slice", "micro"]);
  assert.equal(levelSpan(map, "bar"), 16);
  assert.equal(levelSpan(map, "halfBar"), 8);
  assert.equal(levelSpan(map, "beat"), 4);
  assert.equal(levelSpan(map, "halfBeat"), 2);
  const hier = buildHierarchy(map);
  assert.equal(hier.levels.bar.length, 4);
  assert.equal(hier.levels.beat.length, 16);
  assert.equal(hier.childrenOf(hier.levels.bar[1], "beat").length, 4);
});

test("hierarchy: nodes tile their level with no gaps, at every subdivision", () => {
  for (const sub of SUBDIVISIONS) {
    const map = loopMap(sub.key);
    for (const level of LEVELS) {
      const nodes = nodesAtLevel(map, level);
      if (!nodes.length) continue;
      assert.equal(nodes[0].start, 0, `${sub.key}/${level}: starts at 0`);
      assert.equal(nodes[nodes.length - 1].end, map.count, `${sub.key}/${level}: ends at the end`);
      for (let i = 1; i < nodes.length; i++) assert.equal(nodes[i].start, nodes[i - 1].end, `${sub.key}/${level}: node ${i} joins ${i - 1}`);
    }
  }
});

test("hierarchy: a coarse grid honestly reports the levels it hasn't got", () => {
  const map = loopMap("1/4");
  assert.equal(levelSpan(map, "halfBeat"), 0, "a quarter-note grid has no half-beats");
  assert.ok(!availableLevels(map).includes("halfBeat"));
});

test("hierarchy: nodes know where they sit, and positionAppeal reads it", () => {
  const map = loopMap("1/16");
  const beats = nodesAtLevel(map, "beat");
  assert.equal(beats[0].isDownbeat, true);
  assert.equal(beats[3].endsBar, true, "the fourth beat ends its bar");
  assert.equal(beats[beats.length - 1].endsPhrase, true);
  const bias = { endOfBar: 4, endOfPhrase: 6 };
  assert.ok(positionAppeal(beats[3], bias) > positionAppeal(beats[1], bias));
  assert.ok(positionAppeal(beats[beats.length - 1], bias) > positionAppeal(beats[3], bias));
  assert.equal(positionAppeal(beats[1], null), 1, "no bias means no preference");
});

// --- the three controls ----------------------------------------------------------------------

test("ACTIVITY controls how much of the loop is touched, and nothing else has to", () => {
  const map = loopMap("1/16");
  const at = (activity) => sample(map, { activity, structure: 65, depth: 50 }, recipeDeparture);
  const low = at(10);
  const mid = at(50);
  const high = at(95);
  assert.ok(low < mid && mid < high, `monotonic: ${low.toFixed(3)} < ${mid.toFixed(3)} < ${high.toFixed(3)}`);
  assert.ok(low < 0.2, `low activity should leave most of the loop alone, got ${low.toFixed(3)}`);
});

test("RESTRAINT: at low activity, whole bars come back untouched", () => {
  const map = loopMap("1/16");
  const untouchedBars = (activity, from = 0) =>
    sample(map, { activity }, (r) => {
      const bars = r.plan.bars.slice(from);
      return bars.filter((b) => b.treatment === "untouched").length / bars.length;
    });
  const low = untouchedBars(15);
  const high = untouchedBars(95);
  assert.ok(low > 0.5, `at activity 15 most bars should be untouched, got ${(low * 100).toFixed(0)}%`);
  assert.ok(low > high, `and fewer should survive at 95 (${(high * 100).toFixed(0)}%)`);

  // The opening is measured separately and held to a lower bar on purpose. Relocating where the
  // loop starts is a deliberate, frequent move - eight variations that all begin identically read
  // as one result - so bar 1 is "touched" far more often than the rest. Restraint is a claim about
  // the body of the phrase.
  const body = untouchedBars(15, 1);
  assert.ok(body > 0.6, `away from the opening, bars should mostly survive at activity 15, got ${(body * 100).toFixed(0)}%`);
});

test("DEPTH controls how far an intervention goes, not how many there are", () => {
  const map = loopMap("1/16");
  // Micro-level work - stutters, subdivisions - is the signature of a deep intervention.
  const micro = (depth) => sample(map, { depth, activity: 60 }, (r) => r.steps.filter((s) => s.stutter).length);
  assert.ok(micro(15) < micro(90), `deep settings should subdivide more: ${micro(15).toFixed(2)} vs ${micro(90).toFixed(2)}`);
  // ...while the number of bars it visits stays roughly put.
  const touched = (depth) => sample(map, { depth, activity: 60 }, (r) => r.plan.bars.filter((b) => b.treatment === "edited").length);
  assert.ok(Math.abs(touched(15) - touched(90)) < 1.2, `depth shouldn't drive how many bars are visited: ${touched(15).toFixed(2)} vs ${touched(90).toFixed(2)}`);
});

test("STRUCTURE controls whether the large-scale shape survives", () => {
  const map = loopMap("1/16");
  // A downbeat slot still carrying intact downbeat material is the measurable form of "the
  // structure survived" - a bar whose downbeat was replaced by another bar's downbeat still lands.
  const survival = (structure) =>
    sample(map, { structure, activity: 70, depth: 60 }, (r) => {
      let intact = 0;
      let total = 0;
      for (let i = 0; i < r.steps.length; i++) {
        if (!map.slices[i].isDownbeat) continue;
        total++;
        const source = map.slices[r.steps[i].src];
        const step = r.steps[i];
        if (source && source.isDownbeat && !step.reverse && !step.silent && !step.stutter) intact++;
      }
      return intact / total;
    });
  const high = survival(95);
  const low = survival(5);
  assert.ok(high > low + 0.12, `high structure should preserve downbeats far better: ${high.toFixed(3)} vs ${low.toFixed(3)}`);
  assert.ok(high > 0.75, `at structure 95 downbeats should mostly survive, got ${high.toFixed(3)}`);
});

test("the three controls are independent - Structure 85 / Activity 25 / Depth 75 is expressible", () => {
  const map = loopMap("1/16");
  const departure = sample(map, { structure: 85, activity: 25, depth: 75 }, recipeDeparture);
  const untouched = sample(map, { structure: 85, activity: 25, depth: 75 }, (r) => r.plan.bars.filter((b) => b.treatment === "untouched").length / r.plan.bars.length);
  assert.ok(departure < 0.35, `mostly left alone, got ${departure.toFixed(3)} changed`);
  assert.ok(untouched > 0.4, `with whole bars surviving, got ${(untouched * 100).toFixed(0)}%`);
  // ...and yet what it does do is not timid.
  const deep = sample(map, { structure: 85, activity: 25, depth: 75 }, (r) => r.steps.filter((s) => s.stutter || s.reverse).length);
  const shallow = sample(map, { structure: 85, activity: 25, depth: 10 }, (r) => r.steps.filter((s) => s.stutter || s.reverse).length);
  assert.ok(deep > shallow, `the interventions it does make should be bolder: ${deep.toFixed(2)} vs ${shallow.toFixed(2)}`);
});

// --- hierarchical behaviour ------------------------------------------------------------------

test("edits happen at MULTIPLE scales, not all at one size", () => {
  const map = loopMap("1/16");
  const levels = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    for (const edit of gen(map, { seed: seed * 104729, activity: 70 }).edits) if (edit.level) levels.add(edit.level);
  }
  assert.ok(levels.size >= 4, `expected edits at several scales, saw ${[...levels].join(",")}`);
});

test("PHRASE works coarse and CUT-UP works fine - the types differ structurally, not cosmetically", () => {
  const map = loopMap("1/16");
  const coarseShare = (style) =>
    sample(map, { style, activity: 70 }, (r) => {
      const edits = r.edits.filter((e) => e.level && e.level !== "phrase");
      if (!edits.length) return 0;
      return edits.filter((e) => e.level === "bar" || e.level === "halfBar").length / edits.length;
    });
  const phrase = coarseShare("phrase");
  const cutup = coarseShare("cutup");
  assert.ok(phrase > 0.4, `Phrase should work mostly at bar and half-bar, got ${(phrase * 100).toFixed(0)}%`);
  assert.ok(cutup < 0.25, `Cut-up should mostly not, got ${(cutup * 100).toFixed(0)}%`);
  // And the micro end is the mirror image.
  const micro = (style) => sample(map, { style, activity: 70 }, (r) => r.steps.filter((s) => s.stutter).length);
  assert.ok(micro("cutup") > micro("phrase") * 2, `Cut-up should subdivide far more: ${micro("cutup").toFixed(2)} vs ${micro("phrase").toFixed(2)}`);
});

test("GENTLE leaves significant material untouched; WILD does not", () => {
  const map = loopMap("1/16");
  const gentle = sample(map, { style: "gentle" }, recipeDeparture);
  const wild = sample(map, { style: "wild" }, recipeDeparture);
  assert.ok(gentle < 0.2, `Gentle should leave most of the loop alone, got ${(gentle * 100).toFixed(0)}% changed`);
  assert.ok(wild > gentle * 2, `Wild should go much further, got ${(wild * 100).toFixed(0)}%`);
  const gentleUntouched = sample(map, { style: "gentle" }, (r) => r.plan.bars.filter((b) => b.treatment === "untouched").length / r.plan.bars.length);
  assert.ok(gentleUntouched > 0.5, `Gentle should leave whole bars alone, got ${(gentleUntouched * 100).toFixed(0)}%`);
});

test("FILL concentrates its work at the ends of bars and the end of the phrase", () => {
  const map = loopMap("1/16");
  const lateShare = (style) =>
    sample(map, { style, activity: 60, rollAmount: 60 }, (r) => {
      const edits = r.edits.filter((e) => e.level && e.level !== "phrase" && e.op !== "pitch");
      if (!edits.length) return 0;
      // "Late" meaning the back half of whatever bar it is in - where a fill belongs.
      const late = edits.filter((e) => e.at % map.perBar >= map.perBar / 2).length;
      return late / edits.length;
    });
  const fill = lateShare("fill");
  const reconstruct = lateShare("reconstruct");
  assert.ok(fill > 0.6, `Fill should work in the back half of bars, got ${(fill * 100).toFixed(0)}%`);
  assert.ok(fill > reconstruct + 0.15, `...much more than a type with no positional preference (${(reconstruct * 100).toFixed(0)}%)`);
});

test("REPEATER repeats rather than stutters", () => {
  const map = loopMap("1/16");
  const repeats = sample(map, { style: "repeater", activity: 70 }, (r) => r.edits.filter((e) => /repeat|aba|motif/.test(e.op)).length);
  const stutters = sample(map, { style: "repeater", activity: 70 }, (r) => r.steps.filter((s) => s.stutter).length);
  assert.ok(repeats > 1, `Repeater should repeat things, got ${repeats.toFixed(2)} per variation`);
  assert.ok(repeats > stutters, `...more than it stutters (${stutters.toFixed(2)})`);
});

// --- rolls -----------------------------------------------------------------------------------

test("ROLL: the amount control drives how many rolls appear, and 0 means none", () => {
  const map = loopMap("1/16");
  const rolls = (rollAmount) => sample(map, { rollAmount, style: "mixed" }, (r) => r.edits.filter((e) => e.op === "roll").length);
  assert.equal(rolls(0), 0, "Rolls at 0 must produce none");
  assert.ok(rolls(35) > 0, "the default should produce some");
  assert.ok(rolls(100) > rolls(35), `and more at 100: ${rolls(100).toFixed(2)} vs ${rolls(35).toFixed(2)}`);
});

test("ROLL: produces an actual rapid repetition, not a scattering of unrelated slices", () => {
  const map = loopMap("1/16");
  let checked = 0;
  for (let seed = 1; seed <= 120; seed++) {
    const recipe = gen(map, { seed: seed * 104729, rollAmount: 100, style: "fill" });
    for (const edit of recipe.edits.filter((e) => e.op === "roll")) {
      checked++;
      const slots = recipe.steps.slice(edit.at, edit.at + edit.span);
      // Either every slot is subdivided (a rate finer than the grid), or they cycle through one
      // short group of sources (a rate coarser than it). Both are a roll; neither is random.
      const subdivided = slots.every((s) => s.stutter >= 2);
      const sources = new Set(slots.map((s) => s.src));
      assert.ok(subdivided || sources.size <= Math.ceil(edit.span / 2), `roll at ${edit.at} is neither subdivided nor cyclic: ${slots.map((s) => s.src).join(",")}`);
    }
  }
  assert.ok(checked > 40, `expected plenty of rolls to inspect, got ${checked}`);
});

test("ROLL: FILL puts them at musically strategic positions far more than WILD does", () => {
  const map = loopMap("1/16");
  const atBarEnds = (style) => {
    let ends = 0;
    let total = 0;
    for (let seed = 1; seed <= 90; seed++) {
      for (const edit of gen(map, { seed: seed * 104729, style, rollAmount: 80 }).edits.filter((e) => e.op === "roll")) {
        total++;
        if ((edit.at + edit.span) % map.perBar === 0) ends++;
      }
    }
    return total ? ends / total : 0;
  };
  const fill = atBarEnds("fill");
  const wild = atBarEnds("wild");
  assert.ok(fill > 0.5, `Fill's rolls should land on bar ends, got ${(fill * 100).toFixed(0)}%`);
  assert.ok(fill > wild, `...more than Wild's (${(wild * 100).toFixed(0)}%)`);
});

// --- pitch -----------------------------------------------------------------------------------

test("pitch-plan: scale degrees are real intervals of the chosen mode", () => {
  for (const mode of ["major", "minor"]) {
    const intervals = SCALE_INTERVALS[mode];
    for (const { degree, semitones } of scaleDegreeOffsets(mode, 7)) {
      const within = ((semitones % 12) + 12) % 12;
      assert.ok(intervals.includes(within), `${mode} degree ${degree} -> ${semitones} is not in the scale`);
    }
  }
});

test("PITCH OFF applies no transposition at all, whatever the amount says", () => {
  const map = loopMap("1/16");
  const pitched = sample(map, { pitchMode: "off", pitchAmount: 100, activity: 90, depth: 90 }, (r) => r.steps.filter((s) => s.pitch).length);
  assert.equal(pitched, 0);
});

test("PITCH: every transposition stays in the detected key", () => {
  const map = loopMap("1/16");
  const allowed = new Set(SCALE_INTERVALS.minor);
  for (let seed = 1; seed <= 120; seed++) {
    const recipe = gen(map, { seed: seed * 104729, pitchMode: "inkey", pitchAmount: 90, depth: 90 });
    for (const step of recipe.steps) {
      if (!step.pitch) continue;
      const within = ((step.pitch % 12) + 12) % 12;
      assert.ok(allowed.has(within), `seed ${seed}: ${step.pitch} semitones is outside A minor`);
    }
  }
});

test("PITCH OCTAVES only ever moves by octaves", () => {
  const map = loopMap("1/16");
  for (let seed = 1; seed <= 90; seed++) {
    for (const step of gen(map, { seed: seed * 104729, pitchMode: "octaves", pitchAmount: 90, depth: 95 }).steps) {
      if (!step.pitch) continue;
      assert.equal(Math.abs(step.pitch) % 12, 0, `${step.pitch} is not an octave`);
    }
  }
});

test("PITCH amount controls how much of the loop is transposed, and pitch stays a minority", () => {
  const map = loopMap("1/16");
  const share = (pitchAmount) => sample(map, { pitchAmount, activity: 60 }, (r) => r.steps.filter((s) => s.pitch).length / r.steps.length);
  assert.equal(share(0), 0);
  assert.ok(share(20) > 0, "the default should do something");
  assert.ok(share(20) < 0.35, `...but not infect the loop, got ${(share(20) * 100).toFixed(0)}%`);
  assert.ok(share(90) > share(20), `and more at 90: ${(share(90) * 100).toFixed(0)}%`);
});

test("PITCH: transposition covers musical spans, not arbitrary isolated slices", () => {
  // Measured as "is this transposed slice part of a transposed SPAN" rather than "is it inside a
  // repeat", because a whole bar moved down a third is a legitimate target that belongs to no
  // repetition at all - and it is one of the most musical things FLIP does. What must not happen is
  // single slices transposed on their own, which read as wrong notes rather than as an idea.
  const map = loopMap("1/16");
  let inSpan = 0;
  let isolated = 0;
  for (let seed = 1; seed <= 90; seed++) {
    const steps = gen(map, { seed: seed * 104729, pitchAmount: 70 }).steps;
    steps.forEach((step, i) => {
      if (!step.pitch) return;
      const prev = steps[i - 1];
      const next = steps[i + 1];
      const joined = (prev && prev.pitch === step.pitch) || (next && next.pitch === step.pitch);
      // A roll that rises through the scale gives every slot its own pitch by design, so a slice
      // inside a roll counts as part of a span even when its neighbours differ.
      const inRoll = step.op === "roll";
      if (joined || inRoll) inSpan++;
      else isolated++;
    });
  }
  const total = inSpan + isolated;
  assert.ok(total > 200, `expected plenty of transposed slices to inspect, got ${total}`);
  assert.ok(inSpan / total > 0.85, `pitch should cover spans: ${((inSpan / total) * 100).toFixed(0)}% were part of one`);
});

test("melodicPattern: a repeated fragment gets a shape, and the first repetition is the original", () => {
  const rng = makeRng(3);
  const candidates = pitchCandidates({ mode: "minor", pitchMode: "inkey", depth: 0.6 });
  for (let i = 0; i < 20; i++) {
    const pattern = melodicPattern(rng, 4, candidates, { depth: 0.6 });
    assert.equal(pattern.length, 4);
    assert.equal(pattern[0], 0, "a pattern starts from the material as it is");
    assert.ok(pattern.some((p) => p !== 0), "and then does something");
  }
  assert.deepEqual(melodicPattern(rng, 1, candidates), [0], "nothing to shape across one repetition");
});

test("pitch is deterministic for a given key, and the mode decides which notes are available", () => {
  const map = loopMap("1/16");
  const a = gen(map, { seed: 42, pitchAmount: 80, key: { root: "A", mode: "minor", known: true } });
  const b = gen(map, { seed: 42, pitchAmount: 80, key: { root: "A", mode: "minor", known: true } });
  assert.deepEqual(a.steps, b.steps, "same key, same seed, same arrangement");

  // Comparing two single variations is a coin toss - most intervals are in both scales, so they
  // collide constantly. Collect what each mode actually reaches for across a spread of seeds and
  // check the two vocabularies differ where the scales do.
  const collect = (mode) => {
    const seen = new Set();
    for (let seed = 1; seed <= 120; seed++) {
      for (const step of gen(map, { seed: seed * 104729, pitchAmount: 90, depth: 80, key: { root: "C", mode, known: true } }).steps) {
        if (step.pitch) seen.add(((step.pitch % 12) + 12) % 12);
      }
    }
    return seen;
  };
  const minor = collect("minor");
  const major = collect("major");
  assert.ok(minor.size > 2 && major.size > 2, "both modes should offer a real vocabulary");
  assert.ok(minor.has(3) || minor.has(8) || minor.has(10), "minor should reach a note major hasn't got");
  assert.ok(major.has(4) || major.has(9) || major.has(11), "major should reach a note minor hasn't got");
  assert.equal([...minor].some((n) => [4, 9, 11].includes(n)), false, "minor must never produce a major third, sixth or seventh");
  assert.equal([...major].some((n) => [3, 8, 10].includes(n)), false, "major must never produce a minor third, sixth or seventh");
});

test("resolveKey: copes with nothing detected", () => {
  assert.equal(resolveKey({ root: null }).known, false);
  assert.equal(resolveKey({ root: "A", mode: "min" }).mode, "minor");
  assert.ok(PITCH_MODES.every((m) => m.key && m.label && m.blurb));
});

// --- batch diversity -------------------------------------------------------------------------

test("a batch of eight explores different ideas rather than eight siblings", () => {
  const map = loopMap("1/16");
  const profiles = profilesForBatch(makeRng(7), 8);
  const departures = profiles.map((profile, i) => recipeDeparture(gen(map, { profile, seed: (i + 1) * 104729 })));
  const spread = Math.max(...departures) - Math.min(...departures);
  assert.ok(spread > 0.15, `a batch should range from conservative to adventurous, spread was ${(spread * 100).toFixed(0)} points`);
  // ...and the descriptions shouldn't all read the same either.
  const shapes = new Set(profiles.map((profile, i) => describeRecipe(gen(map, { profile, seed: (i + 1) * 104729 }))));
  assert.ok(shapes.size >= 7, `expected distinct descriptions, got ${shapes.size}/8`);
});

test("batch profiles are deterministic, reorder between batches, and open with the faithful one", () => {
  assert.deepEqual(
    profilesForBatch(makeRng(3), 8).map((p) => p.key),
    profilesForBatch(makeRng(3), 8).map((p) => p.key)
  );
  assert.notDeepEqual(
    profilesForBatch(makeRng(3), 8).map((p) => p.key),
    profilesForBatch(makeRng(4), 8).map((p) => p.key)
  );
  assert.equal(profilesForBatch(makeRng(9), 8)[0].key, "faithful", "the top of the list is where you look first");
  assert.equal(profilesForBatch(makeRng(9), 3).length, 3);
  assert.ok(PROFILES.every((p) => p.key && p.label));
  assert.equal(profileByKey("nope").key, "neutral");
});

test("profiles lean, they don't override - Activity 5 stays quiet whatever the profile", () => {
  const map = loopMap("1/16");
  for (const profile of PROFILES) {
    const departure = sample(map, { profile, activity: 5, depth: 20 }, recipeDeparture, 25);
    assert.ok(departure < 0.3, `${profile.key} ignored a low Activity setting: ${(departure * 100).toFixed(0)}%`);
  }
});

// --- invariants ------------------------------------------------------------------------------

test("phrase length is preserved for every type, subdivision and setting", () => {
  for (const sub of SUBDIVISIONS) {
    const map = loopMap(sub.key);
    for (const style of styleKeys()) {
      for (const level of [0, 50, 100]) {
        const recipe = gen(map, { style, structure: level, activity: level, depth: level, rollAmount: level, pitchAmount: level, seed: 12345 });
        assert.equal(recipe.steps.length, map.count, `${sub.key}/${style}/${level}`);
        for (const step of recipe.steps) assert.ok(step.src >= 0 && step.src < map.count, `${style}: src ${step.src} in range`);
      }
    }
  }
});

test("same source, settings, key and seed reproduce the same arrangement exactly", () => {
  const map = loopMap("1/16");
  for (const style of styleKeys()) {
    const a = gen(map, { style, seed: 4242 });
    const b = gen(map, { style, seed: 4242 });
    assert.deepEqual(a.steps, b.steps, `${style}: identical steps`);
    assert.deepEqual(a.edits, b.edits, `${style}: identical edit log`);
  }
  const s1 = gen(map, { seed: "keep this one" });
  const s2 = gen(map, { seed: "keep this one" });
  assert.equal(s1.seed, s2.seed);
  assert.deepEqual(s1.steps, s2.steps);
});

test("different seeds diverge", () => {
  const map = loopMap("1/16");
  const patterns = new Set();
  for (let seed = 1; seed <= 12; seed++) patterns.add(recipePattern(gen(map, { seed: seed * 7919 })));
  assert.ok(patterns.size >= 10, `expected mostly-distinct arrangements, got ${patterns.size}/12`);
});

test("a variation is never identical to the source", () => {
  const map = loopMap("1/16");
  for (const style of styleKeys()) {
    for (const activity of [0, 10, 50]) {
      for (let seed = 1; seed <= 12; seed++) {
        const recipe = gen(map, { style, activity, structure: 90, depth: 20, rollAmount: 0, pitchAmount: 0, seed: seed * 104729 });
        assert.equal(isIdentityRecipe(recipe), false, `${style}/${activity}/${seed} came back unchanged`);
      }
    }
  }
});

test("survives a phrase barely long enough to rearrange, and a coarse grid", () => {
  for (const [sub, seconds] of [["1/4", 0.5], ["1/4", 8], ["1/32", 8]]) {
    const map = createSliceMap({ totalSamples: Math.round(SR * seconds), sampleRate: SR, bpm: 120, subdivision: sub });
    for (const style of styleKeys()) {
      const recipe = gen(map, { style, activity: 100, depth: 100, rollAmount: 100, pitchAmount: 100, seed: 9 });
      assert.equal(recipe.steps.length, map.count, `${sub}/${seconds}s/${style}`);
    }
  }
});

test("an unknown type or pitch mode falls back rather than throwing", () => {
  const map = loopMap("1/16");
  assert.equal(gen(map, { style: "no-such-type" }).style, DEFAULT_STYLE);
  assert.equal(gen(map, { pitchMode: "nonsense" }).pitchMode, "inkey");
  assert.equal(gen(map, { key: null, pitchMode: "inkey" }).steps.length, map.count);
});

// --- vocabulary ------------------------------------------------------------------------------

test("operations: registered once each, declare a real family and real levels, never change length", () => {
  const map = loopMap("1/16");
  const hier = buildHierarchy(map);
  const keys = operationKeys();
  assert.equal(new Set(keys).size, keys.length, "no duplicate keys");
  const rng = { next: () => 0.5, signed: () => 0, range: (a, b) => (a + b) / 2, int: (n) => Math.floor(n / 2), bool: () => true };
  for (const op of OPERATIONS) {
    assert.equal(operationByKey(op.key), op);
    assert.ok(FAMILIES.includes(op.family), `${op.key} has family ${op.family}`);
    assert.ok(op.levels.length, `${op.key} declares levels`);
    for (const level of op.levels) assert.ok(LEVELS.includes(level), `${op.key}: unknown level ${level}`);
    for (const level of op.levels) {
      const node = (hier.levels[level === "micro" ? "slice" : level] || [])[1];
      if (!node) continue;
      const steps = identitySteps(map.count);
      op.apply({ rng, map, hier, steps, node, level, structure: 0.5, activity: 0.5, depth: 0.6 });
      assert.equal(steps.length, map.count, `${op.key} at ${level} changed the phrase length`);
      for (const step of steps) assert.ok(step.src >= 0 && step.src < map.count, `${op.key} at ${level} kept src in range`);
    }
  }
});

test("every remix type is complete, resolvable and weights only real operations", () => {
  const known = new Set(operationKeys());
  for (const style of STYLES) {
    assert.equal(resolveStyle(style.key), style);
    assert.ok(style.label && style.blurb, `${style.key} has a label and a blurb`);
    for (const key of Object.keys(style.opWeights)) assert.ok(known.has(key), `${style.key} weights an unknown operation: ${key}`);
    for (const key of Object.keys(style.unlocks || {})) assert.ok(known.has(key), `${style.key} unlocks an unknown operation: ${key}`);
    for (const level of Object.keys(style.levelWeights)) assert.ok(LEVELS.includes(level), `${style.key}: unknown level ${level}`);
    assert.ok(Object.values(style.opWeights).some((w) => w > 0));
  }
  assert.equal(resolveStyle("nonsense").key, DEFAULT_STYLE);
});

test("the brief's remix types all exist", () => {
  for (const key of ["gentle", "groove", "phrase", "fill", "repeater", "cutup", "reconstruct", "wild"]) {
    assert.ok(styleKeys().includes(key), `missing type: ${key}`);
  }
});

test("describeRecipe: reports bar by bar, and collapses runs of untouched bars", () => {
  const map = loopMap("1/16");
  const text = describeRecipe(gen(map, { activity: 20, seed: 5 }));
  assert.ok(text.length > 0);
  assert.equal(describeRecipe(null), "untouched");
  // Somewhere in a low-activity batch there must be a variation reporting untouched bars.
  let sawUntouched = false;
  for (let seed = 1; seed <= 40; seed++) if (/untouched/.test(describeRecipe(gen(map, { activity: 20, seed: seed * 7919 })))) sawUntouched = true;
  assert.ok(sawUntouched, "restraint should be visible in the description");
});

test("recipePattern: readable, and elides long phrases in the middle", () => {
  const map = loopMap("1/16");
  assert.ok(recipePattern(gen(map, { seed: 2024 }), 16).includes("…"));
  assert.equal(recipePattern({ steps: identitySteps(4) }), "1 2 3 4");
});

test("presets: every one is a complete, valid, self-matching snapshot with its own chop size", () => {
  const styles = new Set(styleKeys());
  const sizes = new Set(SUBDIVISIONS.map((s) => s.key));
  const modes = new Set(PITCH_MODES.map((m) => m.key));
  for (const preset of PRESETS) {
    assert.ok(preset.label && preset.blurb, `${preset.key} has a label and a blurb`);
    for (const field of ["subdivision", "style", "structure", "activity", "depth", "rollAmount", "pitchMode", "pitchAmount"]) {
      assert.ok(preset.settings[field] !== undefined, `${preset.key} sets ${field}`);
    }
    assert.ok(styles.has(preset.settings.style), `${preset.key}: unknown remix type`);
    assert.ok(sizes.has(preset.settings.subdivision), `${preset.key}: unknown chop size`);
    assert.ok(modes.has(preset.settings.pitchMode), `${preset.key}: unknown pitch mode`);
    assert.equal(matchPreset(preset.settings).key, preset.key, `${preset.key} should match itself`);
  }
  assert.equal(matchPreset(DEFAULT_SETTINGS), null, "the opening state is deliberately not one of the presets");
  assert.ok(new Set(PRESETS.map((p) => p.key)).size === PRESETS.length, "no duplicate preset keys");
});

test("presets: each produces a recognisably different result on the same loop", () => {
  const map = loopMap("1/16");
  const shapes = PRESETS.map((preset) => {
    const m = createSliceMap({ totalSamples: map.totalSamples, sampleRate: SR, bpm: 120, subdivision: preset.settings.subdivision });
    let departure = 0;
    let stutter = 0;
    let rolls = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const r = generateRecipe({ map: m, ...preset.settings, key: KEY, seed: seed * 104729 });
      departure += recipeDeparture(r);
      stutter += r.steps.filter((s) => s.stutter).length / r.steps.length;
      rolls += r.edits.filter((e) => e.op === "roll").length;
    }
    return { key: preset.key, departure: departure / 30, stutter: stutter / 30, rolls: rolls / 30 };
  });
  const by = (k) => shapes.find((s) => s.key === k);
  assert.ok(by("subtle").departure < by("destroy").departure / 2, "Subtle and Destroy must not be near neighbours");
  assert.ok(by("fills").rolls > by("barswap").rolls * 2, `Fills should roll far more than Bar swap: ${by("fills").rolls.toFixed(2)} vs ${by("barswap").rolls.toFixed(2)}`);
  assert.ok(by("stutter").stutter > by("subtle").stutter * 3, "Stutter should subdivide far more than Subtle");
  const spread = Math.max(...shapes.map((s) => s.departure)) - Math.min(...shapes.map((s) => s.departure));
  assert.ok(spread > 0.3, `presets should span a wide range, got ${(spread * 100).toFixed(0)} points`);
});

console.log(`\n${passed} test(s) passed.`);
