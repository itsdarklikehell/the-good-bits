// cyclic.js
//
// Akai S-series style "cyclic" time-stretch. The sampler chops the sound
// into fixed-length cycles and lays them end to end with a linear crossfade
// at each join, sliding the read point through the source at 1/ratio of the
// output's speed - so a stretch plays some cycles more than once and a
// squash skips some. Unlike WSOLA there is no search for a good splice point
// and unlike repeat.js the read point advances smoothly rather than in whole
// chunks: every cycle starts wherever the clock says, in phase or not. That
// fixed cycle period is the sound - a ghosted, doubled, slightly phasey
// texture with a buzz at the cycle rate that gets stronger the further you
// stretch, which is the classic 90s jungle/hardcore vocal and break stretch.
//
// Every channel uses the same cycle grid, so stereo stays locked.
import { quantizeInPlace } from "./wsola.js";

/**
 * params: { cycleMs, crossfade (0-0.5, fraction of the cycle spent crossfading into the next), bitDepth }
 */
export function stretchCyclic(channels, sampleRate, ratio, params) {
  const p = params || {};
  const cycleSamples = Math.max(16, Math.round(((p.cycleMs ?? 60) / 1000) * sampleRate));
  const crossfade = Math.max(0, Math.min(0.5, p.crossfade ?? 0.3));
  const bitDepth = p.bitDepth ?? null;

  const fadeLen = Math.round(cycleSamples * crossfade);
  const hop = cycleSamples - fadeLen;
  const inputLen = channels[0] ? channels[0].length : 0;
  const outLen = Math.max(1, Math.round(inputLen * ratio));
  const numCycles = Math.ceil(outLen / hop) + 1;

  // Trapezoid: linear ramp in, flat top, linear ramp out. Adjacent cycles overlap by exactly fadeLen,
  // so one's ramp-out and the next's ramp-in always sum to 1 - no dip or bump at the joins.
  const gain = new Float32Array(cycleSamples);
  for (let i = 0; i < cycleSamples; i++) {
    let g = 1;
    if (fadeLen > 0 && i < fadeLen) g = (i + 1) / (fadeLen + 1);
    if (fadeLen > 0 && i >= cycleSamples - fadeLen) g = Math.min(g, (cycleSamples - i) / (fadeLen + 1));
    gain[i] = g;
  }

  return channels.map((chan) => {
    const out = new Float32Array(outLen);
    for (let n = 0; n < numCycles; n++) {
      const dst = n * hop;
      if (dst >= outLen) break;
      // Read point tracks the output clock, clamped so the last cycles still have audio to play.
      const src = Math.max(0, Math.min(inputLen - cycleSamples, Math.round(dst / ratio)));
      const first = n === 0;
      for (let i = 0; i < cycleSamples; i++) {
        const idx = dst + i;
        if (idx >= outLen) break;
        // The very first cycle has nothing to fade in from, so it starts at full level.
        const g = first && i < fadeLen ? 1 : gain[i];
        out[idx] += (chan[src + i] || 0) * g;
      }
    }
    if (bitDepth) quantizeInPlace(out, bitDepth);
    return out;
  });
}
