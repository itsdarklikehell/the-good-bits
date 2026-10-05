// phase-vocoder.js
//
// FFT-based phase-vocoder stretch engine, real STFT analysis/resynthesis
// (not a WSOLA variant wearing a different name). Supports two genuinely
// different behaviours via its own parameters rather than two code paths:
//
//   - phaseLocking (identity phase locking, Laroche/Dolson): synthesis phase
//     around each spectral peak is locked to that peak's phase trajectory,
//     which keeps the spectral shape coherent frame-to-frame and is what a
//     "transient-aware" vocoder needs to sound punchy rather than washy.
//   - transientReset: frames flagged as transients (spectral-flux jump on a
//     shared mono reference, so stereo channels reset together) get their
//     phase accumulator reset to the raw analysis phase instead of
//     propagated, which stops the smeared pre-echo a stretched drum hit
//     would otherwise get.
//   - phaseRandomize: deliberately detunes the per-bin synthesis phase, the
//     classic naive-vocoder "phasiness"/robotic/underwater artifact. Left
//     audible on purpose for the "naive" characters (Phase, Underwater,
//     Metallic) - see js/dsp/stretch/characters.js.
//
// Real-signal STFT: only bins [0, N/2] are analysed/synthesised, then
// mirrored (conjugate symmetry) before the inverse FFT so the reconstructed
// frame stays real-valued.
import { toMono } from "../../dsp.js";
import { ifft, nextPow2, wrapPhase } from "./fft.js";
import { getWindow } from "./windows.js";
import { makeRng } from "./rng.js";
import { analyzeFrame, synthesizeSpectrum, normalizeOverlapAdd, planHops } from "./stft.js";

/** Local maxima of `mag`, above a small fraction of the frame's own peak, used for identity phase locking. */
function findPeaks(mag, half) {
  let frameMax = 0;
  for (let k = 0; k <= half; k++) if (mag[k] > frameMax) frameMax = mag[k];
  const floor = frameMax * 0.02;
  const peaks = [];
  for (let k = 1; k < half; k++) {
    if (mag[k] >= mag[k - 1] && mag[k] >= mag[k + 1] && mag[k] > floor) peaks.push(k);
  }
  if (peaks.length === 0) peaks.push(0);
  return peaks;
}

/** Which peak "owns" each bin (nearest peak, ties to the lower one), for identity phase locking. */
function ownerForEachBin(peaks, half) {
  const owner = new Int32Array(half + 1);
  let pi = 0;
  for (let k = 0; k <= half; k++) {
    while (pi < peaks.length - 1 && Math.abs(peaks[pi + 1] - k) <= Math.abs(peaks[pi] - k)) pi++;
    owner[k] = peaks[pi];
  }
  return owner;
}

/** Spectral flux (positive-only) between two magnitude frames, used to flag transient frames. */
function spectralFlux(mag, prevMag, half) {
  let flux = 0;
  for (let k = 0; k <= half; k++) flux += Math.max(0, mag[k] - (prevMag ? prevMag[k] : 0));
  return flux;
}

/**
 * Runs analyzeFrame across every frame of `reference` up front. Returned alongside the flags so a
 * mono input (where `reference` IS the same array as the single channel the synthesis loop below
 * processes - see stretchPhaseVocoder) can reuse these already-computed spectra instead of running
 * an identical second FFT pass per frame for that channel. For stereo, `reference` is the mono
 * downmix - a different signal from either channel - so there's nothing to reuse there and this
 * costs the same as before.
 */
function analyzeReferenceFrames(reference, fftSize, hop, window, half, numFrames) {
  const frames = new Array(numFrames);
  for (let m = 0; m < numFrames; m++) frames[m] = analyzeFrame(reference, m * hop, fftSize, window, half);
  return frames;
}

/** Frame indices (shared across channels) whose spectral flux is a sharp outlier vs. the running average. */
function transientFlagsFromFrames(frames, half, numFrames, sensitivity) {
  const fluxes = new Float64Array(numFrames);
  let prevMag = null;
  for (let m = 0; m < numFrames; m++) {
    fluxes[m] = spectralFlux(frames[m].mag, prevMag, half);
    prevMag = frames[m].mag;
  }
  const mean = fluxes.reduce((a, b) => a + b, 0) / Math.max(1, numFrames);
  const threshold = mean * (2.2 - 1.2 * sensitivity); // higher sensitivity -> lower threshold -> more resets
  const flags = new Uint8Array(numFrames);
  for (let m = 1; m < numFrames; m++) flags[m] = fluxes[m] > threshold && fluxes[m] > 1e-6 ? 1 : 0;
  return flags;
}

/**
 * params: { fftMs, overlap, phaseLocking, phaseRandomize (0-1), transientReset, transientSensitivity (0-1) }
 */
