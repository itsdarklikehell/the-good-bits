// step.js
//
// The atom of a FLIP recipe: one output slot.
//
// Its own module purely so js/flip/recipe.js (which generates step lists) and
// js/flip/operations.js (which edits them) can both depend on the shape without depending on each
// other. The renderer (js/flip/render.js) is the only other reader, and it reads nothing else.
//
// A step describes ONE slot of the slice map's time. It can say which source slice fills that slot,
// and how - but it can never say "and then some more time", which is what makes the phrase-length
// guarantee structural rather than something the generator has to remember to check.

/**
 * @param {number} src  index into the slice map
 * @param {string} [op] provenance tag, for the UI's "what happened" summary
 */
export function makeStep(src, op = "source") {
  return {
    src,
    op,
    /** Play this slot's audio backwards. On a group, the generator also reverses the slot order. */
    reverse: false,
    /** Deliberate silence - rendered as written zeros, never as an unfilled gap. */
    silent: false,
    /** 0 = play the slice straight. n > 1 = fill the stuttered portion with n copies of a 1/n fragment. */
    stutter: 0,
    /** 0..1 of the slot played straight from the source before the stutter portion begins. */
    keepHead: 0,
    /** 0..1 offset into the source slice that the stutter fragment is taken from. */
    fragFrom: 0,
    /** Transposition in semitones, 0 for none. Decided musically - see js/flip/pitch-plan.js. */
    pitch: 0,
  };
}

export function cloneStep(step) {
  return { ...step };
}

/** The identity recipe: the source, unchanged, slot for slot. Every generation starts here. */
export function identitySteps(count) {
  const steps = [];
  for (let i = 0; i < count; i++) steps.push(makeStep(i));
  return steps;
}

/** True when this slot plays source slice `index` exactly as it is in the original. */
export function isUntouched(step, index) {
  return !!step && step.src === index && !step.reverse && !step.silent && !step.stutter && !step.pitch;
}
