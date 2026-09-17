// presets.js
//
// Eight starting points that already sound like something.
//
// The three sliders plus a remix type plus roll and pitch amounts is an honest model of what FLIP
// can do, and a bad way to be asked to begin. Nobody wants to discover that Structure 85 / Activity
// 30 / Depth 65 / Rolls 90 is "the fills one" by sweeping four controls; they want a button that
// says Fills. The RS7000's Loop Remix has the same shape underneath - a division rule crossed with
// a treatment category - and exposes it as numbered TYPE and VARIATION presets for exactly this
// reason.
//
// A preset also picks a CHOP SIZE, because the grid is half of what a remix type sounds like: Bar
// swap wants half-bar blocks to move around, Stutter wants sixteenths to break up. Leaving the grid
// on whatever was last used made half the presets sound like each other.
//
// Every preset is a full settings snapshot, so clicking one is always a complete, coherent state
// rather than a partial nudge that leaves a stale slider behind. They are named for what you will
// HEAR, not for the mechanism: "Fills", not "high roll amount with end-of-bar bias".
//
// These are starting points, not modes - move any slider afterwards and the chip simply stops being
// highlighted. Nothing is locked.

export const PRESETS = [
  {
    key: "subtle",
    label: "Subtle",
    blurb: "Your loop, with something quietly different about it. Whole bars untouched.",
    settings: { subdivision: "1/8", style: "gentle", structure: 88, activity: 25, depth: 30, rollAmount: 15, pitchMode: "inkey", pitchAmount: 20 },
  },
  {
    key: "barswap",
    label: "Bar swap",
    blurb: "Bars and half-bars change places, repeat and answer each other. The phrase gets rewritten; the material doesn't.",
    settings: { subdivision: "1/2bar", style: "phrase", structure: 45, activity: 55, depth: 50, rollAmount: 20, pitchMode: "inkey", pitchAmount: 30 },
  },
  {
    key: "newgroove",
    label: "New groove",
    blurb: "Same bars, different rhythm. Beats and half-beats move around inside the structure.",
    settings: { subdivision: "1/8", style: "groove", structure: 70, activity: 60, depth: 50, rollAmount: 40, pitchMode: "inkey", pitchAmount: 25 },
  },
  {
    key: "fills",
    label: "Fills",
    blurb: "Leaves the loop alone and adds fills at the ends of bars and the end of the phrase.",
    settings: { subdivision: "1/16", style: "fill", structure: 85, activity: 30, depth: 65, rollAmount: 90, pitchMode: "inkey", pitchAmount: 25 },
  },
  {
    key: "melodic",
    label: "Melodic",
    blurb: "Finds a new tune in the one you already had - repeats transposed through the key in thirds and fifths.",
    settings: { subdivision: "1/4", style: "phrase", structure: 72, activity: 45, depth: 60, rollAmount: 25, pitchMode: "inkey", pitchAmount: 85 },
  },
  {
    key: "stutter",
    label: "Stutter",
    blurb: "The glitchy end. Micro-slices, rolls and rapid repeats, still hung off the beat grid.",
    settings: { subdivision: "1/16", style: "cutup", structure: 45, activity: 65, depth: 80, rollAmount: 65, pitchMode: "octaves", pitchAmount: 25 },
  },
  {
    key: "rebuild",
    label: "Rebuild",
    blurb: "Takes the phrase apart and puts it back in a different order. Same length, same material, new arrangement.",
    settings: { subdivision: "1/4", style: "reconstruct", structure: 30, activity: 70, depth: 65, rollAmount: 40, pitchMode: "inkey", pitchAmount: 45 },
  },
  {
    key: "destroy",
    label: "Destroy",
    blurb: "Everything, at every scale, as far as it goes. Most of these are rubbish. One of them won't be.",
    settings: { subdivision: "1/16", style: "wild", structure: 12, activity: 88, depth: 95, rollAmount: 80, pitchMode: "mixed", pitchAmount: 65 },
  },
];

/** The settings FLIP opens on: broad enough to be a fair first impression of everything it does. */
export const DEFAULT_SETTINGS = {
  subdivision: "1/16",
  style: "mixed",
  structure: 65,
  activity: 45,
  depth: 50,
  rollAmount: 35,
  pitchMode: "inkey",
  pitchAmount: 45,
};

export function presetByKey(key) {
  return PRESETS.find((p) => p.key === key) || null;
}

/**
 * Which preset (if any) the current settings correspond to, so the chip row can show where you are.
 *
 * Exact match rather than nearest: a preset chip lighting up when you are merely near it would be
 * a lie about what you are listening to, and the whole value of a preset is knowing you are on it.
 */
export function matchPreset(state) {
  return (
    PRESETS.find((preset) =>
      Object.entries(preset.settings).every(([field, value]) => state[field] === value)
    ) || null
  );
}
