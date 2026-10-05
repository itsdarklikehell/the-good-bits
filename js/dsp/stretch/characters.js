// characters.js
//
// The full stretch-character palette: data, not a giant if/else chain. Each
// entry names a DSP engine (see index.js for the dispatcher) plus that
// engine's own parameters, a user-facing group/label/description, and -
// where it makes creative sense - up to two "macro" controls a listener can
// reach for without knowing what an FFT hop size is.
//
// Backwards compatibility: the five character ids this app shipped with
// before this palette existed (clean, vintage, glitch, warped, crushed) are
// kept as real entries with their EXACT original DSP parameters, just
// grouped and (re-)described alongside everything new. A saved setting with
// one of those ids resolves to the identical sound it always did - see
// resolveCharacter() below, which is also the fallback for any id this
// version of the app no longer recognises.

export const GROUPS = [
  { key: "clean", label: "Clean / Rhythmic" },
  { key: "oldDigital", label: "Old Digital" },
  { key: "granular", label: "Granular" },
  { key: "spectral", label: "Spectral" },
  { key: "experimental", label: "Experimental" },
];

/** Macro-control metadata. Every macro is a 0-100 slider that is a no-op (factor 1) at its default. */
export const MACROS = {
  texture: { label: "Grain size", hint: "Smaller = fine grain buzz, larger = smoother blur.", default: 50 },
  variation: { label: "Variation", hint: "How unstable the grains are - position, pitch, reversal.", default: 50 },
  smear: { label: "Smear", hint: "How far the spectral texture drifts from the original.", default: 50 },
  roughness: { label: "Roughness", hint: "How hard the digital artifacts bite.", default: 50 },
  cycle: { label: "Cycle length", hint: "Shorter = buzzy, pitched stutter; longer = audible ghosted repeats.", default: 50 },
  crossfade: { label: "Crossfade", hint: "Lower = hard, clicky joins; higher = smoother, more phasey.", default: 50 },
};

function macroFactor(macroValues, key) {
  const v = macroValues && typeof macroValues[key] === "number" ? macroValues[key] : MACROS[key].default;
  return Math.max(0, Math.min(2, v / 50));
}

function applyGranularMacros(params, macroValues) {
  const texture = macroFactor(macroValues, "texture");
  const variation = macroFactor(macroValues, "variation");
  const out = { ...params };
  out.grainMs = Math.max(6, params.grainMs * texture);
  out.posJitterMs = (params.posJitterMs || 0) * variation;
  out.timeJitterMs = (params.timeJitterMs || 0) * variation;
  out.pitchJitterCents = (params.pitchJitterCents || 0) * variation;
  out.reverseProb = Math.max(0, Math.min(0.95, (params.reverseProb || 0) * variation));
  out.dropoutProb = Math.max(0, Math.min(0.85, (params.dropoutProb || 0) * variation));
  return out;
}

function applySpectralMacros(params, macroValues) {
  const smear = macroFactor(macroValues, "smear");
  const out = { ...params };
  if (typeof out.smear === "number") out.smear = Math.max(0, Math.min(1, out.smear * smear));
  if (typeof out.phaseRandomize === "number") out.phaseRandomize = Math.max(0, Math.min(1, out.phaseRandomize * smear));
  if (typeof out.holdMs === "number") out.holdMs = Math.max(40, out.holdMs * smear);
  return out;
}

function applyOldDigitalMacros(params, macroValues) {
  const roughness = macroFactor(macroValues, "roughness");
  const out = { ...params };
  // bitDepth/searchMs cover most WSOLA old-digital characters, but a couple (choppy, warped) start
  // with no bit-crush and no search at all - windowMs (shorter window = choppier splices) is what
  // keeps "roughness" doing something audible for those too, and it's a harmless extra push for
  // the ones bitDepth/searchMs already cover.
  if (typeof out.windowMs === "number") out.windowMs = Math.max(4, out.windowMs / Math.max(0.4, roughness));
  if (typeof out.bitDepth === "number") out.bitDepth = Math.max(1, Math.min(16, Math.round(out.bitDepth / Math.max(0.35, roughness))));
  if (typeof out.searchMs === "number") out.searchMs = Math.max(0, out.searchMs / Math.max(0.5, roughness));
  if (typeof out.repeatJitter === "number") out.repeatJitter = Math.max(0, Math.min(1, out.repeatJitter + Math.max(0, roughness - 1)));
  if (typeof out.chunkMs === "number") out.chunkMs = Math.max(8, out.chunkMs / Math.max(0.4, roughness));
  return out;
}