export function stretchPhaseVocoder(channels, sampleRate, ratio, params, seed) {
  const p = params || {};
  const fftSize = nextPow2(Math.max(64, Math.round(((p.fftMs ?? 46) / 1000) * sampleRate)));
  const half = fftSize / 2;
  const hopDivisor = Math.max(2, p.overlap ?? 4);
  // Ha may come back fractional for big ratios (see planHops) - frame m reads at floor(m * Ha).
  const { Ha, Hs } = planHops(fftSize, hopDivisor, ratio);
  // Transient detection always runs on the nominal integer hop grid, so its cost and memory don't
  // balloon when Ha shrinks for a huge ratio - each synthesis frame looks up the grid cell it reads from.
  const gridHop = Math.max(1, Math.round(fftSize / hopDivisor));
  const onGrid = Ha === gridHop;
  const window = getWindow("hann", fftSize);
  const phaseLocking = !!p.phaseLocking;
  const phaseRandomize = Math.max(0, Math.min(1, p.phaseRandomize ?? 0));
  const transientReset = !!p.transientReset;
  const transientSensitivity = Math.max(0, Math.min(1, p.transientSensitivity ?? 0.5));

  const reference = channels.length > 1 ? toMono(channels) : channels[0];
  const inputLen = reference.length;
  const outLen = Math.max(fftSize, Math.round(inputLen * ratio));
  const numFrames = Math.max(1, Math.ceil(inputLen / Ha) + 1);
  const numGridFrames = Math.max(1, Math.ceil(inputLen / gridHop) + 1);

  const referenceFrames = transientReset ? analyzeReferenceFrames(reference, fftSize, gridHop, window, half, numGridFrames) : null;
  const transientFlags = transientReset ? transientFlagsFromFrames(referenceFrames, half, numGridFrames, transientSensitivity) : null;

  return channels.map((chan) => {
    // Reseeded identically per channel: the random phase sequence lines up bin-for-bin and
    // frame-for-frame across L/R, so randomisation colours the stereo image without smearing it.
    const rng = phaseRandomize > 0 ? makeRng(seed) : null;

    const out = new Float64Array(outLen + fftSize);
    const weight = new Float64Array(outLen + fftSize);
    const outPhase = new Float64Array(half + 1);
    let prevAnalysisPhase = null;
    let prevAnalysisPos = 0;
    let prevSynthesisPos = 0;
    let prevGrid = -1;
    let havePrev = false;
    // Per-bin instantaneous frequency, kept across frames so a repeated read position (possible when
    // Ha < 1 at huge ratios) keeps advancing phase at the last measured rate instead of stalling.
    const trueFreq = new Float64Array(half + 1);

    const synRe = new Float64Array(fftSize);
    const synIm = new Float64Array(fftSize);

    for (let m = 0; m < numFrames; m++) {
      const analysisPos = Math.floor(m * Ha);
      const synthesisPos = m * Hs;
      if (synthesisPos > outLen + fftSize) break;

      // Mono input on the nominal grid: `chan` IS `reference` (same array), so the transient-detection
      // pass above already analysed this exact frame - reuse it instead of running an identical FFT again.
      const { mag, phase } = onGrid && chan === reference && referenceFrames ? referenceFrames[m] : analyzeFrame(chan, analysisPos, fftSize, window, half);
      // Only the first frame to land in a flagged grid cell resets - at huge ratios dozens of frames
      // read from the same cell, and resetting all of them would just freeze the phase there.
      const grid = Math.floor(analysisPos / gridHop);
      const isTransient = transientFlags && grid !== prevGrid ? !!transientFlags[grid] : false;
      prevGrid = grid;

      if (!havePrev) {
        for (let k = 0; k <= half; k++) outPhase[k] = phase[k];
        havePrev = true;
      } else if (isTransient) {
        for (let k = 0; k <= half; k++) outPhase[k] = phase[k];
      } else {
        const aStep = analysisPos - prevAnalysisPos;
        const sStep = synthesisPos - prevSynthesisPos;
        for (let k = 0; k <= half; k++) {
          if (aStep > 0) {
            const expected = (2 * Math.PI * k * aStep) / fftSize;
            const delta = wrapPhase(phase[k] - prevAnalysisPhase[k] - expected);
            trueFreq[k] = (2 * Math.PI * k) / fftSize + delta / aStep;
          }
          outPhase[k] += trueFreq[k] * sStep;
        }
      }

      if (phaseLocking) {
        const peaks = findPeaks(mag, half);
        const owner = ownerForEachBin(peaks, half);
        // Snapshot peak phases before rewriting non-peak bins relative to them.
        const peakOutPhase = new Float64Array(half + 1);
        for (const pk of peaks) peakOutPhase[pk] = outPhase[pk];
        for (let k = 0; k <= half; k++) {
          const own = owner[k];
          if (k !== own) outPhase[k] = peakOutPhase[own] + (phase[k] - phase[own]);
        }
      }

      if (rng) {
        for (let k = 1; k < half; k++) outPhase[k] += phaseRandomize * rng.signed() * Math.PI;
      }

      synthesizeSpectrum(synRe, synIm, mag, outPhase, fftSize, half);
      ifft(synRe, synIm);

      for (let i = 0; i < fftSize; i++) {
        const s = synRe[i] * window[i];
        out[synthesisPos + i] += s;
        weight[synthesisPos + i] += window[i] * window[i];
      }

      prevAnalysisPhase = phase;
      prevAnalysisPos = analysisPos;
      prevSynthesisPos = synthesisPos;
    }

    return normalizeOverlapAdd(out, weight, outLen);
  });
}
