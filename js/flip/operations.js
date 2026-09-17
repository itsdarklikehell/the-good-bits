// operations.js
//
// FLIP's transformation vocabulary: small, reusable, single-purpose edits to a recipe's step list.
//
// Every operation now declares two things the first version didn't have, and both are what stopped
// results all sounding like the same processing at the same rate:
//
//   FAMILY  structural / micro / break / roll. A remix type weights families, so "rearrange this
//           phrase" and "chop this to bits" stop being the same decision with a different number.
//   LEVELS  which hierarchy scales it makes sense at (js/flip/hierarchy.js). The same operation -
//           repeat, reverse, substitute - is a different musical idea applied to a bar, a beat or a
//           single slice, so it is written once and applied at whatever scale was chosen.
//
// Operations receive a NODE (a span of slots that means something musically) rather than a bare
// anchor index, and work inside it. That is what makes "bar 2's second half repeats its first" and
// "the last beat of bar 4 rolls at 1/32" expressible at all.
//
// The three rules from the first version still hold, and the renderer still relies on all three:
//
//   1. Never change steps.length. Phrase length is preserved by construction, not by checking.
//   2. Only ever write inside the node given, and return falsy when the material is too short.
//   3. Decide WHAT to do; the generator decides WHERE, HOW OFTEN and AT WHAT SCALE.
//
// A COMPOSITE OPERATION MAY ONLY BORROW WHAT ITS TYPE WOULD REACH FOR ANYWAY - see ctx.allows().
// Left ungated, call-and-response silences its response under a type that never drops anything out,
// and keep-the-downbeat micro-edits under one that is supposed to be gentle.
import { makeStep, cloneStep } from "./step.js";

export const FAMILIES = ["structural", "micro", "break", "roll"];

/** Copy a run of steps out of the list, detached, so an overlapping write can't read its own output. */
function snapshot(steps, start, len) {
  const out = [];
  for (let i = 0; i < len; i++) out.push(cloneStep(steps[start + i]));
  return out;
}

function writeRun(steps, dest, run, op) {
  for (let i = 0; i < run.length; i++) {
    if (dest + i >= steps.length || dest + i < 0) break;
    steps[dest + i] = { ...run[i], op };
  }
}

