// heavy-dsp-worker.js
//
// Offloads the CPU-heavy part of turning already-decoded, already-sliced audio into finished
// export blobs - WSOLA time-stretch, the lo-fi processing chain, fades, and WAV encoding - onto a
// background thread, so a big batch (or a single long file) doesn't block the page's main thread
// while it runs. Deliberately narrow: this worker only ever sees plain Float32Array channel data
// and settings objects, never the DOM, File System Access handles, or essentia - those all stay on
// the main thread (app.js), which slices the source audio and writes the results this worker hands
// back. See runHeavyDsp() in app.js for the calling side, including the same-thread fallback used
// if a worker can't be created at all (very old browsers, or a `file://` load).
//
// Three jobs, sharing one worker rather than spawning more: "processRegions" is CHOP/
// STRETCH's export path (above), "conformLoop" is PLAY NICE's - time-stretch onto a
// target tempo plus an independent pitch shift onto a target key, from a plan the main
// thread already calculated - and "stretchFx" renders one STRETCH FX recipe (js/stretch-fx/
// render.js) from a fragment the main thread already cut. None knows anything about the
// others; they share this file because they share the requirement of not running on the
// main thread.
import { stretchChannels } from "./timestretch.js";
import { applyLofiChain, deriveRegionSeed } from "./outputstage.js";
import { applyFades } from "./dsp.js";
import { encodeWav } from "./audio-codec.js";
import { renderConform } from "./play-nice/render.js";
import { renderFx } from "./stretch-fx/render.js";

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "conformLoop") return handleConformLoop(msg);
  if (msg.type === "stretchFx") return handleStretchFx(msg);
  if (msg.type !== "processRegions") return;
  const { requestId, sampleRate, bitDepth, fadeInSamples, fadeOutSamples, stretchRatio, character, macroValues, seed, lofi, regions } = msg;

  try {
    const results = regions.map(({ channels }, i) => {
      let sliced = channels;
      if (stretchRatio && stretchRatio !== 1) {
        sliced = stretchChannels(sliced, sampleRate, stretchRatio, character, { macroValues, seed });
      }
      // Per-region seed (not the raw batch seed) - see deriveRegionSeed's own doc comment.
      sliced = applyLofiChain(sliced, sampleRate, lofi, deriveRegionSeed(seed, i));
      applyFades(sliced, fadeInSamples || 0, fadeOutSamples || 0);
      const blob = encodeWav(sliced, sampleRate, bitDepth);
      return { blob, seconds: sliced[0].length / sampleRate };
    });
    self.postMessage({ type: "processRegionsResult", requestId, results });
  } catch (err) {
    self.postMessage({ type: "processRegionsError", requestId, message: (err && err.message) || String(err) });
  }
};

/**
 * PLAY NICE: render one conform plan into a finished WAV blob. The PLAN arrives
 * pre-calculated - all the musical decisions (what ratio, how many semitones, which
 * method) were made on the main thread by js/play-nice/conform.js, where they are cheap,
 * synchronous and visible in the UI long before anything is rendered. This side only
 * executes it.
 */
function handleConformLoop(msg) {
  const { requestId, sampleRate, bitDepth, plan, channels, macroValues, seed, fadeInSamples, fadeOutSamples } = msg;
  try {
    const rendered = renderConform(channels, sampleRate, plan, { macroValues, seed });
    // How far the loop had to be rotated to sit on the grid, and whether that settled -
    // reported back so the card can say what happened rather than the audio just quietly
    // being different from what was handed in.
    const alignment = rendered.alignment || null;
    // Conforming can leave a discontinuity at the very edges (a stretch engine's final
    // overlap-add frame, a resampler's last partial sample). A short fade is the same
    // cheap insurance every other export path in the app takes.
    applyFades(rendered, fadeInSamples || 0, fadeOutSamples || 0);
    const blob = encodeWav(rendered, sampleRate, bitDepth);
    self.postMessage({ type: "conformLoopResult", requestId, blob, seconds: rendered[0].length / sampleRate, alignment: serializeAlignment(alignment) });
  } catch (err) {
    self.postMessage({ type: "conformLoopError", requestId, message: (err && err.message) || String(err) });
  }
}

/** Strip the alignment report down to plain numbers - Float32Arrays must not cross postMessage. */
function serializeAlignment(alignment) {
  if (!alignment) return null;
  // Every field the card reads. Dropping one here doesn't error - it arrives as undefined
  // and reads as false, which is how confidently-aligned loops ended up reporting
  // "no clear beat".
  const one = (a) =>
    a ? { offsetMs: a.offsetMs, applied: a.applied, found: a.found, converged: a.converged, residualMs: a.residualMs, confident: a.confident, confidence: a.confidence } : null;
  return { source: one(alignment.source), output: one(alignment.output) };
}

/**
 * STRETCH FX: render one recipe. Hands back raw channels rather than a WAV blob - the main thread
 * needs the samples to audition, to draw, and to drop into the Snap Back context; it encodes only
 * when something is exported.
 */
function handleStretchFx(msg) {
  const { requestId, channels, sampleRate, recipe } = msg;
  try {
    const out = renderFx({ channels, sampleRate, recipe });
    self.postMessage({ type: "stretchFxResult", requestId, channels: out.channels }, out.channels.map((ch) => ch.buffer));
  } catch (err) {
    self.postMessage({ type: "stretchFxError", requestId, message: (err && err.message) || String(err) });
  }
}