function applyCyclicMacros(params, macroValues) {
  const out = { ...params };
  // Cycle length is exponential - each 25 points halves or doubles it, so 0-100 spans a quarter to
  // four times the character's own cycle, which is the useful range from buzz to obvious repeats.
  const cycleV = macroValues && typeof macroValues.cycle === "number" ? macroValues.cycle : MACROS.cycle.default;
  out.cycleMs = Math.max(3, params.cycleMs * Math.pow(2, (cycleV - 50) / 25));
  out.crossfade = Math.max(0, Math.min(0.5, params.crossfade * macroFactor(macroValues, "crossfade")));
  return out;
}

const MACRO_APPLIERS = { granular: applyGranularMacros, spectral: applySpectralMacros, oldDigital: applyOldDigitalMacros, cyclic: applyCyclicMacros };

/** Character registry. `params` are the engine's own defaults; `macros` (if present) name which macro sliders apply and which family's mapping resolves them. */
export const CHARACTERS = {
  // --- CLEAN / RHYTHMIC ---------------------------------------------------
  clean: {
    label: "Clean",
    group: "clean",
    engine: "wsola",
    description: "Smooth general-purpose stretch. Good default for most material.",
    params: { windowMs: 46, searchMs: 14, hopFraction: 0.5, bitDepth: null },
  },
  tight: {
    label: "Tight",
    group: "clean",
    engine: "wsola",
    description: "Short-window WSOLA tuned for percussive, rhythmic material.",
    params: { windowMs: 18, searchMs: 9, hopFraction: 0.5, bitDepth: null },
  },
  transient: {
    label: "Transient",
    group: "clean",
    engine: "phaseVocoder",
    description: "Phase-locked vocoder that protects drum hits from smearing.",
    params: { fftMs: 40, overlap: 4, phaseLocking: true, phaseRandomize: 0, transientReset: true, transientSensitivity: 0.5 },
  },
  punch: {
    label: "Punch",
    group: "clean",
    engine: "phaseVocoder",
    description: "Harder transient snap - shorter analysis window, more aggressive phase reset.",
    params: { fftMs: 20, overlap: 3, phaseLocking: true, phaseRandomize: 0, transientReset: true, transientSensitivity: 0.8 },
  },

  // --- OLD DIGITAL ----------------------------------------------------------
  vintage: {
    label: "Vintage",
    group: "oldDigital",
    engine: "wsola",
    description: "Short-window digital stretch with audible movement.",
    params: { windowMs: 24, searchMs: 5, hopFraction: 0.5, bitDepth: 12 },
    macros: ["roughness"],
    macroFamily: "oldDigital",
    legacy: true,
  },
  loose: {
    label: "Loose",
    group: "oldDigital",
    engine: "wsola",
    description: "Longer grains, minimal search - smeared timing, still musical.",
    params: { windowMs: 75, searchMs: 6, hopFraction: 0.5, bitDepth: null },
    macros: ["roughness"],
    macroFamily: "oldDigital",
  },
  choppy: {
    label: "Choppy",
    group: "oldDigital",
    engine: "wsola",
    description: "Short grains, gapped hop, no search - stuttery and broken-up.",
    params: { windowMs: 14, searchMs: 0, hopFraction: 0.75, bitDepth: null },
    macros: ["roughness"],
    macroFamily: "oldDigital",
  },
  glitch: {
    label: "Glitch",
    group: "oldDigital",
    engine: "wsola",
    description: "Metallic, low-bit.",
    params: { windowMs: 12, searchMs: 0, hopFraction: 0.5, bitDepth: 8 },
    macros: ["roughness"],
    macroFamily: "oldDigital",
    legacy: true,
  },
  warped: {
    label: "Warped",
    group: "oldDigital",
    engine: "wsola",
    description: "Choppy grains, wobbly pitch.",
    params: { windowMs: 8, searchMs: 0, hopFraction: 0.5, bitDepth: null },
    macros: ["roughness"],
    macroFamily: "oldDigital",
    legacy: true,
  },
  crushed: {
    label: "Crushed",
    group: "oldDigital",
    engine: "wsola",
    description: "Smooth grains, heavy crush.",
    params: { windowMs: 30, searchMs: 10, hopFraction: 0.5, bitDepth: 6 },
    macros: ["roughness"],
    macroFamily: "oldDigital",
    legacy: true,
  },
  stutter: {
    label: "Stutter",
    group: "oldDigital",
    engine: "repeat",
    description: "Primitive chunk repetition - buzzy, rhythmic digital stutter.",
    params: { chunkMs: 90, crossfadeMs: 3, bitDepth: null, repeatJitter: 0 },
    macros: ["roughness"],
    macroFamily: "oldDigital",
    usesSeed: true,
  },
  cheap93: {
    label: "'93",
    group: "oldDigital",
    engine: "repeat",
    description: "Coarse resampled micro-loops with heavy bit reduction, like a budget early-90s sampler.",
    params: { chunkMs: 42, crossfadeMs: 1, bitDepth: 8, repeatJitter: 0.15 },
    macros: ["roughness"],
    macroFamily: "oldDigital",
    usesSeed: true,
  },
  cyclic: {
    label: "Cyclic",
    group: "oldDigital",
    engine: "cyclic",
    description: "Akai S-series style cyclic stretch: fixed-length cycles crossfaded end to end with no splice search. Ghosted, doubled, buzzing - the 90s jungle vocal and break stretch.",
    params: { cycleMs: 60, crossfade: 0.25, bitDepth: null },
    macros: ["cycle", "crossfade"],
    macroFamily: "cyclic",
  },
  cyclic12: {
    label: "Cyclic 12-bit",
    group: "oldDigital",
    engine: "cyclic",
    description: "Shorter cycles, harder joins and 12-bit grit, in the spirit of the earlier 12-bit Akais.",
    params: { cycleMs: 35, crossfade: 0.12, bitDepth: 12 },
    macros: ["cycle", "crossfade"],
    macroFamily: "cyclic",
  },

  // --- GRANULAR -------------------------------------------------------------
  grain: {
    label: "Grain",
    group: "granular",
    engine: "granular",
    description: "Small overlapping grains with gentle jitter.",
    params: { grainMs: 60, hopFraction: 0.5, posJitterMs: 4, timeJitterMs: 0, pitchJitterCents: 0, reverseProb: 0, dropoutProb: 0, envelope: "hann" },
    macros: ["texture", "variation"],
    macroFamily: "granular",
    usesSeed: true,
  },
  scatter: {
    label: "Scatter",
    group: "granular",
    engine: "granular",
    description: "Unstable grains with position jitter.",
    params: { grainMs: 45, hopFraction: 0.5, posJitterMs: 35, timeJitterMs: 8, pitchJitterCents: 10, reverseProb: 0.05, dropoutProb: 0, envelope: "hann" },
    macros: ["texture", "variation"],
    macroFamily: "granular",
    usesSeed: true,
  },
  flutter: {
    label: "Flutter",
    group: "granular",
    engine: "granular",
    description: "Wobbly grain pitch - vibrato-like flutter.",
    params: { grainMs: 70, hopFraction: 0.5, posJitterMs: 6, timeJitterMs: 2, pitchJitterCents: 60, reverseProb: 0, dropoutProb: 0, envelope: "hann" },
    macros: ["texture", "variation"],
    macroFamily: "granular",
    usesSeed: true,
  },
  shred: {
    label: "Shred",
    group: "granular",
    engine: "granular",
    description: "Aggressive timing jitter and reversed grains.",
    params: { grainMs: 25, hopFraction: 0.4, posJitterMs: 50, timeJitterMs: 20, pitchJitterCents: 80, reverseProb: 0.35, dropoutProb: 0.05, envelope: "tri" },
    macros: ["texture", "variation"],
    macroFamily: "granular",
    usesSeed: true,
  },
  cloud: {
    label: "Cloud",
    group: "granular",
    engine: "granular",
    description: "Large, smoothly overlapped grains - ambient pad texture.",
    params: { grainMs: 180, hopFraction: 0.2, posJitterMs: 15, timeJitterMs: 0, pitchJitterCents: 15, reverseProb: 0.05, dropoutProb: 0, envelope: "hann" },
    macros: ["texture", "variation"],
    macroFamily: "granular",
    usesSeed: true,
  },
  nervous: {
    label: "Nervous",
    group: "granular",
    engine: "granular",
    description: "Tiny grains, fast twitchy jitter.",
    params: { grainMs: 15, hopFraction: 0.5, posJitterMs: 25, timeJitterMs: 15, pitchJitterCents: 40, reverseProb: 0.15, dropoutProb: 0, envelope: "hann" },
    macros: ["texture", "variation"],
    macroFamily: "granular",
    usesSeed: true,
  },
  broken: {
    label: "Broken",
    group: "granular",
    engine: "granular",
    description: "Grain dropouts and reversed grains - deliberately broken.",
    params: { grainMs: 40, hopFraction: 0.5, posJitterMs: 20, timeJitterMs: 10, pitchJitterCents: 30, reverseProb: 0.3, dropoutProb: 0.15, envelope: "rect" },
    macros: ["texture", "variation"],
    macroFamily: "granular",
    usesSeed: true,
  },

  // --- SPECTRAL ---------------------------------------------------------
  phase: {
    label: "Phase",
    group: "spectral",
    engine: "phaseVocoder",
    description: "Classic phase-vocoder stretch with audible phasey movement.",
    params: { fftMs: 46, overlap: 4, phaseLocking: false, phaseRandomize: 0.15, transientReset: false },
    macros: ["smear"],
    macroFamily: "spectral",
    usesSeed: true,
  },
  underwater: {
    label: "Underwater",
    group: "spectral",
    engine: "phaseVocoder",
    description: "Diffuse phase-vocoder smear.",
    params: { fftMs: 110, overlap: 8, phaseLocking: false, phaseRandomize: 0.55, transientReset: false },
    macros: ["smear"],
    macroFamily: "spectral",
    usesSeed: true,
  },
  metallic: {
    label: "Metallic",
    group: "spectral",
    engine: "phaseVocoder",
    description: "Small spectral windows with ringing artifacts.",
    params: { fftMs: 6, overlap: 3, phaseLocking: false, phaseRandomize: 0.2, transientReset: false },
    macros: ["smear"],
    macroFamily: "spectral",
    usesSeed: true,
  },
  glass: {
    label: "Glass",
    group: "spectral",
    engine: "phaseVocoder",
    description: "Shimmering and mostly coherent, with a little sparkle of chaos.",
    params: { fftMs: 60, overlap: 4, phaseLocking: true, phaseRandomize: 0.1, transientReset: false },
    macros: ["smear"],
    macroFamily: "spectral",
    usesSeed: true,
  },
  frozen: {
    label: "Frozen",
    group: "spectral",
    engine: "spectralFreeze",
    description: "Holds and smears spectral frames.",
    params: { fftMs: 90, overlap: 4, holdMs: 250 },
    macros: ["smear"],
    macroFamily: "spectral",
  },
  drone: {
    label: "Drone",
    group: "spectral",
    engine: "spectralFreeze",
    description: "Long-held spectral frames - suspended drone.",
    params: { fftMs: 140, overlap: 4, holdMs: 900 },
    macros: ["smear"],
    macroFamily: "spectral",
  },
  spectral: {
    label: "Spectral",
    group: "spectral",
    engine: "paulstretch",
    description: "Large-window spectral smear with softened phase.",
    params: { windowMs: 180, overlap: 8, smear: 0.25 },
    macros: ["smear"],
    macroFamily: "spectral",
    usesSeed: true,
  },
  infinite: {
    label: "Infinite",
    group: "spectral",
    engine: "paulstretch",
    description: "Extreme PaulStretch-style spectral expansion for long evolving textures.",
    params: { windowMs: 500, overlap: 10, smear: 0.6 },
    macros: ["smear"],
    macroFamily: "spectral",
    usesSeed: true,
  },

  // --- EXPERIMENTAL -----------------------------------------------------
  destroyed: {
    label: "Destroyed",
    group: "experimental",
    engine: "granular",
    description: "Everything at once: scrambled grains and bit reduction.",
    params: { grainMs: 20, hopFraction: 0.4, posJitterMs: 80, timeJitterMs: 40, pitchJitterCents: 150, reverseProb: 0.5, dropoutProb: 0.12, envelope: "tri", bitDepth: 5 },
    macros: ["texture", "variation"],
    macroFamily: "granular",
    usesSeed: true,
  },
  tape: {
    label: "Tape",
    group: "experimental",
    engine: "varispeed",
    description: "Pitch follows speed, like tape or a sampler played at the wrong rate.",
    params: {},
    preservesPitch: false,
  },
};

/** Look up a character by id, falling back to "clean" for anything unrecognised (old saved settings, typos, ...). */
export function resolveCharacter(key) {
  return CHARACTERS[key] || CHARACTERS.clean;
}

/** Resolve a character's engine params with its macro sliders (if any) applied. macroValues is a flat {texture, variation, smear, roughness} map - only the keys the character actually uses are read. */
export function resolveCharacterParams(character, macroValues) {
  if (!character.macros || !character.macros.length) return { ...character.params };
  const applier = MACRO_APPLIERS[character.macroFamily];
  return applier ? applier(character.params, macroValues) : { ...character.params };
}

/** Characters grouped in display order, each with its key attached - what the UI select renders. */
export function characterGroups() {
  return GROUPS.map((g) => ({
    ...g,
    characters: Object.entries(CHARACTERS)
      .filter(([, c]) => c.group === g.key)
      .map(([key, c]) => ({ key, ...c })),
  }));
}
