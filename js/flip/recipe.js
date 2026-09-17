// recipe.js
//
// FLIP stage 2: SLICE MAP -> TRANSFORMATION RECIPE.
//
// A recipe is INSTRUCTIONS, not audio. One step per output slot, each saying which source slice to
// take and what to do to it. Nothing here touches a sample; rendering is a separate stage
// (js/flip/render.js) that can be run, thrown away and run again from the same recipe, and a recipe
// is small enough to log, diff, describe in the UI and reproduce from a seed.
//
// That indirection is why FLIP can promise identical duration: the step list is always exactly as
// long as the slice map, every step occupies exactly one slot's worth of time, and nothing in this
// module can add or remove one. Repeats and rolls REPLACE time, they never append it.
//
// ---------------------------------------------------------------------------------------------
// WHAT CHANGED, AND WHY
//
// The first version walked the phrase one beat at a time and applied one operation per beat it
// decided to touch. Every edit was therefore roughly one beat wide, everywhere, which is precisely
// why the results sounded like generic glitch processing rather than arrangements: a remix that
// edits uniformly has no shape. It also had no way to say "leave bar 1 completely alone".
//
// Generation is now HIERARCHICAL and works in four passes:
//
//   1. PHRASE   the entry point, and whether the whole opening is held
//   2. BARS     each bar is independently left alone or given one to three interventions, each at
//               its own chosen scale (bar / half-bar / beat / half-beat / slice / micro)
//   3. ROLL     a separate pass placing rolls by musical position, not by whatever was left over
//   4. PITCH    a separate pass decorating repeats and rolls with key-constrained transposition
//
// Passes 3 and 4 are separate on purpose: a roll and a transposition are COLOUR applied to an
// arrangement, not ways of arranging. Folding them into the structural walk is what made rolls turn
// up wherever the walk happened to be rather than at the end of a bar where they belong.
//
// RESTRAINT IS A FIRST-CLASS OUTCOME. Bars are left untouched by explicit decision, not by failing
// to be picked, and at low Activity most of them will be. The original material is what supplies
// the musical coherence; FLIP should exploit that rather than feel obliged to demonstrate itself.
//
// THREE CONTROLS, NOT ONE:
//   STRUCTURE  how much of the large-scale shape survives - protects bar positions, downbeats and
//              the opening, keeps borrowed material nearby, and pushes edits to finer scales so
//              they happen INSIDE the existing structure rather than rearranging it
//   ACTIVITY   how often FLIP intervenes at all
//   DEPTH      how far any single intervention goes
//
// SEEDING: one generator, made once, consumed by everything downstream (js/dsp/stretch/rng.js,
// shared with the stretch engines). Same source + same settings + same key + same seed is the same
// recipe, every time, on any machine.
import { makeRng, hashSeed } from "../dsp/stretch/rng.js";
import { OPERATIONS, operationByKey, FAMILIES } from "./operations.js";
import { resolveStyle, describeIntensity } from "./styles.js";
import { identitySteps, isUntouched, makeStep } from "./step.js";
import { buildHierarchy, positionAppeal, levelSpan, LEVEL_LABELS } from "./hierarchy.js";
import { pitchCandidates, choosePitch, melodicPattern, DEFAULT_PITCH_MODE, resolvePitchMode } from "./pitch-plan.js";
import { NEUTRAL_PROFILE } from "./diversity.js";

const EDIT_LEVELS = ["bar", "halfBar", "beat", "halfBeat", "slice", "micro"];

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function pct(value, fallback = 50) {
  const n = Number(value);
  return clamp01((Number.isFinite(n) ? n : fallback) / 100);
}

function weightedPick(rng, candidates) {
  const usable = candidates.filter((c) => c && c.w > 0);
  if (!usable.length) return null;
  const total = usable.reduce((sum, c) => sum + c.w, 0);
  let r = rng.next() * total;
  for (const c of usable) {
    r -= c.w;
    if (r <= 0) return c;
  }
  return usable[usable.length - 1];
}

