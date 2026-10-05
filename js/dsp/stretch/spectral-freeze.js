// spectral-freeze.js
//
// Creative "hold" mode built on the same STFT infrastructure as
// phase-vocoder.js: instead of continuously re-analysing the input, it
// captures a handful of spectral snapshots spread across the source and
// sustains each one for a while before crossfading (magnitude AND
// instantaneous frequency) to the next. Each captured snapshot still gets a
// real per-bin instantaneous-frequency estimate (from two closely-spaced
// analysis frames at capture time) and the phase accumulator runs
// continuously the whole render, so a "held" frame isn't a static drone or
// silence between hits - it keeps evolving the way the original moment was
// already evolving, just stretched out far beyond what actually happened in
// the source. Explicitly not "correct" time-stretching - it's a deliberate
// stretch-adjacent creative transform (spec: Frozen/Drone/Hold/Suspended).
import { toMono } from "../../dsp.js";
import { ifft, nextPow2, wrapPhase } from "./fft.js";
import { getWindow } from "./windows.js";
import { analyzeFrame, synthesizeSpectrum, normalizeOverlapAdd, planHops } from "./stft.js";

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * params: { fftMs, overlap, holdMs (how long each captured frame sustains before crossfading) }
 */
export function stretchSpectralFreeze(channels, sampleRate, ratio, params) {
  const p = params || {};
  const fftSize = nextPow2(Math.max(256, Math.round(((p.fftMs ?? 90) / 1000) * sampleRate)));
  const half = fftSize / 2;
  const hopDivisor = Math.max(2, p.overlap ?? 4);
  // Frames are synthesised from captured spectra, not read at m * Ha, so only Hs matters here - but
  // it still needs planHops' cap, or big ratios space the frames out into silence. Ha stays the
  // integer grid hop for the instantaneous-frequency estimate below.
  const Ha = Math.max(1, Math.round(fftSize / hopDivisor));
  const { Hs } = planHops(fftSize, hopDivisor, ratio);
  const holdMs = Math.max(20, p.holdMs ?? 300);
  const holdHops = Math.max(2, Math.round((holdMs / 1000) * sampleRate / Hs));
  const crossfadeHops = Math.max(1, Math.round(holdHops * 0.3));

  const reference = channels.length > 1 ? toMono(channels) : channels[0];
  const inputLen = reference.length;
  const outLen = Math.max(fftSize, Math.round(inputLen * ratio));
  const totalHops = Math.max(1, Math.ceil(outLen / Hs));
  const totalSegments = Math.max(1, Math.ceil(totalHops / holdHops));
  const window = getWindow("hann", fftSize);

  // Capture positions spread evenly across the input, shared by every channel so a stereo source
  // freezes on the same moment in both channels.
  const maxPos = Math.max(0, inputLen - fftSize);
  const capturePos = [];
  for (let s = 0; s <= totalSegments; s++) {
    capturePos.push(totalSegments <= 1 ? 0 : Math.round((s / totalSegments) * maxPos));
  }

  return channels.map((chan) => {
    // Per-segment captured magnitude, initial phase, and per-bin instantaneous frequency.
    const segMag = [];
    const segPhase0 = [];
    const segFreq = [];
    for (let s = 0; s <= totalSegments; s++) {
      const pos = capturePos[s];
      const { mag, phase } = analyzeFrame(chan, pos, fftSize, window, half);
      const { phase: phaseNext } = analyzeFrame(chan, pos + Ha, fftSize, window, half);
      const freq = new Float64Array(half + 1);
      for (let k = 0; k <= half; k++) {
        const expected = (2 * Math.PI * k * Ha) / fftSize;
        const delta = wrapPhase(phaseNext[k] - phase[k] - expected);
        freq[k] = (2 * Math.PI * k) / fftSize + delta / Ha;
      }
      segMag.push(mag);
      segPhase0.push(phase);
      segFreq.push(freq);
    }

    const out = new Float64Array(outLen + fftSize);
    const weight = new Float64Array(outLen + fftSize);
    const outPhase = Float64Array.from(segPhase0[0]);
    const synRe = new Float64Array(fftSize);
    const synIm = new Float64Array(fftSize);
    const mag = new Float64Array(half + 1);
    const freq = new Float64Array(half + 1);

    let hop = 0;
    for (let seg = 0; seg < totalSegments && hop < totalHops; seg++) {
      for (let h = 0; h < holdHops && hop < totalHops; h++, hop++) {
        const remaining = holdHops - h;
        const mixNext = remaining <= crossfadeHops ? clamp01(1 - (remaining - 1) / crossfadeHops) : 0;
        const magA = segMag[seg];
        const magB = segMag[seg + 1];
        const freqA = segFreq[seg];
        const freqB = segFreq[seg + 1];
        for (let k = 0; k <= half; k++) {
          mag[k] = magA[k] * (1 - mixNext) + magB[k] * mixNext;
          freq[k] = freqA[k] * (1 - mixNext) + freqB[k] * mixNext;
        }

        const synthesisPos = hop * Hs;
        synthesizeSpectrum(synRe, synIm, mag, outPhase, fftSize, half);
        ifft(synRe, synIm);
        for (let i = 0; i < fftSize; i++) {
          out[synthesisPos + i] += synRe[i] * window[i];
          weight[synthesisPos + i] += window[i] * window[i];
        }

        for (let k = 0; k <= half; k++) outPhase[k] += freq[k] * Hs;
      }
    }

    return normalizeOverlapAdd(out, weight, outLen);
  });
}
