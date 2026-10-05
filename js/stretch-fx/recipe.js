// recipe.js
//
// What happens to each fragment, as plain data. A recipe is a complete, reproducible description of
// one STRETCH FX result - source region, pitch, reverse, one or two stretch passes through the
// existing character engine, saturation, crunch - so the render step (render.js) is a pure function
// of (source audio, recipe) and MUTATE is just "edit a copy of the recipe".
//
// A bank is not every combination, and it is not eight dice rolls either. It is built from
// ARCHETYPES: named musical ideas ("metal snare", "granular suck", "phrase-end mangle") that each
// know which kind of fragment they want and which way to push the stretch. That's what makes a bank
// come back with a useful spread - a recognisable stretched snare at one end, a sampler having a
// breakdown at the other - rather than eight variations on medium-broken.
//
// MELT is the one intensity control. It doesn't pick a single level for the whole bank: each
// archetype has its own base heat, and melt pulls every one of them hotter or cooler, so the range
// survives at any setting.
import { CHARACTERS } from "../dsp/stretch/characters.js";
import { pickSource, manualSource } from "./sources.js";

/** Stretch amounts a bank is drawn from, as output/input length. Past 8x is reserved for high melt. */
export const RATIO_LADDER = [1.5, 2, 3, 4, 6, 8, 12, 16];

/** Longest a single result is allowed to get, whatever the ratio - keeps memory and audition sane
 * (sixteen of these, each with its Snap Back context, is the worst case a bank can hold). */
export const MAX_FX_SECONDS = 12;

/**
 * How destructive each stretch character is, 0-1. Every character in the registry that's useful
 * for this has an entry; the corrective ones (clean, tight, transient, punch) deliberately don't,
 * because STRETCH FX is not trying to be transparent.
 */
export const CHARACTER_HEAT = {
  loose: 0.15,
  vintage: 0.2,
  grain: 0.2,
  glass: 0.25,
  cyclic: 0.3,
  phase: 0.3,
  tape: 0.35,
  choppy: 0.45,
  stutter: 0.45,
  scatter: 0.45,
  flutter: 0.45,
  cyclic12: 0.5,
  underwater: 0.5,
  cloud: 0.5,
  glitch: 0.55,
  cheap93: 0.55,
  spectral: 0.55,
  warped: 0.6,
  metallic: 0.7,
  crushed: 0.7,
  nervous: 0.7,
  shred: 0.75,
  frozen: 0.75,
  broken: 0.8,
  drone: 0.85,
  infinite: 0.9,
  destroyed: 0.95,
};

/** The simplified CHARACTER control: which corner of the stretch engine to abuse. */
export const FLAVOURS = [
  { key: "any", label: "Anything", blurb: "Every corner of the stretch engine, matched to how hard you're melting." },
  { key: "sampler", label: "Old sampler", blurb: "Cyclic Akai loops, 12-bit stutter, budget-sampler buzz.", chars: ["cyclic", "cyclic12", "vintage", "cheap93", "stutter", "choppy", "glitch", "crushed", "warped", "loose", "tape"] },
  { key: "metal", label: "Metal", blurb: "Ringing, phasey, robotic - the huge metallic snare.", chars: ["metallic", "phase", "glitch", "warped", "cyclic12", "glass", "crushed"] },
  { key: "grain", label: "Grain", blurb: "Grains, scatter, reversed specks and dropouts.", chars: ["grain", "scatter", "flutter", "shred", "nervous", "broken", "destroyed", "cloud"] },
  { key: "smear", label: "Smear", blurb: "Spectral wash, freezes and drones - the break melts into a pad.", chars: ["underwater", "spectral", "cloud", "frozen", "drone", "infinite", "phase", "glass"] },
];
export const DEFAULT_FLAVOUR = "any";

export function resolveFlavour(key) {
  return FLAVOURS.find((f) => f.key === key) || FLAVOURS[0];
}

function flavourChars(flavourKey) {
  const f = resolveFlavour(flavourKey);
  return (f.chars || Object.keys(CHARACTER_HEAT)).filter((c) => CHARACTERS[c]);
}

/**
 * The musical ideas a bank is built from, in the order an 8-bank uses them. `heat` is the
 * archetype's own base intensity; `ratios` the stretch amounts it favours; `chars` its preferred
 * characters (intersected with the CHARACTER flavour when one is chosen). `name` is what a result
 * is called when it came from the kind of fragment the archetype wants; `generic` names just the
 * treatment, for when SOURCE or a selection handed it something else - a "pitched-down crash" made
 * from the snare you dragged out would be a lie.
 */
