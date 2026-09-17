// styles.js
//
// FLIP's remix types. NOT effect presets: a type changes which hierarchy LEVELS the engine works
// at, which FAMILIES of transformation it reaches for, where in the bar it prefers to intervene,
// and how it bends the user's Structure / Activity / Depth settings. Two types on identical
// settings produce structurally different music, not the same music with a different flavour.
//
// The fields:
//
// `levelWeights`   how likely each hierarchy scale is to be the one worked at. This is the single
//                  biggest lever on how a type sounds. PHRASE lives at bar and half-bar; CUT-UP
//                  lives at slice and micro; GROOVE lives at beat and half-beat.
// `familyWeights`  structural (rearrange) / micro (chop) / break (remove). ROLL and PITCH are
//                  separate passes with their own amounts, because they are colour applied on top
//                  of an arrangement rather than a way of arranging.
// `opWeights`      per-operation, within the family that was chosen.
// `structureBias`  multiplies the user's Structure. A type that is about preservation raises it.
// `activityBias`   multiplies Activity - how much of the loop gets touched at all.
// `depthBias`      multiplies Depth - how far any single intervention goes.
// `positionBias`   musical position preferences, read by positionAppeal() in hierarchy.js. This is
//                  what makes FILL put things at the ends of bars without any operation knowing
//                  what a fill is.
// `rollBias`       multiplies the user's Roll amount.
// `pitchBias`      multiplies the user's Pitch amount.
// `unlocks`        per-type override of an operation's own depth gate, for types that exist to do
//                  that thing and shouldn't wait for the slider to permit it.

