// hierarchy.js
//
// A loop is not a flat list of slices. It is a PHRASE made of BARS made of HALF-BARS made of BEATS
// made of HALF-BEATS made of SLICES, and the difference between a remix and a glitch plugin is
// whether the machine knows that.
//
// FLIP's first version worked entirely at slice level: every operation picked a beat-aligned anchor
// and moved a beat or two of material. That produces edits of roughly one size everywhere, which is
// why the results all sounded like the same processing applied at the same rate - the engine had no
// way to express "leave bar 1 completely alone, rebuild bar 3 at beat level, and put a 1/32 roll on
// the last beat of bar 4". This module is what it reasons over instead.
//
// Everything is derived from the slice map (js/flip/slice-map.js) and measured in SLICES, so the
// renderer and the duration guarantee are untouched: a node is just a span of slots.

/** Coarsest to finest. A remix picks a level to work at, then a node at that level. */
export const LEVELS = ["phrase", "bar", "halfBar", "beat", "halfBeat", "slice", "micro"];

export const LEVEL_LABELS = {
  phrase: "phrase",
  bar: "bar",
  halfBar: "half-bar",
  beat: "beat",
  halfBeat: "half-beat",
  slice: "slice",
  micro: "micro",
};

/** How many slices one node at this level spans, or 0 when the grid is too coarse to have them. */
export function levelSpan(map, level) {
  const beat = Math.max(1, map.perBeat);
  const bar = Math.max(beat, map.perBar);
  switch (level) {
    case "phrase":
      return map.count;
    case "bar":
      return bar;
    case "halfBar":
      return bar >= 2 ? bar >> 1 : 0;
    case "beat":
      return beat;
    case "halfBeat":
      return beat >= 2 ? beat >> 1 : 0;
    case "slice":
      return 1;
    // MICRO is the one level that doesn't map onto a whole number of slices - it lives BELOW the
    // grid, inside a single slot, and is reached by subdividing rather than by spanning. It still
    // belongs in the hierarchy because operations choose it the same way they choose any other
    // level; it just renders through a step's own stutter count. See the ROLL family.
    case "micro":
      return 1;
    default:
      return 0;
  }
}

/** Is this level meaningful for this grid? A 1/4 grid has no half-beats worth speaking of. */
export function levelExists(map, level) {
  const span = levelSpan(map, level);
  if (span <= 0) return false;
  if (level === "phrase") return map.count >= 2;
  // A level only exists if there are at least two of them to move around relative to each other.
  return span <= map.count / 2 || level === "slice" || level === "micro";
}

export function availableLevels(map) {
  return LEVELS.filter((level) => levelExists(map, level));
}

/**
 * One node: a contiguous run of slots that means something musically.
 *
 * `role` is where it sits in its parent, which is what lets position-aware weighting be written as
 * "fills go at the end of things" rather than as arithmetic on slice indices at every call site.
 */
function makeNode(map, level, index, start, span, total) {
  const end = Math.min(map.count, start + span);
  const count = Math.max(1, Math.ceil(map.count / span));
  const slice = map.slices[start];
  return {
    level,
    index,
    start,
    end,
    span: end - start,
    /** 0..1 position within the phrase. */
    position: map.count > 1 ? start / map.count : 0,
    isFirst: index === 0,
    isLast: index === total - 1,
    /** Last node of its parent bar - the classic place for a fill. */
    endsBar: map.perBar > 0 ? (end % map.perBar === 0 || end >= map.count) : false,
    endsPhrase: end >= map.count,
    isDownbeat: !!(slice && slice.isDownbeat),
    isBeat: !!(slice && slice.isBeat),
    strength: slice ? slice.strength : 0.5,
    nodeCount: count,
  };
}

/** Every node at `level`, in order. The last one is clipped to the end of the phrase. */
export function nodesAtLevel(map, level) {
  const span = levelSpan(map, level);
  if (span <= 0) return [];
  if (level === "phrase") return [makeNode(map, level, 0, 0, map.count, 1)];
  const total = Math.ceil(map.count / span);
  const out = [];
  for (let i = 0; i < total; i++) out.push(makeNode(map, level, i, i * span, span, total));
  return out;
}

/**
 * The whole tree, built once per generation and handed to every decision.
 *
 * Deliberately precomputed rather than derived on demand: the generator walks it repeatedly (choose
 * a bar, choose a level inside it, choose a node at that level) and rebuilding the node lists inside
 * that loop showed up as the single hottest thing in a batch of sixteen 1/32 variations.
 */
export function buildHierarchy(map) {
  const levels = {};
  for (const level of LEVELS) levels[level] = nodesAtLevel(map, level);
  return {
    map,
    levels,
    available: availableLevels(map),
    /** Nodes at `level` that lie entirely inside `node`. */
    childrenOf(node, level) {
      return (levels[level] || []).filter((n) => n.start >= node.start && n.end <= node.end);
    },
    nodeAt(level, sliceIndex) {
      const span = levelSpan(map, level);
      if (span <= 0) return null;
      const list = levels[level] || [];
      return list[Math.floor(sliceIndex / span)] || null;
    },
  };
}

/**
 * How attractive is this node as a place to put an edit, given a positional preference?
 *
 * `bias` is a remix type's personality expressed as musical position rather than as indices:
 * FILL wants the ends of bars and the end of the phrase, PHRASE wants bar lines, CUT-UP doesn't
 * care. Returns a multiplier, never zero, so a preference stays a preference.
 */
export function positionAppeal(node, bias) {
  if (!bias) return 1;
  let appeal = 1;
  if (bias.endOfBar && node.endsBar) appeal *= bias.endOfBar;
  if (bias.endOfPhrase && node.endsPhrase) appeal *= bias.endOfPhrase;
  if (bias.lastBar && node.position >= 0.75) appeal *= bias.lastBar;
  if (bias.downbeat && node.isDownbeat) appeal *= bias.downbeat;
  if (bias.offBeat && !node.isBeat) appeal *= bias.offBeat;
  if (bias.late) appeal *= 1 + (bias.late - 1) * node.position;
  return Math.max(0.01, appeal);
}
