// render.js
//
// recipe + fragment audio -> one finished STRETCH FX result. Pure and synchronous: the same function
// runs inside heavy-dsp-worker.js (the normal path) and on the main thread (the fallback), so what
// you audition is byte-for-byte what you export.
//
// Nothing here is a new DSP engine. The chain is built from what the app already has:
//
//   reverse (pre)     plain array reversal
//   pitch             dsp.js resampleLinear - varispeed, the way a sampler pitches: down is longer
//   stretch pass(es)  js/dsp/stretch stretchChannels - any character in the registry, Cyclic included
//   reverse (post)
//   drive             outputstage.js applyDrive
//   crunch            outputstage.js applyCrunch
//
// then a level match back to the source fragment's own peak (so a result sits at the same level as
// the break it came from - essential for Snap Back - and nothing clips), and fades at the edges
// that are only as long as they need to be: a fraction of a millisecond in front of a forward
// transient, longer where the edge is a tail or a reversed swell.
import { stretchChannels } from "../dsp/stretch/index.js";
import { resampleLinear, applyFades } from "../dsp.js";
import { applyDrive, applyCrunch } from "../outputstage.js";

/** Longest output any result may have, in seconds, whatever the recipe says. */
const HARD_MAX_SECONDS = 24;

function peakOf(channels) {
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) {
    const v = Math.abs(ch[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

function reverseAll(channels) {
  return channels.map((ch) => Float32Array.from(ch).reverse());
}

function scrub(channels) {
  for (const ch of channels) for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) ch[i] = 0;
}

/**
 * @param {object} opts
 * @param {Float32Array[]} opts.channels  the source fragment (already cut from the break)
 * @param {number} opts.sampleRate
 * @param {object} opts.recipe            from recipe.js
 * @returns {{channels: Float32Array[], sampleRate: number, duration: number}}
 */
export function renderFx({ channels, sampleRate, recipe }) {
  if (!channels.length || !channels[0].length) throw new Error("empty fragment");
  const ms = (m) => Math.round((m / 1000) * sampleRate);
  let out = channels.map((ch) => Float32Array.from(ch));
  const peakIn = peakOf(out);

  // The fragment was cut out of the middle of a break, so its far edge is mid-waveform - left
  // alone, the stretch would smear that click across the whole result. The front edge sits a few
  // ms before the transient (see sources.js PRE_ROLL_SEC), so a sub-millisecond fade there never
  // touches the attack.
  applyFades(out, ms(0.6), ms(6));

  if (recipe.reverse === "pre") out = reverseAll(out);

  if (recipe.pitch) {
    const lengthFactor = Math.pow(2, -recipe.pitch / 12);
    out = out.map((ch) => resampleLinear(ch, 1, lengthFactor));
  }

  const seedBase = recipe.seed >>> 0;
  recipe.passes.forEach((pass, i) => {
    const maxRatio = (HARD_MAX_SECONDS * sampleRate) / Math.max(1, out[0].length);
    const ratio = Math.max(0.05, Math.min(pass.ratio, maxRatio));
    out = stretchChannels(out, sampleRate, ratio, pass.character, { macroValues: pass.macroValues, seed: (seedBase + i * 7919) >>> 0 });
  });

  if (recipe.reverse === "post") out = reverseAll(out);
  if (recipe.drive && recipe.drive.amount > 0) out = applyDrive(out, recipe.drive.type, recipe.drive.amount);
  if (recipe.crunch) out = applyCrunch(out, recipe.crunch);
  scrub(out);

  // Level: back to the fragment's own peak (within sane bounds), never above 0.92.
  const peakOut = peakOf(out);
  const target = Math.max(0.3, Math.min(0.92, peakIn || 0.5));
  if (peakOut > 1e-6) {
    const gain = Math.min(8, target / peakOut);
    for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i] *= gain;
  }

  // Edges. A forward result opens on the (stretched) transient: 0.7ms is enough to kill a DC step
  // without softening the hit. A post-reversed result opens on a stretched tail and ends ON the
  // transient, so the shapes swap.
  const fadeIn = recipe.reverse === "post" ? ms(10) : ms(0.7);
  const fadeOut = recipe.reverse === "post" ? ms(2) : ms(14);
  applyFades(out, fadeIn, fadeOut);

  return { channels: out, sampleRate, duration: out[0].length / sampleRate };
}

/** Copy [startSec, endSec) out of the source channels - what the worker is sent. */
export function sliceFragment(channels, sampleRate, startSec, endSec) {
  const a = Math.max(0, Math.round(startSec * sampleRate));
  const b = Math.min(channels[0].length, Math.max(a + 1, Math.round(endSec * sampleRate)));
  return channels.map((ch) => ch.slice(a, b));
}