export const STYLES = [
  {
    key: "gentle",
    label: "Gentle",
    blurb: "Barely touches it. Repeats a beat here, substitutes a neighbour there, leaves most of the loop alone.",
    levelWeights: { bar: 0.3, halfBar: 0.8, beat: 1.4, halfBeat: 0.6, slice: 0.2, micro: 0 },
    familyWeights: { structural: 3, micro: 0.5, break: 0.15 },
    opWeights: {
      preserve: 1.5,
      "repeat-node": 1.6,
      "substitute-near": 1.5,
      "repeat-half": 1.2,
      "motif-return": 0.7,
      "call-response": 0.6,
      aba: 0.5,
      "swap-halves": 0.4,
      jump: 0.2,
      "reverse-slice": 0.5,
      "micro-repeat": 0.4,
      "reverse-node": 0.2,
      "micro-shuffle": 0.15,
      stutter: 0.1,
      silence: 0.2,
      gap: 0.1,
      roll: 1,
    },
    structureBias: 1.25,
    activityBias: 0.5,
    depthBias: 0.5,
    positionBias: { downbeat: 0.5, offBeat: 1.3 },
    rollBias: 0.35,
    pitchBias: 0.35,
  },

  {
    key: "groove",
    label: "Groove",
    blurb: "Rhythmic reinterpretation. Beats and half-beats move around inside bars that stay put.",
    levelWeights: { bar: 0.2, halfBar: 0.7, beat: 2.2, halfBeat: 1.6, slice: 0.5, micro: 0.15 },
    familyWeights: { structural: 2.4, micro: 1.1, break: 0.5 },
    opWeights: {
      "repeat-node": 1.8,
      "repeat-half": 1.8,
      aba: 1.6,
      "substitute-near": 1.4,
      "swap-halves": 1.2,
      "call-response": 1.1,
      "micro-repeat": 1.1,
      jump: 0.7,
      "motif-return": 0.5,
      preserve: 0.6,
      "micro-shuffle": 0.8,
      "reverse-slice": 0.6,
      "reverse-node": 0.4,
      stutter: 0.6,
      silence: 0.7,
      gap: 0.6,
      roll: 1,
    },
    structureBias: 1.05,
    activityBias: 1,
    depthBias: 0.9,
    positionBias: { endOfBar: 1.3, offBeat: 1.2 },
    rollBias: 0.8,
    pitchBias: 0.6,
  },

  {
    key: "phrase",
    label: "Phrase",
    blurb: "Large-scale musical restructuring. Bars and half-bars move, repeat and answer each other.",
    levelWeights: { bar: 2.2, halfBar: 2.0, beat: 0.9, halfBeat: 0.25, slice: 0.1, micro: 0.05 },
    familyWeights: { structural: 3.4, micro: 0.6, break: 0.25 },
    opWeights: {
      "repeat-node": 1.8,
      "motif-return": 1.9,
      "call-response": 1.7,
      "substitute-near": 1.6,
      "swap-halves": 1.4,
      aba: 1.4,
      "repeat-half": 1.2,
      jump: 1.0,
      preserve: 0.9,
      "reverse-node": 0.5,
      "micro-repeat": 0.4,
      "reverse-slice": 0.3,
      "micro-shuffle": 0.2,
      stutter: 0.2,
      silence: 0.3,
      gap: 0.4,
      roll: 1,
    },
    structureBias: 1.1,
    activityBias: 0.85,
    depthBias: 0.85,
    positionBias: { endOfPhrase: 1.4, late: 1.2 },
    rollBias: 0.5,
    pitchBias: 1.25,
  },

  {
    key: "fill",
    label: "Fill",
    blurb: "Leaves the loop alone and adds fills - rolls, repeats and reverses at the ends of bars and the end of the phrase.",
    levelWeights: { bar: 0.3, halfBar: 0.8, beat: 1.8, halfBeat: 1.2, slice: 0.5, micro: 0.3 },
    familyWeights: { structural: 1.1, micro: 1.5, break: 0.6 },
    opWeights: {
      "micro-repeat": 1.8,
      "repeat-node": 1.2,
      "reverse-node": 1.0,
      "reverse-slice": 0.9,
      "repeat-half": 0.9,
      stutter: 0.9,
      gap: 0.8,
      preserve: 0.8,
      "substitute-near": 0.5,
      "micro-shuffle": 0.5,
      silence: 0.5,
      aba: 0.3,
      "call-response": 0.3,
      "motif-return": 0.2,
      "swap-halves": 0.2,
      jump: 0.1,
      roll: 1,
    },
    structureBias: 1.2,
    activityBias: 0.45,
    depthBias: 1.0,
    // The whole personality, expressed as position rather than as operations: everything this type
    // does, it does at the end of something.
    positionBias: { endOfBar: 4.5, endOfPhrase: 5, lastBar: 2.6, late: 1.8, downbeat: 0.25 },
    rollBias: 2.2,
    rollPosition: { endOfBar: 5, endOfPhrase: 6, lastBar: 3, late: 2 },
    pitchBias: 0.7,
  },

  {
    key: "repeater",
    label: "Repeater",
    blurb: "Builds motifs by repeating what's already there - beats, half-bars, groups. Not stutter.",
    levelWeights: { bar: 0.8, halfBar: 1.8, beat: 1.8, halfBeat: 0.9, slice: 0.3, micro: 0.15 },
    familyWeights: { structural: 3.6, micro: 0.7, break: 0.2 },
    opWeights: {
      "repeat-node": 3,
      "repeat-half": 2.4,
      aba: 2.0,
      "motif-return": 1.6,
      "call-response": 1.3,
      "micro-repeat": 1.2,
      "substitute-near": 0.7,
      preserve: 0.6,
      "swap-halves": 0.4,
      jump: 0.3,
      "reverse-slice": 0.3,
      "reverse-node": 0.3,
      "micro-shuffle": 0.2,
      stutter: 0.25,
      silence: 0.2,
      gap: 0.3,
      roll: 1,
    },
    structureBias: 1.1,
    activityBias: 1,
    depthBias: 0.8,
    positionBias: { late: 1.3 },
    rollBias: 0.7,
    pitchBias: 0.95,
  },

  {
    key: "cutup",
    label: "Cut-up",
    blurb: "Aggressive small-scale rearrangement. Where the glitchier end of FLIP lives.",
    levelWeights: { bar: 0.15, halfBar: 0.5, beat: 1.2, halfBeat: 1.8, slice: 2.2, micro: 1.4 },
    familyWeights: { structural: 1.2, micro: 3, break: 1 },
    opWeights: {
      stutter: 2.4,
      "micro-shuffle": 2.0,
      "reverse-slice": 1.8,
      "micro-repeat": 1.6,
      "reverse-node": 1.2,
      jump: 1.2,
      "substitute-near": 1.0,
      silence: 1.0,
      "repeat-node": 0.8,
      "swap-halves": 0.7,
      gap: 0.6,
      "repeat-half": 0.5,
      aba: 0.4,
      "call-response": 0.3,
      "motif-return": 0.2,
      preserve: 0.3,
      roll: 1,
    },
    structureBias: 0.7,
    activityBias: 1.2,
    depthBias: 1.25,
    positionBias: { offBeat: 1.4, downbeat: 0.7 },
    rollBias: 1.2,
    pitchBias: 0.6,
    unlocks: { stutter: 0.05, "micro-shuffle": 0, silence: 0 },
  },

  {
    key: "reconstruct",
    label: "Reconstruct",
    blurb: "Rebuilds the phrase. Bars and beats change places; the loop is still the same length and the same material.",
    levelWeights: { bar: 1.8, halfBar: 1.8, beat: 1.6, halfBeat: 0.7, slice: 0.3, micro: 0.15 },
    familyWeights: { structural: 3, micro: 1.2, break: 0.6 },
    opWeights: {
      jump: 2.2,
      "substitute-near": 2.0,
      "swap-halves": 1.8,
      "motif-return": 1.4,
      "repeat-node": 1.2,
      aba: 1.0,
      "call-response": 1.0,
      "repeat-half": 0.9,
      "reverse-node": 0.8,
      "micro-shuffle": 0.7,
      "micro-repeat": 0.6,
      "reverse-slice": 0.5,
      stutter: 0.4,
      silence: 0.5,
      gap: 0.5,
      preserve: 0.4,
      roll: 1,
    },
    structureBias: 0.75,
    activityBias: 1.15,
    depthBias: 1.1,
    positionBias: {},
    rollBias: 0.6,
    pitchBias: 0.95,
  },

  {
    key: "wild",
    label: "Wild",
    blurb: "The whole vocabulary, at every scale, all at once. Expect to throw most of these away.",
    levelWeights: { bar: 1.2, halfBar: 1.3, beat: 1.4, halfBeat: 1.2, slice: 1.2, micro: 0.9 },
    familyWeights: { structural: 2, micro: 2, break: 1.2 },
    opWeights: {
      jump: 1.4,
      stutter: 1.3,
      "micro-shuffle": 1.2,
      "reverse-node": 1.2,
      "reverse-slice": 1.2,
      "substitute-near": 1.2,
      "repeat-node": 1.2,
      "swap-halves": 1.1,
      "micro-repeat": 1.1,
      aba: 1.0,
      "repeat-half": 1.0,
      "call-response": 1.0,
      "motif-return": 1.0,
      silence: 1.0,
      gap: 0.9,
      preserve: 0.3,
      roll: 1,
    },
    structureBias: 0.55,
    activityBias: 1.4,
    depthBias: 1.45,
    positionBias: {},
    rollBias: 1.3,
    pitchBias: 1.4,
    unlocks: { stutter: 0, silence: 0, "micro-shuffle": 0, "reverse-node": 0, gap: 0.05 },
  },

  {
    key: "mixed",
    label: "Mixed",
    blurb: "A bit of everything at every scale, still trying to sound like a version of your loop. The good default.",
    levelWeights: { bar: 1.2, halfBar: 1.4, beat: 1.5, halfBeat: 0.9, slice: 0.5, micro: 0.25 },
    familyWeights: { structural: 2.6, micro: 1.1, break: 0.5 },
    opWeights: {
      "repeat-node": 1.6,
      "substitute-near": 1.5,
      "repeat-half": 1.3,
      "motif-return": 1.3,
      "call-response": 1.2,
      aba: 1.1,
      "swap-halves": 1.0,
      jump: 1.0,
      "micro-repeat": 0.9,
      preserve: 0.8,
      "reverse-node": 0.7,
      "reverse-slice": 0.7,
      "micro-shuffle": 0.5,
      stutter: 0.5,
      silence: 0.5,
      gap: 0.4,
      roll: 1,
    },
    structureBias: 1,
    activityBias: 1,
    depthBias: 1,
    positionBias: { endOfBar: 1.3, late: 1.15 },
    rollBias: 0.9,
    pitchBias: 1.0,
  },
];

