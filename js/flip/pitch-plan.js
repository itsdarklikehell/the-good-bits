// pitch-plan.js
//
// WHAT to transpose a fragment by, decided musically. Nothing here shifts audio - that's the
// renderer's job (js/flip/render.js) - and nothing here detects a key, because the app already has
// a key detector and FLIP reuses it (js/essentia-bridge.js, via the controller, with the same
// "analysis proposes, user overrides" correction the rest of the app uses).
//
// The failure this module exists to avoid: transposing slices by arbitrary chromatic amounts. That
// is not a musical accident, it is just wrong notes, and on a melodic loop it is instantly the most
// obviously artificial thing in the result. If the source is A minor, a fragment moved up three
// semitones lands on C and belongs; moved up one it lands on A# and does not.
//
// Note names, the note<->index mapping and mode normalisation all come from
// js/play-nice/key-matching.js rather than being reimplemented - it is the app's existing music
// theory, and PLAY NICE and FLIP should not be able to disagree about what "A minor" means.
import { NOTE_NAMES, noteToIndex, indexToNote, normalizeMode, formatKey } from "../play-nice/key-matching.js";

export { NOTE_NAMES, formatKey };

/** Semitone offsets from the root, for the two modes the app's key detection reports. */
export const SCALE_INTERVALS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};

export const PITCH_MODES = [
  { key: "off", label: "Off", blurb: "No pitch manipulation at all." },
  { key: "octaves", label: "Octaves", blurb: "Only octaves up or down. Always safe - an octave is the same note." },
  { key: "inkey", label: "In key", blurb: "Scale-degree moves inside the detected key. Small intervals favoured." },
  { key: "mixed", label: "Mixed", blurb: "Mostly in-key moves plus octaves, with the odd surprise when Depth is high." },
];

export const DEFAULT_PITCH_MODE = "inkey";

export function resolvePitchMode(key) {
  return PITCH_MODES.find((m) => m.key === key) || PITCH_MODES.find((m) => m.key === DEFAULT_PITCH_MODE);
}

/**
 * The transpositions available in a key, as semitone offsets, ordered by musical distance from
 * "no change" rather than by semitone count.
 *
 * Scale DEGREES, not semitones, is the right unit: moving a fragment up two scale degrees is a
 * third, and a third is a third whether it happens to be three semitones or four. Working in
 * semitones and filtering to the scale would make thirds sometimes major and sometimes minor for no
 * reason, and would rank a tritone as closer than an octave.
 */
/** Semitones for a signed scale-degree movement, wrapping through octaves. A "third" is two
 *  degrees whether that happens to be three semitones or four - which is what diatonic means. */
export function degreeToSemitones(mode, degree) {
  const intervals = SCALE_INTERVALS[normalizeMode(mode)] || SCALE_INTERVALS.minor;
  const size = intervals.length;
  const octave = Math.floor(degree / size);
  const step = ((degree % size) + size) % size;
  return intervals[step] + octave * 12;
}

export function scaleDegreeOffsets(mode, maxDegrees = 7) {
  const out = [];
  for (let degree = -maxDegrees; degree <= maxDegrees; degree++) {
    if (degree === 0) continue;
    out.push({ degree, semitones: degreeToSemitones(mode, degree) });
  }
  return out;
}

/**
 * Weighted candidate transpositions for one fragment.
 *
 * `depth` (0..1) is what opens this up: at low depth the only things on offer are neighbouring
 * scale degrees and the octave, which barely register as an effect and mostly read as the loop
 * having found another note. At high depth fourths, fifths, double octaves and - in MIXED - the
 * occasional out-of-key semitone become plausible.
 */
export function pitchCandidates({ mode = "minor", pitchMode = DEFAULT_PITCH_MODE, depth = 0.5, maxSemitones = 24 } = {}) {
  const resolved = resolvePitchMode(pitchMode).key;
  if (resolved === "off") return [];

  const candidates = [];
  const push = (semitones, weight) => {
    if (!semitones || Math.abs(semitones) > maxSemitones || weight <= 0) return;
    candidates.push({ semitones, weight });
  };

  if (resolved === "octaves") {
    push(-12, 1);
    push(12, 1);
    if (depth > 0.75) {
      push(-24, 0.25 * depth);
      push(24, 0.25 * depth);
    }
    return candidates;
  }

  // IN KEY and MIXED both start from scale degrees - but NOT weighted by how far they move, which
  // was the original mistake here and the reason transposed fragments sounded wrong rather than
  // surprising.
  //
  // Transposing a SAMPLED fragment leaves the rest of the loop where it is, so the moved fragment
  // has to agree with harmony that is still sounding. That makes the useful intervals the CHORD
  // TONES - third, fifth, octave, and the fourth as the fifth's inversion - because those are
  // consonant against whatever the loop is sitting on. A second or a seventh is a passing note: it
  // is the smallest move on paper and the most dissonant one in practice, and weighting it highest
  // (it was, at 1.0 against the third's 0.9) is why in-key shifts still sounded like wrong notes.
  //
  // Steps stay in the vocabulary as colour, and open up with Depth, but they stop being the default.
  for (const { degree, semitones } of scaleDegreeOffsets(mode)) {
    const distance = Math.abs(degree);
    let weight;
    if (distance === 2) weight = 1.4; // third - the workhorse
    else if (distance === 4) weight = 1.2; // fifth
    else if (distance === 7) weight = 0.9; // octave, via the scale
    else if (distance === 3) weight = 0.8; // fourth
    else if (distance === 5) weight = 0.35 + 0.3 * depth; // sixth
    else if (distance === 1) weight = 0.3 + 0.5 * depth; // second - passing colour
    else weight = 0.1 + 0.45 * depth; // sevenths and beyond - deliberate leaps
    // Down tends to sit under a loop more comfortably than up, which pokes out.
    if (semitones > 0) weight *= 0.85;
    push(semitones, weight);
  }
  push(-12, 0.7 + 0.2 * depth);
  push(12, 0.5 + 0.2 * depth);

  if (resolved === "mixed") {
    if (depth > 0.55) {
      // The surprises. Kept rare and depth-gated: the point of MIXED is "harmonically coherent with
      // the odd raised eyebrow", not "chromatic".
      push(-1, 0.1 * depth);
      push(1, 0.08 * depth);
      push(6, 0.06 * depth);
    }
    if (depth > 0.8) {
      push(-24, 0.15 * depth);
      push(24, 0.1 * depth);
    }
  }
  return candidates;
}