/**
 * Generate one variation's recipe.
 *
 * @param {object} opts
 * @param {object} opts.map            a slice map (js/flip/slice-map.js)
 * @param {string} opts.style          a remix type key (js/flip/styles.js)
 * @param {number} opts.structure      0..100, how much large-scale shape survives
 * @param {number} opts.activity       0..100, how often FLIP intervenes
 * @param {number} opts.depth          0..100, how far one intervention goes
 * @param {number} [opts.rollAmount]   0..100
 * @param {string} [opts.pitchMode]    off | octaves | inkey | mixed
 * @param {number} [opts.pitchAmount]  0..100
 * @param {{root:string, mode:string, known:boolean}} [opts.key]
 * @param {object} [opts.profile]      a batch-diversity profile (js/flip/diversity.js)
 * @param {number|string} opts.seed
 */
export function generateRecipe({ map, style, structure = 65, activity = 45, depth = 50, rollAmount = 35, pitchMode = DEFAULT_PITCH_MODE, pitchAmount = 20, key = null, profile = NEUTRAL_PROFILE, seed }) {
  const st = resolveStyle(style);
  const prof = profile || NEUTRAL_PROFILE;
  const rng = makeRng(hashSeed(seed));
  const hier = buildHierarchy(map);
  const steps = identitySteps(map.count);
  const edits = [];
  const plan = { bars: [], phrase: [] };

  // The user's three controls, bent by the remix type's personality and then by this variation's
  // slot in the batch. Clamped, so no combination of multipliers can escape the range the sliders
  // describe - a type or profile can lean, it can't override.
  const S = clamp01(pct(structure, 65) * (st.structureBias || 1) * (prof.structure || 1));
  const A = clamp01(pct(activity, 45) * (st.activityBias || 1) * (prof.activity || 1));
  const D = clamp01(pct(depth, 50) * (st.depthBias || 1) * (prof.depth || 1));
  const roll = clamp01(pct(rollAmount, 35) * (st.rollBias || 1) * (prof.roll || 1));
  const pitchRate = clamp01(pct(pitchAmount, 20) * (st.pitchBias || 1) * (prof.pitch || 1));

  /** "Would this type do X at this depth, on this material?" Shared by the pick lists and by the
   *  composite operations that borrow a technique from another one (see ctx.allows). */
  function allows(opKey, node) {
    const op = operationByKey(opKey);
    if (!op) return false;
    if ((st.opWeights[opKey] || 0) <= 0) return false;
    const gate = st.unlocks && st.unlocks[opKey] != null ? st.unlocks[opKey] : op.minDepth || 0;
    if (D < gate) return false;
    return op.fits(map, node || { start: 0, end: map.count, span: map.count });
  }

  const ctx = { rng, map, hier, steps, structure: S, activity: A, depth: D, style: st, allows };

  /**
   * Log what happened. An operation may report its OWN region via `at`/`span` in its detail - a roll
   * usually fills only part of the node it was chosen for - and that has to win over the node's
   * extent, because pass 4 transposes by exactly these coordinates. Recording the node's start with
   * the roll's length pointed the pitch pass at slots the roll never touched.
   */
  function record(op, node, detail, level) {
    const d = detail || {};
    edits.push({ op: op.key, label: op.label, family: op.family, level, at: d.at != null ? d.at : node.start, span: d.span != null ? d.span : node.span, ...d });
    return edits[edits.length - 1];
  }

  // =============================================================================================
  // Pass 1 - the phrase
  // =============================================================================================
  //
  // Two competing truths about the opening, resolved explicitly rather than left to chance.
  //
  // HOLD IT: a variation that keeps its first bars and then breaks reads as a version of the loop.
  // MOVE IT: held too faithfully and every variation in a batch announces itself identically for
  // the first beat, which is the fastest way to make eight alternatives feel like one.
  let protectUntil = 0;
  // How much of the opening the entry relocation rewrote, so the bar pass below doesn't go on to
  // report those bars as untouched - a description that says "bars 1-2 untouched" next to "25%
  // changed" is worse than no description.
  let entryRewrote = 0;
  // WHERE THE LOOP STARTS IS THE FIRST THING YOU HEAR, so it is the first thing that has to differ
  // between one variation and the next. At the original rate the opening slice changed in 32% of
  // variations, which meant five or six of every eight began identically - and clicking down a list
  // of eight results that all announce themselves the same way reads as one result, however
  // different the middles are. Structure still protects it (the phrase beginning is part of the
  // shape), it just no longer protects it almost absolutely.
  const entryRate = clamp01((0.5 + 0.45 * (1 - S)) * (0.85 + 0.3 * A) * (prof.entry || 1));
  const canMoveEntry = map.count >= map.perBar * 2 && rng.next() < entryRate;

  if (canMoveEntry) {
    // Bar-aligned while structure is being preserved, so the loop still opens ON a downbeat - just
    // not the one it opened on. With structure low, any beat will do.
    const align = S > rng.next() ? Math.max(1, map.perBar) : Math.max(1, map.perBeat);
    const slots = Math.floor(map.count / align);
    if (slots >= 2) {
      const beat = Math.max(1, map.perBeat);
      const len = weightedPick(rng, [
        { len: beat, w: 1.3 - D },
        { len: Math.max(1, map.perBar >> 1), w: 0.6 + 0.4 * D },
        { len: Math.max(1, map.perBar), w: 0.15 + 1.1 * D },
      ]);
      const span = len ? Math.min(len.len, Math.floor(map.count / 2)) : beat;
      const from = (1 + rng.int(slots - 1)) * align;
      if (span >= 1 && from + span <= map.count) {
        for (let i = 0; i < span; i++) steps[i] = makeStep(from + i, "new-entry");
        edits.push({ op: "new-entry", label: "start somewhere else", family: "structural", level: "phrase", at: 0, span, from });
        plan.phrase.push(`opens from ${Math.floor(from / Math.max(1, map.perBar)) + 1}`);
        entryRewrote = span;
      }
    }
  } else if (map.count >= map.perBar * 2 && rng.next() < 0.2 + 0.6 * S) {
    // A whole number of bars, so the hold ends where the ear expects a change.
    const holdBars = S > 0.6 && rng.bool(0.5) ? Math.max(1, Math.floor(map.bars / 2)) : 1;
    protectUntil = Math.min(map.count - map.perBeat, holdBars * map.perBar);
    plan.phrase.push(`holds ${holdBars} bar${holdBars === 1 ? "" : "s"}`);
  }

  // =============================================================================================
  // Pass 2 - bars
  // =============================================================================================

  const bars = hier.levels.bar.length ? hier.levels.bar : hier.levels.phrase;

  // PHRASE FORM. Deciding each bar independently produces a scatter of treated and untreated bars;
  // music produces shapes - ABAB, AABA, AAAB. The RS7000's Loop Remix exposes the same idea as an
  // INTERVAL parameter ("remix every other measure"), and it is most of why its results sound
  // arranged rather than processed: the listener hears a pattern of change, not just change.
  //
  // Applied as a weighting rather than a rule, so a form bends the per-bar decisions below without
  // making them mechanical, and high Structure reaches for a form more often than low does.
  const FORMS = [
    { key: "ABAB", at: (i) => (i % 2 === 0 ? "A" : "B") },
    { key: "AABA", at: (i, n) => (i === Math.floor(n * 0.5) ? "B" : i === n - 1 ? "B" : "A") },
    { key: "AAAB", at: (i, n) => (i === n - 1 ? "B" : "A") },
    { key: "ABAC", at: (i) => (i % 2 === 0 ? "A" : "B") },
  ];
  let form = null;
  if (bars.length >= 4 && rng.next() < 0.3 + 0.35 * S) {
    form = FORMS[rng.int(FORMS.length)];
    plan.phrase.push(form.key.toLowerCase());
  }
  /** A-bars are the ones the form wants left recognisable; B-bars are where it wants the change. */
  // Mean-neutral by construction: a form REDISTRIBUTES activity, it doesn't add any. Weights that
  // average above 1 quietly make every form-bearing variation busier than the Activity slider said,
  // which showed up as whole-bar restraint dropping from 66% to 54% at Activity 15.
  const formWeight = (bar) => {
    if (!form) return 1;
    return form.at(bar.index, bars.length) === "A" ? 0.35 : 1.65;
  };

  /** Which hierarchy scale to work at. Structure pushes coarse scales away (edits happen INSIDE the
   *  existing structure); depth pulls fine ones in (micro-slicing is a deep intervention). */
  function pickLevel(bar) {
    const scale = {
      bar: 0.2 + 1.7 * (1 - S),
      halfBar: 0.45 + 1.1 * (1 - S),
      beat: 1,
      halfBeat: 0.75 + 0.6 * D,
      slice: 0.3 + 1.3 * D,
      micro: 0.1 + 1.2 * D,
    };
    const candidates = EDIT_LEVELS.filter((level) => levelSpan(map, level) > 0 && hier.levels[level] && hier.levels[level].length).map((level) => ({
      level,
      w: (st.levelWeights[level] || 0) * (prof.levels && prof.levels[level] != null ? prof.levels[level] : 1) * scale[level],
    }));
    const picked = weightedPick(rng, candidates);
    return picked ? picked.level : "beat";
  }

  function pickNode(bar, level) {
    if (level === "bar") return bar;
    // MICRO has no span of its own: it is a slice worked at sub-slice resolution, which is what the
    // stutter and roll counts express. Treating it as a slice here keeps the level list honest.
    const effective = level === "micro" ? "slice" : level;
    const children = hier.childrenOf(bar, effective);
    if (!children.length) return bar;
    const candidates = children.map((node) => ({ node, w: positionAppeal(node, st.positionBias) * (1 - S * 0.55 * node.strength) }));
    const picked = weightedPick(rng, candidates);
    return picked ? picked.node : children[0];
  }

  function pickOperation(node, level) {
    const family = weightedPick(
      rng,
      FAMILIES.filter((f) => f !== "roll").map((f) => ({
        family: f,
        w: (st.familyWeights[f] || 0) * (prof.families && prof.families[f] != null ? prof.families[f] : 1),
      }))
    );
    const wanted = family ? family.family : "structural";
    const candidates = OPERATIONS.filter((op) => op.family === wanted && op.key !== "roll" && op.levels.includes(level) && allows(op.key, node)).map((op) => ({
      op,
      w: st.opWeights[op.key] || 0,
    }));
    const picked = weightedPick(rng, candidates);
    return picked ? picked.op : null;
  }

  for (const bar of bars) {
    const entry = { index: bar.index, treatment: "untouched", ops: [] };
    plan.bars.push(entry);
    // Bars the relocated entry already rewrote are not untouched, whatever happens next.
    if (entryRewrote > bar.start) entry.treatment = "edited";

    if (bar.start < protectUntil) continue;

    // Should anything happen in this bar at all? Structure protects the first bar and the strong
    // positions; the remix type's position bias pulls activity towards wherever it likes to work.
    const appeal = positionAppeal(bar, st.positionBias) * formWeight(bar);
    const protection = S * (bar.isFirst ? 0.5 : 0.2);
    if (rng.next() >= clamp01(A * appeal * (1 - protection))) continue;

    // One intervention usually, two or three when the loop is busy or the settings are deep.
    let interventions = 1;
    if (rng.next() < A * 0.6) interventions++;
    if (D > 0.6 && rng.next() < A * 0.35) interventions++;

    for (let i = 0; i < interventions; i++) {
      const level = pickLevel(bar);
      const node = pickNode(bar, level);
      const op = pickOperation(node, level);
      if (!op) continue;
      const detail = op.apply({ ...ctx, node, level });
      if (!detail) continue;
      entry.treatment = "edited";
      entry.ops.push({ key: op.key, label: op.label, level });
      record(op, node, { ...detail, levelLabel: LEVEL_LABELS[level] }, level);
    }
  }

  // =============================================================================================
  // Pass 3 - rolls
  // =============================================================================================
  //
  // Placed by musical position, independently of where the structural walk happened to be. A roll
  // belongs at the end of a beat, the end of a bar or the end of the phrase; FILL weights those
  // enormously, WILD doesn't care. Rolls always REPLACE the time they occupy.
  const rollOp = operationByKey("roll");
  if (roll > 0 && rollOp) {
    const barCount = Math.max(1, bars.length);
    const expected = roll * barCount * (0.45 + 0.9 * A);
    let rolls = Math.floor(expected);
    if (rng.next() < expected - rolls) rolls++;
    rolls = Math.min(rolls, barCount * 2);

    const bias = st.rollPosition || st.positionBias;
    const levels = ["beat", "halfBeat"].filter((l) => hier.levels[l] && hier.levels[l].length);
    // Two rolls on top of each other is not two rolls, it is one mangled one - the second overwrites
    // part of the first, leaving a region that is recorded as a roll but no longer sounds like one
    // (and which pass 4 would then transpose as though it did).
    const rolled = new Set();
    for (let i = 0; i < rolls && levels.length; i++) {
      const level = levels[rng.int(levels.length)];
      const candidates = hier.levels[level]
        .filter((node) => node.start >= protectUntil)
        .filter((node) => {
          for (let k = node.start; k < node.end; k++) if (rolled.has(k)) return false;
          return true;
        })
        .map((node) => ({ node, w: positionAppeal(node, bias) * (node.endsBar ? 1 : 0.55) * (1 - S * 0.35 * node.strength) }));
      const picked = weightedPick(rng, candidates);
      if (!picked) continue;
      const detail = rollOp.apply({ ...ctx, node: picked.node, level });
      if (!detail) continue;
      for (let k = picked.node.start; k < picked.node.end; k++) rolled.add(k);
      const bar = plan.bars[Math.floor((detail.at != null ? detail.at : picked.node.start) / Math.max(1, map.perBar))];
      if (bar) {
        bar.treatment = "edited";
        bar.ops.push({ key: "roll", label: "roll", level });
      }
      record(rollOp, picked.node, { ...detail, levelLabel: LEVEL_LABELS[level] }, level);
    }
  }

  // =============================================================================================
  // Pass 4 - pitch
  // =============================================================================================
  //
  // Decorates what the arrangement already produced rather than transposing at random. Repeats and
  // rolls are the targets, because a transposed repetition is a melodic idea ("the same figure, a
  // third up") while a transposed lone slice is usually just a wrong note.
  const resolvedPitchMode = resolvePitchMode(pitchMode).key;
  const keyMode = (key && key.mode) || "minor";
  const candidates = resolvedPitchMode === "off" ? [] : pitchCandidates({ mode: keyMode, pitchMode: resolvedPitchMode, depth: D });
  let pitched = 0;
  const pitchedSlots = new Set();

  /** Write one melodic shape across `parts` equal spans starting at `at`. */
  function applyShape(at, span, parts) {
    const unit = Math.floor(span / parts);
    if (unit < 1) return false;
    const pattern = melodicPattern(rng, parts, candidates, { depth: D, mode: keyMode, pitchMode: resolvedPitchMode });
    let wrote = false;
    for (let p = 0; p < parts; p++) {
      if (!pattern[p]) continue;
      for (let i = 0; i < unit; i++) {
        const slot = at + p * unit + i;
        if (slot >= map.count || pitchedSlots.has(slot)) continue;
        steps[slot].pitch = pattern[p];
        pitchedSlots.add(slot);
        pitched++;
        wrote = true;
      }
    }
    return wrote;
  }

  if (pitchRate > 0 && candidates.length) {
    // (a) Rolls. A roll that rises or falls through the scale as it goes is one of the most useful
    //     accidents this whole feature can produce.
    for (const edit of edits.filter((e) => e.op === "roll")) {
      if (rng.next() >= pitchRate) continue;
      const span = Math.min(edit.span, map.count - edit.at);
      if (span >= 2) applyShape(edit.at, span, span);
    }

    // (b) Repetitions. A figure restated a third down is a SEQUENCE - the oldest melodic
    //     development technique there is - and it is the single most musical thing that can be done
    //     to a repeated fragment.
    for (const edit of edits.filter((e) => e.family === "structural" && e.span >= 4)) {
      if (rng.next() >= pitchRate) continue;
      const parts = edit.op === "aba" ? Math.max(2, edit.parts || 3) : 2;
      applyShape(edit.at, edit.span, parts);
    }

    // (c) A WHOLE BAR OR HALF-BAR, transposed. This is the target the first version didn't have and
    //     the reason pitch barely registered: on a short loop there are few repeats to decorate, so
    //     pitch simply never fired. "Bar 3 is bar 3, a third down" is an obvious, instantly musical
    //     variation that needs no repetition to hang off - and it moves enough material to be heard
    //     as a key change in the phrase rather than as one odd note.
    const pitchLevels = ["bar", "halfBar"].filter((l) => hier.levels[l] && hier.levels[l].length > 1);
    if (pitchLevels.length && rng.next() < pitchRate * 1.25) {
      const level = pitchLevels[rng.int(pitchLevels.length)];
      const nodes = hier.levels[level].filter((n) => n.start >= protectUntil && n.start > 0);
      if (nodes.length) {
        const node = nodes[rng.int(nodes.length)];
        const shift = choosePitch(rng, candidates);
        if (shift) {
          for (let i = node.start; i < Math.min(map.count, node.end); i++) {
            if (pitchedSlots.has(i)) continue;
            steps[i].pitch = shift;
            pitchedSlots.add(i);
            pitched++;
          }
        }
      }
    }

    // (d) A scattering of individual slices. Deliberately last and deliberately rare: a transposed
    //     lone slice is usually just a wrong note, where a transposed REPETITION is a melodic idea.
    const loneRate = pitchRate * 0.02;
    for (let i = 0; i < map.count; i++) {
      if (steps[i].pitch || steps[i].silent) continue;
      if (map.slices[i].isDownbeat && S > rng.next()) continue;
      if (rng.next() >= loneRate) continue;
      steps[i].pitch = choosePitch(rng, candidates);
      pitchedSlots.add(i);
      pitched++;
    }
  }

  // A variation identical to the source is a wasted slot in the batch. Every pass above can
  // legitimately decline - Activity at 0 with Rolls and Pitch off leaves nothing with permission to
  // fire - so the guarantee is made here rather than assumed. One intervention, in the second half
  // where a change reads as intended, at whatever scale this type prefers.
  if (!edits.length) {
    const fallbackBars = bars.length > 1 ? bars.slice(Math.floor(bars.length / 2)) : bars;
    for (let tries = 0; tries < 12 && !edits.length; tries++) {
      const bar = fallbackBars[rng.int(fallbackBars.length)];
      const level = pickLevel(bar);
      const node = pickNode(bar, level);
      const op = pickOperation(node, level);
      if (!op) continue;
      const detail = op.apply({ ...ctx, node, level });
      if (!detail) continue;
      const entry = plan.bars[bar.index];
      if (entry) {
        entry.treatment = "edited";
        entry.ops.push({ key: op.key, label: op.label, level });
      }
      record(op, node, { ...detail, levelLabel: LEVEL_LABELS[level] }, level);
    }
  }

  if (pitched) {
    edits.push({ op: "pitch", label: resolvedPitchMode === "octaves" ? "octave shifts" : "pitch", family: "pitch", level: "slice", at: 0, span: pitched, slices: pitched });
  }

  // A single "how far is this from the source" number, derived rather than asked for, so a row can
  // be sorted by ear at a glance.
  const intensity = Math.round(100 * clamp01(A * 0.45 + D * 0.35 + (1 - S) * 0.2));

  return {
    seed: hashSeed(seed),
    style: st.key,
    profile: prof.key,
    structure: Math.round(S * 100),
    activity: Math.round(A * 100),
    depth: Math.round(D * 100),
    rollAmount: Math.round(roll * 100),
    pitchMode: resolvedPitchMode,
    pitchAmount: Math.round(pitchRate * 100),
    key: key && key.known ? { root: key.root, mode: key.mode } : null,
    intensity,
    sliceCount: map.count,
    subdivision: map.subdivision,
    steps,
    edits,
    plan,
  };
}

