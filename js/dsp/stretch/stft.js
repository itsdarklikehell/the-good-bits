// stft.js
//
// Shared "analyse one windowed frame" helper for the STFT-based engines
// (phase-vocoder.js, spectral-freeze.js, paulstretch.js) - windows a frame of
// a channel, runs the shared fft.js forward transform, and returns polar
// magnitude/phase for the non-redundant half of a real-signal spectrum
// [0, fftSize/2]. Kept in one place so there's exactly one "how do we turn
// samples into a spectrum" implementation instead of one per engine.
import { fft } from "./fft.js";

/** Analyse chan[pos .. pos+fftSize) (reading 0 past the array's ends), windowed, returning {mag, phase} for bins [0, half]. */
export function analyzeFrame(chan, pos, fftSize, window, half) {
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) re[i] = (chan[pos + i] || 0) * window[i];
  fft(re, im);
  const mag = new Float64Array(half + 1);
  const phase = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    mag[k] = Math.hypot(re[k], im[k]);
    phase[k] = Math.atan2(im[k], re[k]);
  }
  return { mag, phase };
}

/**
 * Analysis/synthesis hop sizes for an STFT stretch at `ratio`. The classic scheme fixes the analysis
 * hop at fftSize/hopDivisor and scales the synthesis hop by the ratio - fine for modest stretches,
 * but once ratio outgrows the overlap the synthesis frames stop touching and the output turns into
 * windowed blips separated by silence (Transient at 8x was ~50% silence, Infinite at 40x ~80%). So
 * the synthesis hop is capped at half a frame, and past that point the ANALYSIS hop shrinks instead
 * (fractionally - callers floor m*Ha to an integer read position, which can repeat a frame at huge
 * ratios). Below the cap this returns exactly the old integer hops, so existing renders are unchanged.
 */
export function planHops(fftSize, hopDivisor, ratio) {
  const Ha = Math.max(1, Math.round(fftSize / hopDivisor));
  const Hs = Math.max(1, Math.round(Ha * ratio));
  const maxHs = Math.floor(fftSize / 2);
  if (Hs <= maxHs) return { Ha, Hs };
  return { Ha: maxHs / ratio, Hs: maxHs };
}

/**
 * Divides an overlap-add accumulator by its weight accumulator, the last step of every STFT-based
 * engine here. The naive version (divide by weight, or by 0 below a tiny epsilon) blows up right at
 * the start/end of the output: those samples are covered by only one sparsely-overlapping frame, so
 * weight is tiny there (window^2 near a Hann window's zero edge) - and once phase has been changed
 * from what the analysis window actually produced (randomised phase, or any bin manipulation), the
 * reconstructed frame no longer reliably tapers to ~0 at its own edges the way the original windowed
 * segment did, so dividing a NOT-small numerator by a NEAR-ZERO denominator there produces huge
 * spikes rather than a small number. Flooring the divisor at a fraction of the buffer's peak weight
 * bounds that amplification instead: the few edge samples with too little overlap to trust fade in
 * relative to the floor rather than exploding, and every sample with normal overlap is unaffected
 * (its weight is already far above the floor).
 */
export function normalizeOverlapAdd(out, weight, outLen, floorFraction = 0.15) {
  let peakWeight = 0;
  for (let i = 0; i < outLen; i++) if (weight[i] > peakWeight) peakWeight = weight[i];
  const floor = Math.max(1e-9, peakWeight * floorFraction);
  const result = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) result[i] = out[i] / Math.max(weight[i], floor);
  return result;
}

/**
 * Builds a full conjugate-symmetric spectrum in `re`/`im` (both length fftSize, overwritten in
 * place) from magnitude + phase over bins [0, half], so ifft() of the result comes out real-valued.
 */
export function synthesizeSpectrum(re, im, mag, phase, fftSize, half) {
  re[0] = mag[0];
  im[0] = 0;
  re[half] = mag[half];
  im[half] = 0;
  for (let k = 1; k < half; k++) {
    re[k] = mag[k] * Math.cos(phase[k]);
    im[k] = mag[k] * Math.sin(phase[k]);
    re[fftSize - k] = re[k];
    im[fftSize - k] = -im[k];
  }
}