/** Deterministic weighted choice from pitchCandidates(). Returns semitones, or 0 for no shift. */
export function choosePitch(rng, candidates) {
  if (!candidates || !candidates.length) return 0;
  const total = candidates.reduce((sum, c) => sum + c.weight, 0);
  if (total <= 0) return 0;
  let r = rng.next() * total;
  for (const c of candidates) {
    r -= c.weight;
    if (r <= 0) return c.semitones;
  }
  return candidates[candidates.length - 1].semitones;
}

/**
 * A short melodic shape across `count` repetitions of the same fragment, as semitone offsets.
 *
 * This is the difference between "some slices are pitched" and "the loop found a melody in itself".
 * A fragment repeated four times with the offsets [0, 3, 7, 3] is an arpeggio; the same four
 * repetitions with four independent random pitches is noise. Shapes are chosen, not accumulated.
 */
export function melodicPattern(rng, count, candidates, { depth = 0.5, mode = "minor", pitchMode = DEFAULT_PITCH_MODE } = {}) {
  const flat = new Array(count).fill(0);
  if (count < 2 || !candidates || !candidates.length) return flat;

  const semi = (degree) => degreeToSemitones(mode, degree);
  const a = choosePitch(rng, candidates);
  // A diatonic sequence walks the SCALE, which is the wrong vocabulary when the user asked for
  // octaves only - "Octaves" has to mean octaves, including inside a melodic shape. Those modes
  // keep the shapes that are built from the candidate list instead, which is already constrained.
  const sequences = resolvePitchMode(pitchMode).key !== "octaves";

  // A SEQUENCE - restate the figure transposed by a consistent interval each time - is the oldest
  // and most reliable way to turn a repeated fragment into a melodic idea. Descending thirds and
  // descending fifths are the strongest; ascending steps read as a build. Keeping the step constant
  // is the whole point: four independent transpositions of the same figure is noise, four
  // transpositions a third apart is a line going somewhere.
  const shapes = [
    { w: sequences ? 1.5 : 0, build: () => flat.map((_, i) => semi(-2 * i)) }, // descending thirds
    { w: sequences ? 1.1 : 0, build: () => flat.map((_, i) => semi(2 * i)) }, // ascending thirds
    { w: sequences ? 1.0 : 0, build: () => flat.map((_, i) => semi(-4 * i)) }, // descending fifths
    { w: sequences ? 0.7 : 0, build: () => flat.map((_, i) => semi(i)) }, // ascending steps - a build
    { w: sequences ? 0.6 : 0, build: () => flat.map((_, i) => semi(-i)) }, // descending steps
    // Not sequences, but the shapes that make a repetition sound answered rather than restated.
    { w: 1.3, build: () => flat.map((_, i) => (i % 2 === 1 ? a : 0)) }, // alternate: call/answer
    { w: 0.9, build: () => flat.map((_, i) => (i === 0 || i === count - 1 ? 0 : a)) }, // arch: away and back
    { w: 1.0 + depth, build: () => flat.map((_, i) => (i === count - 1 ? a : 0)) }, // turnaround on the last one
    { w: 0.5, build: () => flat.map(() => a) }, // the whole figure moved - a transposed restatement
  ];

  const usable = shapes.filter((shape) => shape.w > 0);
  const total = usable.reduce((sum, s) => sum + s.w, 0);
  let r = rng.next() * total;
  let picked = usable[0];
  for (const shape of usable) {
    r -= shape.w;
    if (r <= 0) {
      picked = shape;
      break;
    }
  }
  // Clamp: a long sequence of descending fifths walks off the bottom of the instrument.
  const limit = depth > 0.7 ? 24 : 12;
  return picked.build().map((v) => Math.max(-limit, Math.min(limit, v)));
}

/** "A minor" from whatever detection or the user gave us, with a safe fallback. */
export function resolveKey({ root, mode } = {}) {
  const index = noteToIndex(root);
  return {
    root: index == null ? null : indexToNote(index),
    mode: normalizeMode(mode) || "minor",
    known: index != null,
  };
}