/** True when the recipe leaves the source completely untouched. */
export function isIdentityRecipe(recipe) {
  if (!recipe || !recipe.steps) return true;
  return recipe.steps.every((s, i) => isUntouched(s, i));
}

/** How much of the original survives in place, 0..1. */
export function recipeDeparture(recipe) {
  if (!recipe || !recipe.steps || !recipe.steps.length) return 0;
  let intact = 0;
  for (let i = 0; i < recipe.steps.length; i++) if (isUntouched(recipe.steps[i], i)) intact++;
  return 1 - intact / recipe.steps.length;
}

/**
 * What actually happened, bar by bar - "bar 1 untouched · bar 2 repeat, roll · bar 3 substitute".
 *
 * Bar-wise rather than a flat tally because that is how the result is heard, and because seeing
 * which bars were left alone is the fastest way to judge whether a variation is worth auditioning.
 */
export function describeRecipe(recipe) {
  if (!recipe) return "untouched";
  const plan = recipe.plan;
  if (!plan || !plan.bars || !plan.bars.length) {
    if (!recipe.edits || !recipe.edits.length) return "untouched";
    const counts = new Map();
    for (const edit of recipe.edits) counts.set(edit.label, (counts.get(edit.label) || 0) + 1);
    return [...counts.entries()].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(" · ");
  }

  const parts = [];
  if (plan.phrase && plan.phrase.length) parts.push(plan.phrase.join(", "));

  // Consecutive untouched bars collapse - "bars 1-2 untouched" rather than the same word twice.
  let run = 0;
  const flush = (upto) => {
    if (!run) return;
    parts.push(run === 1 ? `bar ${upto} untouched` : `bars ${upto - run + 1}-${upto} untouched`);
    run = 0;
  };
  plan.bars.forEach((bar, i) => {
    const n = i + 1;
    if (bar.treatment === "untouched") {
      run++;
      return;
    }
    flush(n - 1);
    const labels = [...new Set(bar.ops.map((o) => o.label))];
    // A bar rewritten only by the phrase-level entry move has no ops of its own; the opening is
    // already named in plan.phrase, so naming the bar again would just repeat it.
    if (labels.length) parts.push(`bar ${n} ${labels.join(", ")}`);
  });
  flush(plan.bars.length);

  const pitch = (recipe.edits || []).find((e) => e.op === "pitch");
  if (pitch) parts.push(pitch.label);
  return parts.join(" · ") || "untouched";
}