/** Fresh source material, straight from the map - not whatever has already happened at that spot. */
function sourceRun(from, len, op) {
  const run = [];
  for (let i = 0; i < len; i++) run.push(makeStep(from + i, op));
  return run;
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

/** "Would this type do X at this depth?" - see ctx.allows() in js/flip/recipe.js. */
function permits(ctx, key) {
  return typeof ctx.allows === "function" ? ctx.allows(key) : true;
}

/** The weakest metric position inside a span - where a rest or a reversal hurts least. */
function weakestIn(map, from, len) {
  let best = from;
  let bestStrength = Infinity;
  for (let i = from; i < Math.min(map.count, from + len); i++) {
    const s = map.slices[i] ? map.slices[i].strength : 0.5;
    if (s < bestStrength) {
      bestStrength = s;
      best = i;
    }
  }
  return best;
}

/**
 * Where inside a span should a single-slice edit land?
 *
 * High structure: the weakest metric position, so the beat still lands. Low structure: anywhere,
 * which is what makes the setting audible rather than notional - reversing the slice carrying the
 * downbeat is exactly the damage someone pulling Structure down is asking for.
 */
function pickTarget(ctx, from, len) {
  if (ctx.structure > ctx.rng.next()) return weakestIn(ctx.map, from, len);
  return Math.min(ctx.map.count - 1, from + ctx.rng.int(Math.max(1, len)));
}

/**
 * A source span of `len` slots to borrow from, biased by STRUCTURE towards somewhere near.
 *
 * "Nearby source material should generally be favoured over distant material at conservative
 * settings" is most of what makes a substitution sound like a variation rather than a collage, and
 * it is a weighting rather than a rule so that low structure really can reach across the phrase.
 */
function borrowFrom(ctx, node, len, { alignTo = 0 } = {}) {
  const { map, rng, structure } = ctx;
  const align = Math.max(1, alignTo || len);
  const slots = Math.floor(map.count / align);
  if (slots < 2) return -1;
  const home = Math.round(node.start / align);
  const candidates = [];
  for (let i = 0; i < slots; i++) {
    const from = i * align;
    if (from === node.start || from + len > map.count) continue;
    const distance = Math.abs(i - home);
    // Near is likelier than far, and the more structure is being preserved the steeper that is.
    const nearness = 1 / Math.pow(distance, 0.6 + 1.9 * structure);
    candidates.push({ from, w: nearness });
  }
  const picked = weightedPick(rng, candidates);
  return picked ? picked.from : -1;
}

/**
 * ROLL - a first-class transformation, not a synonym for stutter.
 *
 * A roll takes one fragment and repeats it rapidly to fill a fixed region of musical time. The
 * region is chosen by the caller (a beat, half a beat, the tail of a bar); the RATE is how finely
 * that region is chopped, and it is expressed relative to the slot grid so it stays musical
 * whatever the slice size is:
 *
 *   fragmentSlots >= 1  the roll repeats a GROUP of whole slots (a 1/8 roll on a 1/16 grid)
 *   fragmentSlots < 1   each slot is subdivided (a 1/32 or 1/64 roll on a 1/16 grid), which is the
 *                       existing micro-slicing, now with a musical reason to be where it is
 *
 * Critically it cannot lengthen anything: it writes into exactly the slots it was given, and a
 * subdivided slot is filled faster rather than taking more room. `divisions` lets the rate change
 * across the roll, which is what an accelerating roll is.
 */
export function applyRoll(ctx, { start, span, fragmentSlots, from, reverse = false, accelerate = false, label = "roll" }) {
  const { steps, map, rng } = ctx;
  const end = Math.min(map.count, start + span);
  if (end <= start) return null;

  if (fragmentSlots >= 1) {
    // Coarser than a slot: repeat a group of whole slots across the region. Capped at half the
    // region, because a "roll" whose group is as long as the region it fills repeats nothing - it
    // is the original material with a label on it, which is not what anybody means by a roll.
    const groupLen = Math.max(1, Math.min(Math.round(fragmentSlots), Math.floor((end - start) / 2)));
    const source = from >= 0 ? from : start;
    for (let i = start; i < end; i++) {
      const offset = (i - start) % groupLen;
      const src = Math.min(map.count - 1, source + offset);
      steps[i] = { ...makeStep(src, label), reverse };
    }
    return { at: start, span: end - start, fragmentSlots: groupLen, reverse };
  }

  // Finer than a slot: each slot is filled with N copies of a fragment of itself.
  const base = Math.max(2, Math.round(1 / fragmentSlots));
  const source = from >= 0 ? from : start;
  const count = end - start;
  for (let i = 0; i < count; i++) {
    // An accelerating roll doubles up as it goes, which is the gesture people actually mean by
    // "roll" far more often than a constant rate is.
    const sub = accelerate ? Math.min(16, base * Math.pow(2, Math.floor((i / Math.max(1, count - 1)) * 2))) : base;
    const step = makeStep(Math.min(map.count - 1, source), label);
    step.stutter = Math.max(2, Math.round(sub));
    step.keepHead = 0;
    step.fragFrom = 0;
    step.reverse = reverse;
    steps[start + i] = step;
  }
  return { at: start, span: count, fragmentSlots, reverse, accelerate };
}

/** Roll rates that are worth having, relative to one slot, coarse to fine. */
export function rollRates(ctx, node) {
  const { depth, map } = ctx;
  const beat = Math.max(1, map.perBeat);
  const out = [];
  if (node.span >= 2) out.push({ fragmentSlots: 2, w: 0.5 + 0.4 * (1 - depth), name: "half" });
  out.push({ fragmentSlots: 1, w: 1, name: "slot" });
  out.push({ fragmentSlots: 0.5, w: 0.7 + 0.7 * depth, name: "double" });
  if (depth > 0.4) out.push({ fragmentSlots: 0.25, w: 0.5 * depth, name: "quad" });
  // 1/64-and-beyond territory: only where a slot is long enough for the fragments to survive.
  if (depth > 0.7 && beat >= 4) out.push({ fragmentSlots: 0.125, w: 0.35 * depth, name: "octuple" });
  return out;
}

export const OPERATIONS = [
  // ---------------------------------------------------------------- structural
  {
    key: "preserve",
    label: "leave it alone",
    family: "structural",
    levels: ["bar", "halfBar", "beat"],
    fits: () => true,
    // Doing nothing, deliberately and on the record. Having it in the vocabulary means a type can
    // WEIGHT restraint rather than only arriving at it by failing to pick something else.
    apply: () => null,
  },

  {
    key: "repeat-node",
    label: "repeat",
    family: "structural",
    levels: ["bar", "halfBar", "beat", "halfBeat", "slice"],
    fits: (map, node) => node.start >= node.span,
    apply(ctx) {
      const { steps, node } = ctx;
      const from = node.start - node.span;
      if (from < 0) return null;
      writeRun(steps, node.start, snapshot(steps, from, node.span), "repeat-node");
      return { from, span: node.span };
    },
  },

  {
    key: "repeat-half",
    label: "repeat the first half",
    family: "structural",
    levels: ["bar", "halfBar", "beat"],
    fits: (map, node) => node.span >= 2,
    apply(ctx) {
      const { steps, node, rng } = ctx;
      const half = node.span >> 1;
      if (half < 1) return null;
      if (rng.bool(0.65)) {
        // First half twice - it stammers and then resolves on the next downbeat.
        writeRun(steps, node.start + half, snapshot(steps, node.start, half), "repeat-half");
        return { half, which: "first" };
      }
      // Second half twice - the attack is replaced by its own tail, a classic lurch.
      writeRun(steps, node.start, snapshot(steps, node.start + half, half), "repeat-half");
      return { half, which: "second" };
    },
  },

  {
    key: "substitute-near",
    label: "substitute",
    family: "structural",
    levels: ["bar", "halfBar", "beat", "halfBeat", "slice"],
    fits: (map, node) => map.count >= node.span * 2,
    apply(ctx) {
      const { steps, node } = ctx;
      const from = borrowFrom(ctx, node, node.span, { alignTo: node.span });
      if (from < 0) return null;
      writeRun(steps, node.start, sourceRun(from, node.span, "substitute-near"), "substitute-near");
      return { from, span: node.span };
    },
  },

  {
    key: "swap-halves",
    label: "swap halves",
    family: "structural",
    levels: ["bar", "halfBar", "beat"],
    fits: (map, node) => node.span >= 2,
    apply(ctx) {
      const { steps, node } = ctx;
      const half = node.span >> 1;
      if (half < 1) return null;
      const a = snapshot(steps, node.start, half);
      const b = snapshot(steps, node.start + half, node.span - half);
      writeRun(steps, node.start, b, "swap-halves");
      writeRun(steps, node.start + b.length, a, "swap-halves");
      return { half };
    },
  },

  {
    key: "motif-return",
    label: "return to an earlier motif",
    family: "structural",
    levels: ["bar", "halfBar", "beat"],
    fits: (map, node) => node.start >= node.span,
    apply(ctx) {
      const { steps, node, rng, map } = ctx;
      // Deliberately biased towards the OPENING rather than merely backwards: a phrase that comes
      // back to its first bar sounds composed, which is the single cheapest way to make a
      // rearrangement read as an arrangement.
      const slots = Math.floor(node.start / node.span);
      if (slots < 1) return null;
      const from = (rng.bool(0.6) ? 0 : rng.int(slots)) * node.span;
      if (from + node.span > map.count) return null;
      writeRun(steps, node.start, sourceRun(from, node.span, "motif-return"), "motif-return");
      return { from, span: node.span };
    },
  },

  {
    key: "aba",
    label: "A/B/A",
    family: "structural",
    levels: ["bar", "halfBar", "beat"],
    fits: (map, node) => node.span >= 3,
    apply(ctx) {
      const { steps, node, rng } = ctx;
      const parts = node.span >= 4 && rng.bool(0.6) ? 4 : 3;
      const unit = Math.floor(node.span / parts);
      if (unit < 1) return null;
      const a = snapshot(steps, node.start, unit);
      const b = snapshot(steps, node.start + unit, unit);
      writeRun(steps, node.start + unit * 2, a, "aba");
      if (parts === 4) writeRun(steps, node.start + unit * 3, b, "aba");
      return { parts, unit };
    },
  },

  {
    key: "call-response",
    label: "call and response",
    family: "structural",
    levels: ["bar", "halfBar", "beat"],
    fits: (map, node) => node.span >= 2,
    apply(ctx) {
      const { steps, node, rng } = ctx;
      const half = node.span >> 1;
      if (half < 1) return null;
      // Say it, then say it differently. A/A' is the most reliable way to make a rearrangement
      // sound composed rather than shuffled, which is why it gets its own operation.
      const response = snapshot(steps, node.start, half);
      const variants = ["turnaround"];
      if (permits(ctx, "reverse-node")) variants.push("reverse");
      if (permits(ctx, "stutter")) variants.push("stutter");
      if (permits(ctx, "silence")) variants.push("rest");
      const variant = variants[rng.int(variants.length)];
      const last = response[response.length - 1];

      if (variant === "reverse") {
        response.reverse();
        for (const step of response) step.reverse = !step.reverse;
      } else if (variant === "stutter" && !last.silent) {
        last.stutter = 2 + 2 * ctx.rng.int(2);
        last.keepHead = rng.bool(0.5) ? 0.5 : 0;
        last.fragFrom = last.keepHead;
      } else if (variant === "rest") {
        last.silent = true;
        last.stutter = 0;
      } else {
        response[response.length - 1] = cloneStep(response[0]);
      }
      writeRun(steps, node.start + half, response, "call-response");
      return { half, variant };
    },
  },

  {
    key: "jump",
    label: "jump",
    family: "structural",
    levels: ["bar", "halfBar", "beat", "halfBeat"],
    fits: (map, node) => map.count >= node.span * 2,
    apply(ctx) {
      const { steps, node, map, rng, depth } = ctx;
      const beat = Math.max(1, map.perBeat);
      // Whole beats while structure is being preserved; anything once it isn't, which is what
      // drags the phrase out of phase on purpose.
      const stride = ctx.structure > rng.next() ? beat : 1;
      const maxSteps = Math.max(1, Math.floor((map.count - node.span) / stride));
      const reach = Math.max(1, Math.round(maxSteps * (0.15 + 0.85 * depth)));
      const distance = (1 + rng.int(reach)) * stride * (rng.bool(0.6) ? -1 : 1);
      const from = node.start + distance;
      if (from < 0 || from + node.span > map.count) return null;
      writeRun(steps, node.start, sourceRun(from, node.span, "jump"), "jump");
      return { from, distance };
    },
  },

  // ---------------------------------------------------------------- micro
  {
    key: "micro-shuffle",
    label: "rearrange inside",
    family: "micro",
    levels: ["halfBar", "beat", "halfBeat"],
    minDepth: 0.2,
    fits: (map, node) => node.span >= 3,
    apply(ctx) {
      const { steps, node, rng } = ctx;
      // A rotation, not a shuffle: the material stays contiguous and only its phase changes, which
      // is musical. A genuine permutation of small slices is what CUT-UP's stutter is for.
      const by = 1 + rng.int(node.span - 1);
      const run = snapshot(steps, node.start, node.span);
      const rotated = run.slice(by).concat(run.slice(0, by));
      writeRun(steps, node.start, rotated, "micro-shuffle");
      return { by };
    },
  },

  {
    key: "micro-repeat",
    label: "repeat the tail",
    family: "micro",
    levels: ["beat", "halfBeat", "slice"],
    fits: (map, node) => node.span >= 2,
    apply(ctx) {
      const { steps, node, rng, depth } = ctx;
      const unit = Math.max(1, Math.round(node.span * (rng.bool(0.6) ? 0.25 : 0.5)));
      const source = Math.max(node.start, node.end - unit * 2);
      const reps = 1 + (depth > 0.5 && rng.bool(0.4) ? 1 : 0);
      for (let r = 1; r <= reps; r++) {
        const dest = node.end - unit * r;
        if (dest < node.start) break;
        writeRun(steps, dest, snapshot(steps, source, unit), "micro-repeat");
      }
      return { unit, reps };
    },
  },

  {
    key: "reverse-node",
    label: "reverse",
    family: "micro",
    levels: ["bar", "halfBar", "beat", "halfBeat"],
    minDepth: 0.15,
    fits: (map, node) => node.span >= 2,
    apply(ctx) {
      const { steps, node } = ctx;
      // A real group reverse is both: the audio inside each slot runs backwards AND the slots play
      // in the opposite order. Only the second is a shuffle; only the first is backwards stuttering.
      const run = snapshot(steps, node.start, node.span).reverse();
      for (const step of run) step.reverse = !step.reverse;
      writeRun(steps, node.start, run, "reverse-node");
      return { span: node.span };
    },
  },

  {
    key: "reverse-slice",
    label: "reverse a slice",
    family: "micro",
    levels: ["beat", "halfBeat", "slice"],
    fits: () => true,
    apply(ctx) {
      const { steps, node } = ctx;
      const target = pickTarget(ctx, node.start, node.span);
      steps[target].reverse = !steps[target].reverse;
      steps[target].op = "reverse-slice";
      return { target };
    },
  },

  {
    key: "stutter",
    label: "stutter",
    family: "micro",
    levels: ["beat", "halfBeat", "slice", "micro"],
    minDepth: 0.25,
    fits: () => true,
    apply(ctx) {
      const { steps, node, rng, depth, map } = ctx;
      // Landing on the LAST slot of the node makes it a run-up into whatever follows, which is
      // where a stutter sounds deliberate rather than sprinkled.
      const target = ctx.structure > rng.next() ? Math.min(map.count - 1, node.end - 1) : node.start + rng.int(node.span);
      const step = steps[Math.min(map.count - 1, target)];
      if (step.silent) return null;
      const counts = [2, 3, 4];
      if (depth > 0.5) counts.push(6);
      if (depth > 0.7) counts.push(8);
      step.stutter = counts[rng.int(counts.length)];
      step.keepHead = rng.bool(0.4) ? 0.5 : 0;
      step.fragFrom = step.keepHead;
      step.op = "stutter";
      return { target, count: step.stutter };
    },
  },

  // ---------------------------------------------------------------- break
  {
    key: "silence",
    label: "drop out",
    family: "break",
    levels: ["beat", "halfBeat", "slice"],
    minDepth: 0.1,
    fits: (map) => map.count >= 4,
    apply(ctx) {
      const { steps, node, rng, depth, map } = ctx;
      const start = pickTarget(ctx, node.start, node.span);
      let len = 1;
      if (depth > 0.45 && node.span >= 2 && rng.bool(0.45)) len = 2;
      if (depth > 0.75 && node.span >= 4 && rng.bool(0.3)) len = Math.min(node.span, 4);
      let applied = 0;
      for (let i = start; i < Math.min(map.count, start + len); i++) {
        steps[i].silent = true;
        steps[i].stutter = 0;
        steps[i].op = "silence";
        applied++;
      }
      return applied ? { start, len: applied } : null;
    },
  },

  {
    key: "gap",
    label: "cut a gap",
    family: "break",
    levels: ["bar", "halfBar", "beat"],
    minDepth: 0.3,
    fits: (map, node) => node.span >= 2,
    apply(ctx) {
      const { steps, node, map } = ctx;
      // Silence at the END of a node reads as a rhythmic gap - a rest written into the bar -
      // rather than as a dropout somewhere in the middle of a phrase.
      const unit = Math.max(1, Math.round(node.span * 0.25));
      let applied = 0;
      for (let i = node.end - unit; i < Math.min(map.count, node.end); i++) {
        if (i < 0) continue;
        steps[i].silent = true;
        steps[i].stutter = 0;
        steps[i].op = "gap";
        applied++;
      }
      return applied ? { len: applied } : null;
    },
  },

  // ---------------------------------------------------------------- roll
  {
    key: "roll",
    label: "roll",
    family: "roll",
    levels: ["halfBar", "beat", "halfBeat", "slice"],
    fits: (map, node) => node.span >= 1,
    apply(ctx) {
      const { node, rng, depth } = ctx;
      const rate = weightedPick(rng, rollRates(ctx, node));
      if (!rate) return null;
      // Rolls are usually shorter than the node they were chosen for - a whole bar of roll is a
      // statement, a beat of it is a fill.
      const maxSpan = node.span;
      const spanChoices = [
        { span: maxSpan, w: 0.35 + 0.5 * depth },
        { span: Math.max(1, maxSpan >> 1), w: 1 },
        { span: Math.max(1, maxSpan >> 2), w: 0.7 },
      ];
      const span = weightedPick(rng, spanChoices).span;
      // Anchored to the END of the node: a roll that runs into the next downbeat is a fill, one
      // that starts on the downbeat and stops is a mistake.
      const start = Math.max(node.start, node.end - span);
      const source = rng.bool(0.7) ? start : borrowFrom(ctx, { start, span }, 1, { alignTo: 1 });
      return applyRoll(ctx, {
        start,
        span,
        fragmentSlots: rate.fragmentSlots,
        from: source >= 0 ? source : start,
        reverse: depth > 0.4 && rng.bool(0.18),
        accelerate: rate.fragmentSlots < 1 && rng.bool(0.3 + 0.4 * depth),
        label: "roll",
      });
    },
  },
];

const BY_KEY = new Map(OPERATIONS.map((op) => [op.key, op]));

export function operationByKey(key) {
  return BY_KEY.get(key) || null;
}

export function operationKeys() {
  return OPERATIONS.map((op) => op.key);
}

export function operationsInFamily(family) {
  return OPERATIONS.filter((op) => op.family === family);
}