export const DEFAULT_STYLE = "mixed";

const BY_KEY = new Map(STYLES.map((s) => [s.key, s]));

export function resolveStyle(key) {
  return BY_KEY.get(key) || BY_KEY.get(DEFAULT_STYLE);
}

export function styleKeys() {
  return STYLES.map((s) => s.key);
}

/** Words for the three headline sliders, so a number always has a meaning next to it. */
export function describeStructure(value) {
  const v = clampPct(value);
  if (v >= 85) return "structure held";
  if (v >= 60) return "bars stay put";
  if (v >= 35) return "bars can move";
  if (v >= 15) return "loose";
  return "anything goes";
}

export function describeActivity(value) {
  const v = clampPct(value);
  if (v >= 85) return "constant";
  if (v >= 60) return "busy";
  if (v >= 35) return "occasional";
  if (v >= 15) return "sparse";
  return "almost nothing";
}

export function describeDepth(value) {
  const v = clampPct(value);
  if (v >= 85) return "extreme";
  if (v >= 60) return "bold";
  if (v >= 35) return "moderate";
  if (v >= 15) return "subtle";
  return "barely there";
}

function clampPct(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

/**
 * The single "how far from the original is this" word, kept because the variation rows want one
 * number to sort your ear by. Derived from the three controls rather than being a fourth one.
 */
export function describeIntensity(intensity) {
  const t = clampPct(intensity);
  if (t < 15) return "barely touched";
  if (t < 35) return "conservative";
  if (t < 55) return "recognisable";
  if (t < 75) return "loose";
  if (t < 90) return "wrecked";
  return "destructive";
}
