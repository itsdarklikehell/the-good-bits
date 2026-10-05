// dsp.js
//
// LAB's primitive vocabulary. Everything here is a PURE function of (channels, sampleRate, params) -
// no RNG, no Date.now(), no global state - so a rendered graph is byte-identical every time it's
// re-run with the same primitive keys and params. Randomness only ever happens once, upstream, when
// generator.js picks the concrete param values for a graph; this file never rolls its own dice.
//
// The point of this registry (see the module doc in generator.js for the full argument) is that
// nothing here is "reverb", "delay", "chorus", "distortion", etc. as a named unit. Every entry
// operates on a low-level property of the signal - a neighbouring sample, a derivative, a
// zero-crossing rate, a running peak, a spectral bin - and interesting effects are expected to
// *emerge* from chaining a handful of these, not from picking a familiar effect off a shelf.
//
// registerPrimitive() is the extension point: add a new primitive here (or from any module that
// imports PRIMITIVES) without touching generator.js, render.js or the UI at all - the generator picks
// primitives by iterating the registry, so a new entry is immediately part of the search space.
import { fft, ifft } from "../dsp/stretch/fft.js";
import { analyzeFrame, synthesizeSpectrum, normalizeOverlapAdd } from "../dsp/stretch/stft.js";

export const PRIMITIVES = new Map();

/**
 * @param {object} def
 * @param {string} def.key            unique registry key
 * @param {string} def.label          human-readable name for the inspector
 * @param {string} def.category       loose grouping, shown in the inspector only
 * @param {Array<{key:string,label:string,min:number,max:number,default:number,curve?:"linear"|"exp",macroable?:boolean}>} def.params
 * @param {boolean} [def.stereoOnly]  primitive is a no-op (passthrough) on mono input
 * @param {(channels:Float32Array[], sampleRate:number, params:object) => Float32Array[]} def.run
 */
export function registerPrimitive(def) {
  if (!def || !def.key || typeof def.run !== "function") throw new Error("registerPrimitive: needs a key and a run()");
  PRIMITIVES.set(def.key, def);
}

export function getPrimitive(key) {
  const p = PRIMITIVES.get(key);
  if (!p) throw new Error(`LAB: unknown primitive "${key}"`);
  return p;
}

export function primitiveKeys() {
  return [...PRIMITIVES.keys()];
}

/** Map t in [0,1] onto [min,max] along the param's curve. */
export function mapCurve(spec, t) {
  const clamped = Math.max(0, Math.min(1, t));
  if (spec.curve === "exp") {
    const lo = Math.max(1e-6, spec.min);
    const hi = Math.max(lo * 1.0001, spec.max);
    return lo * Math.pow(hi / lo, clamped);
  }
  return spec.min + (spec.max - spec.min) * clamped;
}

/** Inverse of mapCurve - a concrete value back to its [0,1] position, for describing/UI. */
export function unmapCurve(spec, value) {
  if (spec.curve === "exp") {
    const lo = Math.max(1e-6, spec.min);
    const hi = Math.max(lo * 1.0001, spec.max);
    const v = Math.max(lo, Math.min(hi, value));
    return Math.log(v / lo) / Math.log(hi / lo);
  }
  const span = spec.max - spec.min || 1;
  return Math.max(0, Math.min(1, (value - spec.min) / span));
}

function copyChannels(channels) {
  return channels.map((ch) => ch.slice());
}

function lerpRead(buf, pos) {
  const len = buf.length;
  if (len === 0) return 0;
  const wrapped = ((pos % len) + len) % len;
  const i0 = Math.floor(wrapped);
  const i1 = (i0 + 1) % len;
  const frac = wrapped - i0;
  return buf[i0] * (1 - frac) + buf[i1] * frac;
}

// ---------------------------------------------------------------------------
// Safety DSP - not part of the creative vocabulary, used by render.js on every result.
// ---------------------------------------------------------------------------