export const ARCHETYPES = [
  { key: "stretchedSnare", generic: "gentle stretch", name: "stretched snare", sources: ["snare"], heat: 0.12, ratios: [1.5, 2, 3], chars: ["cyclic", "vintage", "grain", "loose", "glass", "phase"], reverse: "none", pitchChance: 0 },
  { key: "metalSnare", generic: "metal stretch", name: "metal snare", sources: ["snare"], heat: 0.62, ratios: [4, 6, 8], chars: ["metallic", "cyclic12", "glitch", "warped", "crushed"], drive: 0.5 },
  { key: "smearQuarter", generic: "smear", name: "smeared quarter", sources: ["1/4"], heat: 0.42, ratios: [2, 3, 4], chars: ["underwater", "spectral", "phase", "cloud", "glass"], reverse: "none" },
  { key: "granularSuck", generic: "granular suck", name: "granular suck", sources: ["hit", "snare", "1/8"], heat: 0.5, ratios: [3, 4, 6], chars: ["grain", "scatter", "cloud", "shred", "flutter"], reverse: "post", pitchChance: 0.15 },
  { key: "pitchedCrash", generic: "pitched-down stretch", name: "pitched-down crash", sources: ["hit", "1/4"], preferLabel: "cymbal", tailBeats: 1, heat: 0.38, ratios: [2, 3, 4, 6], chars: ["tape", "cyclic", "vintage", "loose", "underwater"], pitch: [-12, -7, -5], reverse: "none" },
  { key: "phraseMangle", generic: "mangle", name: "phrase-end mangle", sources: ["1/8", "1/4"], preferNotes: ["bar end", "phrase end", "into downbeat"], heat: 0.92, ratios: [6, 8, 12], chars: ["destroyed", "broken", "crushed", "shred", "infinite", "drone", "cheap93"], crunch: 0.6, passes: 0.35 },
  { key: "sixteenthBuzz", generic: "buzz", name: "sixteenth buzz", sources: ["1/16"], heat: 0.55, ratios: [4, 6, 8], chars: ["cyclic", "cyclic12", "stutter", "cheap93", "choppy"], macros: { cycle: [8, 32] } },
  { key: "downbeatThrob", generic: "throb", name: "pre-downbeat throb", sources: ["1/4", "1/8"], preferNotes: ["into downbeat", "bar end", "last beat"], heat: 0.66, ratios: [3, 4, 6], chars: ["stutter", "cyclic", "choppy", "warped", "nervous"], reverseChance: 0.4, reverseMode: "pre" },
  { key: "hitDrone", generic: "drone", name: "hit drone", sources: ["hit", "snare"], heat: 0.85, ratios: [8, 12, 16], chars: ["drone", "frozen", "infinite", "spectral"] },
  { key: "doubleStretch", generic: "resampled twice", name: "resampled twice", sources: ["snare", "1/8"], heat: 0.8, ratios: [6, 8], chars: ["cyclic12", "grain", "metallic", "spectral"], passes: 1 },
  { key: "chipmunkMetal", generic: "pitched-up metal", name: "pitched-up metal", sources: ["snare", "hit"], heat: 0.6, ratios: [3, 4, 6], chars: ["metallic", "glitch", "cyclic12", "phase"], pitch: [5, 7, 12] },
  { key: "reverseSnare", generic: "reverse stretch", name: "reverse snare", sources: ["snare"], heat: 0.35, ratios: [2, 3, 4], chars: ["cyclic", "grain", "vintage", "phase"], reverse: "pre" },
];

const DRIVE_KEYS = ["tape", "tube", "diode", "fuzz"];

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** Which archetypes a bank of `count` uses: the core eight first, extras shuffled in beyond that. */
function archetypesFor(count, rng) {
  const core = ARCHETYPES.slice(0, 8);
  if (count <= 8) {
    // Spread a small bank across the whole range rather than taking the gentle end of it.
    const picked = [];
    for (let i = 0; i < count; i++) picked.push(core[Math.round((i * (core.length - 1)) / Math.max(1, count - 1))]);
    return picked;
  }
  const extras = shuffle(ARCHETYPES.slice(8), rng);
  const out = [...core];
  for (let i = 0; out.length < count; i++) out.push(i < extras.length ? extras[i] : ARCHETYPES[rng.int(ARCHETYPES.length)]);
  return out;
}

