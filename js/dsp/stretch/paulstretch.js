// paulstretch.js
//
// Extreme spectral stretch, conceptually modelled on Paul Nasca's PaulStretch
// algorithm (public description of the technique, not any particular
// implementation's code): very large analysis windows, heavy frame overlap,
// and a FULLY RANDOMISED per-bin phase every frame - no true-frequency phase
// propagation at all, unlike phase-vocoder.js. That's what makes it simple
// (no phase accumulator, no peak locking) and what gives it its
// characteristic outcome: transient structure is destroyed entirely and a
// short sound becomes an evolving spectral cloud. Heavy overlap (8x+) is
// what keeps that cloud smooth instead of granular, since with no phase
// coherence between frames a sparse overlap would just sound like clicking.
//
// Not intended to sound natural. It's supposed to sound beautiful/weird.
import { toMono } from "../../dsp.js";
import { ifft, nextPow2 } from "./fft.js";
import { getWindow } from "./windows.js";
import { makeRng, deriveSeed } from "./rng.js";
import { analyzeFrame, normalizeOverlapAdd, planHops } from "./stft.js";

/** Smooths a magnitude spectrum across neighbouring bins - the "smear" macro's spectral half. */
function smoothMagnitudeInPlace(mag, half, amount) {
  if (amount <= 0) return;
  const radius = Math.max(1, Math.round(amount * 6));
  const src = mag.slice();
  for (let k = 0; k <= half; k++) {
    let sum = 0;
    let count = 0;
    for (let j = -radius; j <= radius; j++) {
      const idx = k + j;
      if (idx < 0 || idx > half) continue;
      sum += src[idx];
      count++;
    }
    mag[k] = sum / count;
  }
}

/**
 * params: { windowMs, overlap (hop divisor, higher = denser), smear (0-1, magnitude smoothing +
 * frame blending), frameBlend (0-1, how much of the previous frame's magnitude bleeds into this one) }
 */
export function stretchPaulstretch(channels, sampleRate, ratio, params, seed) {
  const p = params || {};
  const fftSize = nextPow2(Math.max(256, Math.round(((p.windowMs ?? 250) / 1000) * sampleRate)));
  const half = fftSize / 2;
  const hopDivisor = Math.max(4, p.overlap ?? 8);
  // Ha may come back fractional for big ratios (see planHops) - frame m reads at floor(m * Ha).
  const { Ha, Hs } = planHops(fftSize, hopDivisor, ratio);
  const window = getWindow("hann", fftSize);
  const smear = Math.max(0, Math.min(1, p.smear ?? 0.3));
  const frameBlend = Math.max(0, Math.min(0.95, p.frameBlend ?? smear * 0.5));

  const reference = channels.length > 1 ? toMono(channels) : channels[0];
  const inputLen = reference.length;
  const outLen = Math.max(fftSize, Math.round(inputLen * ratio));
  const numFrames = Math.max(1, Math.ceil(inputLen / Ha) + 1);

  return channels.map((chan) => {
    const out = new Float64Array(outLen + fftSize);
    const weight = new Float64Array(outLen + fftSize);
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    let prevMag = null;

    for (let m = 0; m < numFrames; m++) {
      const analysisPos = Math.floor(m * Ha);
      const synthesisPos = m * Hs;
      if (synthesisPos > outLen + fftSize) break;

      const { mag: rawMag } = analyzeFrame(chan, analysisPos, fftSize, window, half);
      const mag = new Float64Array(half + 1);
      for (let k = 0; k <= half; k++) {
        mag[k] = prevMag ? rawMag[k] * (1 - frameBlend) + prevMag[k] * frameBlend : rawMag[k];
      }
      smoothMagnitudeInPlace(mag, half, smear);
      prevMag = mag;

      // Fully randomised phase per bin, per frame - the defining PaulStretch move. Deterministic:
      // seeded from (base seed, frame index) so the same frame always gets the same random phase
      // field, regardless of which channel is being processed - L and R get the SAME phase field,
      // which keeps a stereo source's width from collapsing into noise.
      const rng = makeRng(deriveSeed(seed, m));
      re[0] = mag[0];
      im[0] = 0;
      re[half] = mag[half];
      im[half] = 0;
      for (let k = 1; k < half; k++) {
        const ph = rng.next() * 2 * Math.PI;
        re[k] = mag[k] * Math.cos(ph);
        im[k] = mag[k] * Math.sin(ph);
        re[fftSize - k] = re[k];
        im[fftSize - k] = -im[k];
      }

      ifft(re, im);

      for (let i = 0; i < fftSize; i++) {
        const s = re[i] * window[i];
        out[synthesisPos + i] += s;
        weight[synthesisPos + i] += window[i] * window[i];
      }
    }

    return normalizeOverlapAdd(out, weight, outLen);
  });
}