/** 1-pole DC blocker: y[n] = x[n] - x[n-1] + R*y[n-1]. Cheap, transparent above a few Hz. */
export function dcBlock(channels, R = 0.995) {
  return channels.map((ch) => {
    const out = new Float32Array(ch.length);
    let prevX = 0;
    let prevY = 0;
    for (let n = 0; n < ch.length; n++) {
      const y = ch[n] - prevX + R * prevY;
      out[n] = y;
      prevX = ch[n];
      prevY = y;
    }
    return out;
  });
}

/** Soft-knee limiter, transparent under `ceiling`, tanh-curved above it. A last-resort net, not a character stage. */
export function softLimit(channels, ceiling = 0.98) {
  return channels.map((ch) => {
    const out = new Float32Array(ch.length);
    for (let n = 0; n < ch.length; n++) {
      const x = ch[n];
      const a = Math.abs(x);
      out[n] = a <= ceiling ? x : Math.sign(x) * (ceiling + (1 - ceiling) * Math.tanh((a - ceiling) / Math.max(1e-6, 1 - ceiling)));
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

registerPrimitive({
  key: "derivative",
  label: "Sample derivative",
  category: "derivative",
  params: [
    { key: "mix", label: "Mix", min: 0, max: 1, default: 0.5, curve: "linear", macroable: true },
    { key: "tilt", label: "1st↔2nd order", min: 0, max: 1, default: 0.3, curve: "linear", macroable: true },
  ],
  run(channels, sampleRate, { mix, tilt }) {
    return channels.map((ch) => {
      const out = new Float32Array(ch.length);
      let x1 = 0;
      let d1prev = 0;
      for (let n = 0; n < ch.length; n++) {
        const x = ch[n];
        const d1 = x - x1;
        const d2 = d1 - d1prev;
        const deriv = d1 * (1 - tilt) + d2 * tilt;
        out[n] = x * (1 - mix) + deriv * mix;
        x1 = x;
        d1prev = d1;
      }
      return out;
    });
  },
});

registerPrimitive({
  key: "leakyIntegrator",
  label: "Leaky integrator",
  category: "history/state",
  params: [
    { key: "leak", label: "Leak", min: 0.5, max: 0.995, default: 0.9, curve: "exp", macroable: true },
    { key: "mix", label: "Mix", min: 0, max: 1, default: 0.5, curve: "linear", macroable: true },
  ],
  run(channels, sampleRate, { leak, mix }) {
    return channels.map((ch) => {
      const out = new Float32Array(ch.length);
      let y = 0;
      for (let n = 0; n < ch.length; n++) {
        y = ch[n] * (1 - leak) + y * leak;
        out[n] = ch[n] * (1 - mix) + y * mix;
      }
      return out;
    });
  },
});

registerPrimitive({
  key: "signalDelayTap",
  label: "Signal-dependent delay tap",
  category: "delayed state",
  params: [
    { key: "baseDelay", label: "Base delay (samples)", min: 1, max: 300, default: 40, curve: "exp", macroable: true },
    { key: "depth", label: "Amplitude→delay depth", min: 0, max: 300, default: 80, curve: "linear", macroable: true },
    { key: "feedback", label: "Feedback", min: 0, max: 0.85, default: 0.3, curve: "linear", macroable: true },
    { key: "mix", label: "Mix", min: 0, max: 1, default: 0.5, curve: "linear", macroable: true },
  ],
  run(channels, sampleRate, { baseDelay, depth, feedback, mix }) {
    const maxDelay = Math.ceil(baseDelay + depth) + 4;
    return channels.map((ch) => {
      const out = new Float32Array(ch.length);
      const ring = new Float32Array(maxDelay + 1);
      let w = 0;
      for (let n = 0; n < ch.length; n++) {
        const delayLen = baseDelay + depth * Math.abs(ch[n]);
        const readPos = w - delayLen;
        const v = readPos >= -ring.length ? lerpRead(ring, readPos) : 0;
        const raw = ch[n] + feedback * v;
        ring[w % ring.length] = raw;
        w++;
        out[n] = ch[n] * (1 - mix) + v * mix;
      }
      return out;
    });
  },
});

registerPrimitive({
  key: "zeroCrossingGate",
  label: "Zero-crossing-rate gate",
  category: "zero crossings",
  params: [
    { key: "windowMs", label: "ZCR window", min: 5, max: 40, default: 15, curve: "linear", macroable: true },
    { key: "curveAmt", label: "Curve", min: 0.3, max: 4, default: 1.2, curve: "exp", macroable: true },
    { key: "smoothMs", label: "Smoothing", min: 5, max: 80, default: 25, curve: "linear", macroable: false },
  ],
  run(channels, sampleRate, { windowMs, curveAmt, smoothMs }) {
    const win = Math.max(2, Math.round((sampleRate * windowMs) / 1000));
    const smoothCoef = Math.exp(-1 / Math.max(1, (sampleRate * smoothMs) / 1000));
    const floor = 0.1;
    return channels.map((ch) => {
      const out = new Float32Array(ch.length);
      let crossings = 0;
      let smoothed = 0;
      let prevSign = ch[0] >= 0 ? 1 : -1;
      const signs = new Int8Array(ch.length);
      for (let n = 0; n < ch.length; n++) {
        const s = ch[n] >= 0 ? 1 : -1;
        signs[n] = s !== prevSign ? 1 : 0;
        prevSign = s;
        crossings += signs[n];
        if (n >= win) crossings -= signs[n - win];
        const zcrNorm = Math.min(1, crossings / win);
        const gainTarget = floor + (1 - floor) * Math.pow(zcrNorm, curveAmt);
        smoothed = gainTarget + smoothCoef * (smoothed - gainTarget);
        out[n] = ch[n] * smoothed;
      }
      return out;
    });
  },
});

registerPrimitive({
  key: "crossChannelEnvelope",
  label: "Cross-channel envelope feed",
  category: "cross-channel",
  stereoOnly: true,
  params: [
    { key: "amount", label: "Amount", min: 0, max: 1, default: 0.5, curve: "linear", macroable: true },
    { key: "smoothMs", label: "Smoothing", min: 5, max: 100, default: 30, curve: "linear", macroable: true },
  ],
  run(channels, sampleRate, { amount, smoothMs }) {
    if (channels.length < 2) return copyChannels(channels);
    const coef = Math.exp(-1 / Math.max(1, (sampleRate * smoothMs) / 1000));
    const [l, r] = channels;
    const outL = new Float32Array(l.length);
    const outR = new Float32Array(r.length);
    let envL = 0;
    let envR = 0;
    for (let n = 0; n < l.length; n++) {
      envL = Math.abs(l[n]) + coef * (envL - Math.abs(l[n]));
      envR = Math.abs(r[n]) + coef * (envR - Math.abs(r[n]));
      outL[n] = l[n] * (1 - amount + amount * (1 - envR));
      outR[n] = r[n] * (1 - amount + amount * (1 - envL));
    }
    return [outL, outR, ...channels.slice(2).map((ch) => ch.slice())];
  },
});

registerPrimitive({
  key: "phaseSelfIndex",
  label: "Phase-accumulator self-index",
  category: "phase relationships",
  params: [
    { key: "rate", label: "Base rate", min: 0.1, max: 4, default: 1, curve: "linear", macroable: true },
    { key: "sensitivity", label: "Amplitude sensitivity", min: 0, max: 50, default: 8, curve: "linear", macroable: true },
    { key: "mix", label: "Mix", min: 0, max: 1, default: 0.6, curve: "linear", macroable: true },
  ],
  run(channels, sampleRate, { rate, sensitivity, mix }) {
    return channels.map((ch) => {
      const out = new Float32Array(ch.length);
      let phase = 0;
      for (let n = 0; n < ch.length; n++) {
        const v = lerpRead(ch, phase);
        out[n] = ch[n] * (1 - mix) + v * mix;
        phase += rate + sensitivity * Math.abs(ch[n]);
      }
      return out;
    });
  },
});

registerPrimitive({
  key: "localVariancePower",
  label: "Local-variance power shaper",
  category: "nonlinear mapping",
  params: [
    { key: "windowMs", label: "Analysis window", min: 3, max: 40, default: 12, curve: "linear", macroable: true },
    { key: "curveAmt", label: "Exponent spread", min: 0, max: 1, default: 0.5, curve: "linear", macroable: true },
    { key: "mix", label: "Mix", min: 0, max: 1, default: 0.6, curve: "linear", macroable: true },
  ],
  run(channels, sampleRate, { windowMs, curveAmt, mix }) {
    const win = Math.max(2, Math.round((sampleRate * windowMs) / 1000));
    return channels.map((ch) => {
      const out = new Float32Array(ch.length);
      let sumSq = 0;
      const sq = new Float32Array(ch.length);
      for (let n = 0; n < ch.length; n++) {
        sq[n] = ch[n] * ch[n];
        sumSq += sq[n];
        if (n >= win) sumSq -= sq[n - win];
        const energy = Math.min(1, sumSq / win / 0.2);
        const exponent = 1 + curveAmt * 1.5 * (energy - 0.5) * 2;
        const shaped = Math.sign(ch[n]) * Math.pow(Math.abs(ch[n]), Math.max(0.25, exponent));
        out[n] = ch[n] * (1 - mix) + shaped * mix;
      }
      return out;
    });
  },
});

registerPrimitive({
  key: "nonlinearShortFeedback",
  label: "Nonlinear short feedback loop",
  category: "feedback/state",
  params: [
    { key: "delaySamples", label: "Loop length (samples)", min: 2, max: 60, default: 12, curve: "linear", macroable: true },
    { key: "feedback", label: "Feedback", min: -0.95, max: 0.95, default: 0.5, curve: "linear", macroable: true },
    { key: "drive", label: "Drive", min: 0.5, max: 4, default: 1.5, curve: "linear", macroable: true },
    { key: "mix", label: "Mix", min: 0, max: 1, default: 0.6, curve: "linear", macroable: true },
  ],
  run(channels, sampleRate, { delaySamples, feedback, drive, mix }) {
    const m = Math.max(1, Math.round(delaySamples));
    return channels.map((ch) => {
      const out = new Float32Array(ch.length);
      const ring = new Float32Array(m);
      let w = 0;
      for (let n = 0; n < ch.length; n++) {
        const tap = ring[w % m];
        const y = Math.tanh(drive * (ch[n] + feedback * tap)) / Math.max(1, drive * 0.6);
        ring[w % m] = y;
        w++;
        out[n] = ch[n] * (1 - mix) + y * mix;
      }
      return out;
    });
  },
});

registerPrimitive({
  key: "amplitudeMicroTimewarp",
  label: "Amplitude-driven micro-timewarp",
  category: "interpolation",
  params: [
    { key: "depth", label: "Depth", min: 0, max: 3, default: 0.8, curve: "linear", macroable: true },
    { key: "smoothMs", label: "Modulator smoothing", min: 0, max: 20, default: 4, curve: "linear", macroable: false },
    { key: "mix", label: "Mix", min: 0, max: 1, default: 0.6, curve: "linear", macroable: true },
  ],
  run(channels, sampleRate, { depth, smoothMs, mix }) {
    const coef = smoothMs > 0 ? Math.exp(-1 / Math.max(1, (sampleRate * smoothMs) / 1000)) : 0;
    return channels.map((ch) => {
      const out = new Float32Array(ch.length);
      let readPos = 0;
      let smoothed = 0;
      for (let n = 0; n < ch.length; n++) {
        smoothed = Math.abs(ch[n]) + coef * (smoothed - Math.abs(ch[n]));
        const v = lerpRead(ch, readPos);
        out[n] = ch[n] * (1 - mix) + v * mix;
        readPos += 1 + depth * smoothed;
      }
      return out;
    });
  },
});

registerPrimitive({
  key: "energyGatedBistable",
  label: "Energy-gated bistable switch",
  category: "state behaviour",
  params: [
    { key: "thresholdHi", label: "Trigger high", min: 0.15, max: 0.9, default: 0.5, curve: "linear", macroable: true },
    { key: "hysteresis", label: "Hysteresis gap", min: 0.02, max: 0.4, default: 0.15, curve: "linear", macroable: true },
    { key: "altGain", label: "Alternate-state gain", min: -1.5, max: 1.5, default: -0.8, curve: "linear", macroable: true },
    { key: "smoothMs", label: "Envelope smoothing", min: 2, max: 60, default: 12, curve: "linear", macroable: false },
  ],
  run(channels, sampleRate, { thresholdHi, hysteresis, altGain, smoothMs }) {
    const coef = Math.exp(-1 / Math.max(1, (sampleRate * smoothMs) / 1000));
    const thresholdLo = Math.max(0, thresholdHi - hysteresis);
    return channels.map((ch) => {
      const out = new Float32Array(ch.length);
      let env = 0;
      let peak = 1e-6;
      let state = 0;
      for (let n = 0; n < ch.length; n++) {
        const a = Math.abs(ch[n]);
        env = a + coef * (env - a);
        peak = Math.max(peak * 0.9999, env);
        const rel = env / peak;
        if (state === 0 && rel > thresholdHi) state = 1;
        else if (state === 1 && rel < thresholdLo) state = 0;
        out[n] = ch[n] * (state === 1 ? altGain : 1);
      }
      return out;
    });
  },
});

registerPrimitive({
  key: "peakRatioFold",
  label: "Peak-ratio fold",
  category: "amplitude relationships",
  params: [
    { key: "decayMs", label: "Peak-follower decay", min: 5, max: 400, default: 80, curve: "exp", macroable: true },
    { key: "foldAmt", label: "Fold amount", min: 0, max: 6, default: 2, curve: "linear", macroable: true },
    { key: "mix", label: "Mix", min: 0, max: 1, default: 0.5, curve: "linear", macroable: true },
  ],
  run(channels, sampleRate, { decayMs, foldAmt, mix }) {
    const decay = Math.exp(-1 / Math.max(1, (sampleRate * decayMs) / 1000));
    return channels.map((ch) => {
      const out = new Float32Array(ch.length);
      let p = 1e-6;
      for (let n = 0; n < ch.length; n++) {
        const a = Math.abs(ch[n]);
        p = Math.max(a, p * decay);
        const ratio = a / (p + 1e-6);
        const folded = Math.sin(ch[n] * Math.PI * (1 + foldAmt * ratio));
        out[n] = ch[n] * (1 - mix) + folded * mix;
      }
      return out;
    });
  },
});

registerPrimitive({
  key: "crossSampleNonlinearMix",
  label: "Cross-sample nonlinear mix",
  category: "neighbouring samples",
  params: [
    { key: "lagSamples", label: "Lag (samples)", min: 3, max: 90, default: 20, curve: "linear", macroable: true },
    { key: "gain", label: "Gain", min: 0.5, max: 6, default: 2, curve: "linear", macroable: true },
    { key: "mix", label: "Mix", min: 0, max: 1, default: 0.5, curve: "linear", macroable: true },
  ],
  run(channels, sampleRate, { lagSamples, gain, mix }) {
    const d = Math.max(1, Math.round(lagSamples));
    return channels.map((ch) => {
      const out = new Float32Array(ch.length);
      for (let n = 0; n < ch.length; n++) {
        const lagged = ch[n - d] || 0;
        const combined = Math.tanh(gain * ch[n] * lagged);
        out[n] = ch[n] * (1 - mix) + combined * mix;
      }
      return out;
    });
  },
});

registerPrimitive({
  key: "localSlopeStep",
  label: "Local-slope step quantizer",
  category: "nonlinear mapping",
  params: [
    { key: "riseGain", label: "Rising gain", min: -1.5, max: 1.5, default: 1.1, curve: "linear", macroable: true },
    { key: "fallGain", label: "Falling gain", min: -1.5, max: 1.5, default: 0.7, curve: "linear", macroable: true },
    { key: "flatGain", label: "Flat gain", min: -1.5, max: 1.5, default: 1, curve: "linear", macroable: true },
    { key: "mix", label: "Mix", min: 0, max: 1, default: 0.6, curve: "linear", macroable: true },
  ],
  run(channels, sampleRate, { riseGain, fallGain, flatGain, mix }) {
    const eps = 1e-4;
    return channels.map((ch) => {
      const out = new Float32Array(ch.length);
      let prev = 0;
      for (let n = 0; n < ch.length; n++) {
        const slope = ch[n] - prev;
        const g = slope > eps ? riseGain : slope < -eps ? fallGain : flatGain;
        out[n] = ch[n] * (1 - mix) + ch[n] * g * mix;
        prev = ch[n];
      }
      return out;
    });
  },
});

const SPECTRAL_FFT_SIZE = 1024;
const SPECTRAL_HOP = 256;

registerPrimitive({
  key: "spectralBinPermute",
  label: "Spectral bin permute + flux feedback",
  category: "frequency domain",
  params: [
    { key: "rotateBins", label: "Bin rotation", min: 0, max: 24, default: 6, curve: "linear", macroable: true },
    { key: "fluxGain", label: "Flux feedback gain", min: 0, max: 4, default: 1.2, curve: "linear", macroable: true },
    { key: "mix", label: "Mix", min: 0, max: 1, default: 0.6, curve: "linear", macroable: true },
  ],
  run(channels, sampleRate, { rotateBins, fluxGain, mix }) {
    const fftSize = SPECTRAL_FFT_SIZE;
    const hop = SPECTRAL_HOP;
    const half = fftSize / 2;
    const rotate = Math.round(rotateBins);
    const window = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));

    return channels.map((ch) => {
      const outLen = ch.length;
      const acc = new Float64Array(outLen + fftSize);
      const weight = new Float64Array(outLen + fftSize);
      const prevMag = new Float64Array(half + 1);
      const re = new Float64Array(fftSize);
      const im = new Float64Array(fftSize);
      for (let pos = 0; pos < outLen; pos += hop) {
        const { mag, phase } = analyzeFrame(ch, pos, fftSize, window, half);
        const shaped = new Float64Array(half + 1);
        for (let k = 0; k <= half; k++) {
          const flux = Math.abs(mag[k] - prevMag[k]);
          shaped[k] = mag[k] * (1 + fluxGain * flux);
          prevMag[k] = mag[k];
        }
        const rotated = new Float64Array(half + 1);
        for (let k = 0; k <= half; k++) rotated[k] = shaped[(k + rotate) % (half + 1)];
        synthesizeSpectrum(re, im, rotated, phase, fftSize, half);
        ifft(re, im);
        for (let i = 0; i < fftSize; i++) {
          const idx = pos + i;
          if (idx >= acc.length) break;
          acc[idx] += re[i] * window[i];
          weight[idx] += window[i] * window[i];
        }
      }
      const wet = normalizeOverlapAdd(acc, weight, outLen, 0.1);
      const out = new Float32Array(outLen);
      for (let n = 0; n < outLen; n++) out[n] = ch[n] * (1 - mix) + wet[n] * mix;
      return out;
    });
  },
});

/** Every primitive that isn't stereoOnly, for generator/tests that need a plain list. */
export function allPrimitives() {
  return [...PRIMITIVES.values()];
}