function shuffle(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Archetype heat pulled towards the global melt setting: melt 0 cools everything, 100 heats everything. */
function heatFor(archetype, melt, rng) {
  return clamp01(archetype.heat * 0.55 + melt * 0.5 - 0.05 + rng.signed() * 0.07);
}

function pickCharacter(archetype, flavourKey, heat, rng, usedChars) {
  const allowed = new Set(flavourChars(flavourKey));
  let pool = (archetype.chars || []).filter((c) => allowed.has(c));
  if (!pool.length) pool = [...allowed];
  const weights = pool.map((c) => {
    const d = ((CHARACTER_HEAT[c] ?? 0.5) - heat) / 0.28;
    return (Math.exp(-d * d) + 0.06) * (usedChars.has(c) ? 0.3 : 1);
  });
  return pool[weightedIndex(weights, rng)];
}

function pickRatio(archetype, heat, rng, usedRatios) {
  let options = archetype.ratios.slice();
  const hi = RATIO_LADDER.indexOf(options[options.length - 1]);
  const lo = RATIO_LADDER.indexOf(options[0]);
  if (heat > 0.72 && hi < RATIO_LADDER.length - 1) options.push(RATIO_LADDER[hi + 1]);
  if (heat < 0.25 && lo > 0) options.unshift(RATIO_LADDER[lo - 1]);
  const weights = options.map((r, i) => {
    const want = heat * (options.length - 1);
    const d = (i - want) / 1.1;
    return (Math.exp(-d * d) + 0.1) * (usedRatios.has(r) ? 0.45 : 1);
  });
  return options[weightedIndex(weights, rng)];
}

function weightedIndex(weights, rng) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/** Macro slider values for a character at a given heat. Every key is set; a character reads only its own. */
function macrosFor(heat, rng, archetype) {
  const jitter = (spread) => rng.signed() * spread;
  const clampPct = (v) => Math.max(0, Math.min(100, Math.round(v)));
  const cycleRange = archetype && archetype.macros && archetype.macros.cycle;
  return {
    roughness: clampPct(35 + heat * 60 + jitter(10)),
    texture: clampPct(heat > 0.6 ? rng.range(10, 50) : rng.range(25, 80)),
    variation: clampPct(30 + heat * 65 + jitter(12)),
    smear: clampPct(30 + heat * 65 + jitter(12)),
    cycle: clampPct(cycleRange ? rng.range(cycleRange[0], cycleRange[1]) : rng.range(15, 80)),
    crossfade: clampPct(70 - heat * 55 + jitter(12)),
  };
}

/** Semitones of sampler-style (varispeed) pitch applied before stretching - 0 for none. */
function pickPitch(archetype, heat, rng) {
  if (archetype.pitch) return archetype.pitch[rng.int(archetype.pitch.length)];
  const chance = archetype.pitchChance ?? 0.12 + 0.22 * heat;
  if (!rng.bool(chance)) return 0;
  return rng.bool(0.7) ? [-12, -7, -5, -3][rng.int(4)] : [3, 5, 7, 12][rng.int(4)];
}

function pickReverse(archetype, rng) {
  if (archetype.reverse) return archetype.reverse;
  if (archetype.reverseChance && rng.bool(archetype.reverseChance)) return archetype.reverseMode || "pre";
  const r = rng.next();
  return r < 0.1 ? "pre" : r < 0.2 ? "post" : "none";
}

/**
 * Assemble one recipe. Exported for tests and for the manual-region path.
 * @returns {object} recipe
 */
export function buildRecipe({ archetype, source, heat, flavour, rng, seed, usedChars = new Set(), usedRatios = new Set() }) {
  const fragSec = source.end - source.start;
  const pitch = pickPitch(archetype, heat, rng);
  const varispeed = Math.pow(2, -pitch / 12); // length factor of the pitch step
  let ratio = pickRatio(archetype, heat, rng, usedRatios);
  // Pitching down already makes the fragment longer; keep at least a 1.5x stretch on top of that so
  // the engine is still audibly working.
  ratio = Math.max(ratio, varispeed * 1.5);
  ratio = Math.min(ratio, Math.max(1.25, MAX_FX_SECONDS / Math.max(0.01, fragSec)));

  const character = pickCharacter(archetype, flavour, heat, rng, usedChars);
  const twoPasses = archetype.passes != null ? rng.bool(archetype.passes) : heat > 0.6 && rng.bool(0.12);
  const passes = planPasses(ratio / varispeed, character, twoPasses, flavour, heat, rng, usedChars, archetype);

  const driveChance = archetype.drive ?? 0.1 + 0.35 * heat;
  const drive = rng.bool(driveChance)
    ? { type: heat > 0.7 && rng.bool(0.4) ? "fuzz" : DRIVE_KEYS[rng.int(3)], amount: Math.round(15 + heat * 50 + rng.signed() * 8) }
    : null;
  const crunchChance = archetype.crunch ?? heat * 0.35;
  const crunch = rng.bool(crunchChance) ? { bits: Math.max(5, Math.round(12 - heat * 6 + rng.signed())), rateDivide: heat > 0.6 && rng.bool(0.5) ? 2 + rng.int(3) : 1 } : null;

  // Named for what it is: "pitched-down crash" only when the fragment really is a crash.
  const natural = source.type === archetype.sources[0] && (!archetype.preferLabel || source.label === archetype.preferLabel);
  return {
    seed,
    archetype: archetype.key,
    name: natural ? archetype.name : archetype.generic || archetype.name,
    source: { ...source },
    heat,
    flavour,
    totalRatio: ratio,
    pitch,
    reverse: pickReverse(archetype, rng),
    passes,
    drive,
    crunch,
  };
}

/** Split the post-pitch stretch across one or two passes through the engine. */
function planPasses(stretch, character, twoPasses, flavour, heat, rng, usedChars, archetype) {
  const s = Math.max(1.0001, stretch);
  if (!twoPasses) return [{ character, ratio: s, macroValues: macrosFor(heat, rng, archetype) }];
  // Resampled stretching: stretch, then stretch the stretch - each pass's artifacts get stretched
  // by the next. The second pass leans smeary/granular, which is where the doubling is most audible.
  const second = pickCharacter({ chars: ["spectral", "grain", "cloud", "cyclic12", "underwater", "metallic"] }, flavour, clamp01(heat + 0.1), rng, usedChars);
  const r1 = Math.pow(s, 0.55);
  return [
    { character, ratio: r1, macroValues: macrosFor(heat, rng, archetype) },
    { character: second, ratio: s / r1, macroValues: macrosFor(clamp01(heat + 0.1), rng, null) },
  ];
}

/**
 * A whole bank.
 * @param {object} opts
 * @param {object} opts.pools        buildSourcePools() result
 * @param {object} opts.grid
 * @param {number} opts.count
 * @param {number} opts.melt         0-1
 * @param {string} opts.flavour      FLAVOURS key
 * @param {string} opts.sourceType   SOURCE_TYPES key
 * @param {{start:number,end:number}|null} [opts.manual]  a selected region - every result comes from it
 * @param {object} opts.rng
 * @param {() => number} opts.mintSeed
 */
export function planBank({ pools, grid, count, melt, flavour, sourceType, manual = null, rng, mintSeed }) {
  const archetypes = archetypesFor(count, rng);
  const used = [];
  const usedChars = new Set();
  const usedRatios = new Set();
  const recipes = [];
  for (const archetype of archetypes) {
    const heat = heatFor(archetype, melt, rng);
    let source = null;
    if (manual) source = manualSource(manual.start, manual.end);
    else {
      const types = sourceType && sourceType !== "auto" ? [sourceType] : archetype.sources;
      for (const t of types) {
        source = pickSource(pools, t, grid, rng, used, { preferLabel: archetype.preferLabel, preferNotes: archetype.preferNotes, tailBeats: archetype.tailBeats });
        if (source) break;
      }
    }
    if (!source) continue;
    used.push(source);
    const recipe = buildRecipe({ archetype, source, heat, flavour, rng, seed: mintSeed(), usedChars, usedRatios });
    for (const p of recipe.passes) usedChars.add(p.character);
    usedRatios.add(recipe.totalRatio);
    recipes.push(recipe);
  }
  // Mildest first: the bank reads from "recognisably a stretched snare" down to "what happened".
  return recipes.sort((a, b) => a.heat - b.heat);
}

/**
 * A related variation: same fragment, some of the processing nudged. Never a reroll - the source,
 * the archetype and most of the chain survive, so MUTATE feels like turning a couple of knobs on the
 * same sampler rather than pressing GENERATE on one slot.
 */
export function mutateRecipe(recipe, rng, seed) {
  const next = JSON.parse(JSON.stringify(recipe));
  next.seed = seed;
  const archetype = ARCHETYPES.find((a) => a.key === recipe.archetype) || ARCHETYPES[0];
  let changed = 0;
  next.heat = clamp01(recipe.heat + rng.signed() * 0.12);

  const fragSec = recipe.source.end - recipe.source.start;
  const varispeed = (p) => Math.pow(2, -p / 12);

  if (rng.bool(0.3)) {
    const options = [0, -12, -7, -5, 5, 7].filter((p) => p !== recipe.pitch);
    next.pitch = options[rng.int(options.length)];
    changed++;
  }
  if (rng.bool(0.6)) {
    const idx = nearestLadderIndex(recipe.totalRatio);
    const step = rng.bool(0.5) ? 1 : -1;
    next.totalRatio = RATIO_LADDER[Math.max(0, Math.min(RATIO_LADDER.length - 1, idx + step))];
    changed++;
  }
  next.totalRatio = Math.max(next.totalRatio, varispeed(next.pitch) * 1.5);
  next.totalRatio = Math.min(next.totalRatio, Math.max(1.25, MAX_FX_SECONDS / Math.max(0.01, fragSec)));

  const usedChars = new Set();
  if (rng.bool(0.45)) {
    // A neighbour in heat, from the same flavour: related, not random.
    const pool = flavourChars(recipe.flavour).filter((c) => c !== recipe.passes[0].character && Math.abs((CHARACTER_HEAT[c] ?? 0.5) - (CHARACTER_HEAT[recipe.passes[0].character] ?? 0.5)) <= 0.22);
    if (pool.length) {
      next.passes[0].character = pool[rng.int(pool.length)];
      changed++;
    }
  }
  if (rng.bool(0.2)) {
    const options = ["none", "pre", "post"].filter((r) => r !== recipe.reverse);
    next.reverse = options[rng.int(options.length)];
    changed++;
  }
  if (rng.bool(0.3)) {
    next.drive = next.drive ? (rng.bool(0.4) ? null : { ...next.drive, amount: Math.max(5, Math.min(90, next.drive.amount + Math.round(rng.signed() * 20))) }) : { type: DRIVE_KEYS[rng.int(3)], amount: Math.round(20 + next.heat * 40) };
    changed++;
  }
  if (rng.bool(0.25)) {
    next.crunch = next.crunch ? (rng.bool(0.4) ? null : { bits: Math.max(4, Math.min(12, next.crunch.bits + (rng.bool() ? -1 : 1))), rateDivide: next.crunch.rateDivide }) : { bits: Math.max(5, Math.round(11 - next.heat * 5)), rateDivide: 1 };
    changed++;
  }
  if (!changed) {
    const idx = nearestLadderIndex(recipe.totalRatio);
    next.totalRatio = RATIO_LADDER[idx < RATIO_LADDER.length - 1 ? idx + 1 : idx - 1];
    next.totalRatio = Math.min(next.totalRatio, Math.max(1.25, MAX_FX_SECONDS / Math.max(0.01, fragSec)));
  }

  // Re-split the (possibly new) stretch across the same number of passes, with fresh macros.
  const stretch = next.totalRatio / varispeed(next.pitch);
  const chars = next.passes.map((p) => p.character);
  next.passes = planPasses(stretch, chars[0], chars.length > 1, recipe.flavour, next.heat, rng, usedChars, archetype);
  if (chars.length > 1) next.passes[1].character = chars[1];
  return next;
}

function nearestLadderIndex(r) {
  let best = 0;
  for (let i = 1; i < RATIO_LADDER.length; i++) if (Math.abs(Math.log(RATIO_LADDER[i] / r)) < Math.abs(Math.log(RATIO_LADDER[best] / r))) best = i;
  return best;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export function describeMelt(v) {
  const x = v / 100;
  if (x < 0.2) return "stretched";
  if (x < 0.4) return "grainy";
  if (x < 0.6) return "melting";
  if (x < 0.8) return "malfunction";
  return "what happened";
}

export function heatWord(heat) {
  return describeMelt(heat * 100);
}

export function sourceTypeLabel(source) {
  if (!source) return "";
  if (source.type === "manual") return "SELECTION";
  if (source.type === "hit") return source.label && source.label !== "perc" ? `HIT · ${source.label}` : "HIT";
  return source.type.toUpperCase();
}

export function pitchText(pitch) {
  if (!pitch) return "no pitch";
  return pitch < 0 ? `down ${-pitch} st` : `up ${pitch} st`;
}

export function reverseText(reverse) {
  return reverse === "pre" ? "reversed, then stretched" : reverse === "post" ? "stretched, then reversed" : "forward";
}

export function characterText(recipe) {
  const names = recipe.passes.map((p) => (CHARACTERS[p.character] ? CHARACTERS[p.character].label : p.character));
  const extras = [];
  if (recipe.drive) extras.push(`${recipe.drive.type} drive`);
  if (recipe.crunch) extras.push(`${recipe.crunch.bits}-bit${recipe.crunch.rateDivide > 1 ? ` ÷${recipe.crunch.rateDivide}` : ""}`);
  return [names.join(" → "), ...extras].join(" · ");
}

/** Percent, rounded the way a sampler display would show it. */
export function ratioPct(ratio) {
  return Math.round(ratio * 100);
}
