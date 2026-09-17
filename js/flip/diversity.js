// diversity.js
//
// Why eight variations of the same settings shouldn't be eight siblings.
//
// A batch generated from one set of parameters with eight different seeds explores exactly one
// region of the space eight times. The seeds make the details differ; the character doesn't. You
// end up auditioning eight takes on the same idea and concluding FLIP has one trick.
//
// So each slot in a batch gets a PROFILE: a small, named push away from the user's settings in a
// different direction - one variation leans structural and conservative, another mostly leaves the
// loop alone but puts one ridiculous roll at the end, another goes after pitch. The user's settings
// stay the centre of the distribution; the profiles spread the batch around it, and every profile
// still obeys the chosen remix type.
//
// `entry` is how keen this slot is to start the loop somewhere other than where the source started
// it. Spreading THAT across a batch matters more than spreading anything else, because the opening
// is the first thing you hear and eight variations that all begin identically read as one result.
//
// The multipliers are deliberately modest. This is meant to widen a batch, not to ignore what was
// asked for - with Activity at 10 nothing here will produce a busy variation.

export const PROFILES = [
  {
    key: "faithful",
    label: "close to the original",
    structure: 1.3,
    activity: 0.55,
    depth: 0.6,
    entry: 0.25,
    roll: 0.5,
    pitch: 0.4,
    levels: { bar: 0.5, halfBar: 0.9, beat: 1.2, halfBeat: 1, slice: 0.7, micro: 0.4 },
    families: { structural: 1.5, micro: 0.7, break: 0.5 },
  },
  {
    key: "structural",
    label: "structural repetition",
    structure: 1.15,
    activity: 1,
    depth: 0.85,
    entry: 0.9,
    roll: 0.6,
    pitch: 0.6,
    levels: { bar: 1.1, halfBar: 1.5, beat: 1.2, halfBeat: 0.6, slice: 0.3, micro: 0.2 },
    families: { structural: 2, micro: 0.5, break: 0.4 },
  },
  {
    key: "rearranged",
    label: "phrase rearrangement",
    structure: 0.65,
    activity: 1.1,
    depth: 1.05,
    entry: 1.7,
    roll: 0.7,
    pitch: 0.8,
    levels: { bar: 1.9, halfBar: 1.7, beat: 0.9, halfBeat: 0.4, slice: 0.25, micro: 0.15 },
    families: { structural: 1.9, micro: 0.6, break: 0.6 },
  },
  {
    key: "melodic",
    label: "pitch mutation",
    structure: 1.1,
    activity: 0.8,
    depth: 1,
    entry: 0.8,
    roll: 0.7,
    // The one profile that exists to make pitch happen. Still multiplicative, so Pitch at 0 stays 0.
    pitch: 2.6,
    levels: { bar: 0.7, halfBar: 1.2, beat: 1.4, halfBeat: 0.8, slice: 0.5, micro: 0.3 },
    families: { structural: 1.6, micro: 0.8, break: 0.3 },
  },
  {
    key: "one-gesture",
    label: "mostly untouched, one big gesture",
    structure: 1.35,
    // Almost nothing happens - and then one thing really does. The combination is the point, and it
    // is the single most useful variation in a batch: it is the one you can actually use.
    activity: 0.3,
    depth: 1.5,
    entry: 0.4,
    roll: 2.4,
    pitch: 0.7,
    levels: { bar: 0.4, halfBar: 0.8, beat: 1.5, halfBeat: 1.2, slice: 0.8, micro: 0.6 },
    families: { structural: 1, micro: 1.4, break: 0.8 },
  },
  {
    key: "beatwise",
    label: "beat-level reconstruction",
    structure: 0.85,
    activity: 1.25,
    depth: 1,
    entry: 1.2,
    roll: 0.9,
    pitch: 0.6,
    levels: { bar: 0.3, halfBar: 0.8, beat: 2.2, halfBeat: 1.5, slice: 0.6, micro: 0.3 },
    families: { structural: 1.6, micro: 1.2, break: 0.7 },
  },
  {
    key: "substituted",
    label: "large-scale substitution",
    structure: 0.6,
    activity: 0.9,
    depth: 1.15,
    entry: 1.6,
    roll: 0.6,
    pitch: 0.9,
    levels: { bar: 2.2, halfBar: 1.4, beat: 0.7, halfBeat: 0.35, slice: 0.2, micro: 0.1 },
    families: { structural: 2.2, micro: 0.5, break: 0.7 },
  },
  {
    key: "fractured",
    label: "multi-scale mutation",
    structure: 0.55,
    activity: 1.35,
    depth: 1.4,
    entry: 1.4,
    roll: 1.3,
    pitch: 0.9,
    levels: { bar: 0.9, halfBar: 1, beat: 1.2, halfBeat: 1.3, slice: 1.6, micro: 1.2 },
    families: { structural: 1.1, micro: 2, break: 1.2 },
  },
];

export const NEUTRAL_PROFILE = {
  key: "neutral",
  label: "",
  structure: 1,
  activity: 1,
  depth: 1,
  entry: 1,
  roll: 1,
  pitch: 1,
  levels: {},
  families: {},
};

export function profileByKey(key) {
  return PROFILES.find((p) => p.key === key) || NEUTRAL_PROFILE;
}

/**
 * The profiles for one batch of `count` variations, in the order the rows will appear.
 *
 * Shuffled per batch rather than fixed, so pressing GENERATE again doesn't give you the same eight
 * characters in the same eight positions - the batch should feel freshly dealt, not re-rolled.
 * Slot 0 is always the most faithful one, though: the top of the list is where you look first, and
 * something recognisably close to your loop is the right thing to find there.
 */
export function profilesForBatch(rng, count) {
  const pool = PROFILES.filter((p) => p.key !== "faithful");
  // Fisher-Yates with the shared seeded generator - no Math.random anywhere in FLIP.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out = [profileByKey("faithful")];
  for (let i = 1; i < count; i++) out.push(pool[(i - 1) % pool.length]);
  return out.slice(0, Math.max(1, count));
}