/** The step list as a readable sequence, for the row tooltip and for tests. */
export function recipePattern(recipe, maxSlices = 64) {
  if (!recipe || !recipe.steps) return "";
  const token = (s) => {
    if (s.silent) return "–";
    let out = String(s.src + 1);
    if (s.reverse) out = `<${out}`;
    if (s.stutter) out += `×${s.stutter}`;
    if (s.pitch) out += `${s.pitch > 0 ? "+" : ""}${s.pitch}`;
    return out;
  };
  const steps = recipe.steps;
  if (steps.length <= maxSlices) return steps.map(token).join(" ");
  const head = steps.slice(0, maxSlices / 2).map(token).join(" ");
  const tail = steps.slice(steps.length - maxSlices / 2).map(token).join(" ");
  return `${head} … ${tail}`;
}

/** Everything that decides what a recipe renders to - used to spot a stale variation. */
export function recipeSignature(recipe, map) {
  if (!recipe) return "";
  return JSON.stringify([
    recipe.seed,
    recipe.style,
    recipe.structure,
    recipe.activity,
    recipe.depth,
    recipe.rollAmount,
    recipe.pitchMode,
    recipe.pitchAmount,
    recipe.key,
    map ? map.subdivision : recipe.subdivision,
    map ? map.count : recipe.sliceCount,
    map ? Math.round((map.bpm || 0) * 100) : 0,
  ]);
}

export { operationByKey, describeIntensity };
export { makeStep, cloneStep, identitySteps } from "./step.js";
