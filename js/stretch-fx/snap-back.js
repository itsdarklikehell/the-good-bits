// snap-back.js
//
// SNAP BACK audition: hear the result where it's going to live.
//
//   BREAK -> BREAK -> STREEEEEEETCH -> BANG -> BREAK
//
// Renders one buffer: a lead-in of the original break (starting on a bar line, at least two beats
// before the fragment), then the stretched result dropped in where the fragment was, then the break
// again from the next sensible beat - preferably a downbeat - for a bar. Pre-rendered rather than
// scheduled as three Web Audio sources, so the joins are sample-accurate and the whole thing plays
// through the same one-at-a-time player as everything else.
//
// The break is treated as a loop (analysis.js works out its length in whole bars), so a lead-in
// that would start before the file wraps round to the end of it, and a return point past the end
// wraps to the start - exactly what you'd hear with the break looping in a sampler.
//
// Timing: the stretched result starts on the fragment's own start time. It has usually run past
// where the fragment ended - that's the point - so the return goes on the first strong grid line
// after the result finishes: the downbeat if one is within a beat, else beat 3, else the next beat.
// At most a fifth of a beat of the result's tail is cut (with a short fade) to make a line; if it
// finishes early there's a short gap before the BANG, which is its own classic move.
//
// Without a real tempo (grid.assumed) there's no grid to trust, so the lead-in is a flat 1.5s and
// the break simply resumes the moment the result ends.
import { applyFades } from "../dsp.js";

const RETURN_PRE_ROLL_SEC = 0.003;

/**
 * @param {object} opts
 * @param {Float32Array[]} opts.channels   the whole source break
 * @param {number} opts.sampleRate
 * @param {object} opts.grid               analysis grid
 * @param {{start:number,end:number}} opts.source
 * @param {Float32Array[]} opts.fx         the rendered result
 * @returns {{channels: Float32Array[], sampleRate:number, duration:number, fxStart:number, returnAt:number}}
 */
export function renderSnapBack({ channels, sampleRate, grid, source, fx }) {
  const total = channels[0].length;
  const duration = total / sampleRate;
  const fxSec = fx[0].length / sampleRate;
  const fragStart = source.start;
  const useGrid = grid && !grid.assumed && grid.beat > 0;

  // ---- where the lead-in starts, where the result is cut, where the break returns ----
  let preStart;
  let returnAt;
  let postSec;
  if (useGrid) {
    const { beat, bar, downbeat } = grid;
    preStart = downbeat + Math.floor((fragStart - 2 * beat - downbeat) / bar + 1e-6) * bar;
    // Let the result play out (at most a fifth of a beat of its tail is sacrificed), then come back
    // on the strongest line close enough after it: the downbeat if it's within a beat, beat 3 if
    // within three quarters of one, otherwise simply the next beat.
    const end = Math.max(fragStart + beat * 0.5, fragStart + fxSec - beat * 0.2);
    const nextLine = (step) => downbeat + Math.ceil((end - downbeat) / step - 1e-9) * step;
    const rBar = nextLine(bar);
    const rHalf = nextLine(bar / 2);
    const rBeat = nextLine(beat);
    const finish = fragStart + fxSec;
    returnAt = rBar - finish <= beat ? rBar : rHalf - finish <= beat * 0.75 ? rHalf : rBeat;
    postSec = bar;
  } else {
    preStart = fragStart - 1.5;
    returnAt = fragStart + fxSec;
    postSec = 1.5;
  }

  // ---- loop-aware reading of the source ----
  const loop = grid && grid.loopBars >= 1 ? { start: grid.loopStart, end: grid.loopEnd } : { start: 0, end: duration };
  const loopLen = Math.max(1e-3, loop.end - loop.start);
  const wrapTime = (t) => {
    if (t >= loop.start && t < loop.end) return t;
    return loop.start + ((((t - loop.start) % loopLen) + loopLen) % loopLen);
  };
  const readInto = (dst, dstOffset, fromSec, count) => {
    // Sample by sample through the wrap - lengths here are a couple of bars at most.
    const loopStartS = Math.round(loop.start * sampleRate);
    const loopEndS = Math.min(total, Math.round(loop.end * sampleRate));
    const loopLenS = Math.max(1, loopEndS - loopStartS);
    let s = Math.round(wrapTime(fromSec) * sampleRate);
    for (let c = 0; c < dst.length; c++) {
      const src = channels[Math.min(c, channels.length - 1)];
      let p = s;
      for (let i = 0; i < count; i++) {
        if (p >= loopEndS) p = loopStartS + ((p - loopStartS) % loopLenS);
        dst[c][dstOffset + i] = src[p] || 0;
        p++;
      }
    }
  };

  const ms = (m) => Math.round((m / 1000) * sampleRate);
  const preLen = Math.max(0, Math.round((fragStart - preStart) * sampleRate));
  const fxSlot = Math.max(1, Math.round((returnAt - fragStart) * sampleRate) - ms(RETURN_PRE_ROLL_SEC * 1000));
  const postLen = Math.round((postSec + RETURN_PRE_ROLL_SEC) * sampleRate);
  const outLen = preLen + fxSlot + postLen;
  const nCh = Math.max(channels.length, fx.length);
  const out = Array.from({ length: nCh }, () => new Float32Array(outLen));

  // Lead-in, with a short fade out where it hands over.
  if (preLen > 0) {
    const pre = Array.from({ length: nCh }, () => new Float32Array(preLen));
    readInto(pre, 0, preStart, preLen);
    applyFades(pre, ms(1), ms(1.5));
    for (let c = 0; c < nCh; c++) out[c].set(pre[c], 0);
  }

  // The result, cut to its slot (with a fade if it's cut).
  const fxLen = Math.min(fx[0].length, fxSlot);
  const cut = fx[0].length > fxSlot;
  for (let c = 0; c < nCh; c++) {
    const src = fx[Math.min(c, fx.length - 1)];
    const seg = src.slice(0, fxLen);
    if (cut) applyFades([seg], 0, ms(5));
    out[c].set(seg, preLen);
  }

  // BANG: the break again, from just before the return point so its transient lands intact.
  const post = Array.from({ length: nCh }, () => new Float32Array(postLen));
  readInto(post, 0, returnAt - RETURN_PRE_ROLL_SEC, postLen);
  applyFades(post, ms(0.5), ms(8));
  for (let c = 0; c < nCh; c++) out[c].set(post[c], preLen + fxSlot);

  return {
    channels: out,
    sampleRate,
    duration: outLen / sampleRate,
    fxStart: preLen / sampleRate,
    returnAt: (preLen + fxSlot) / sampleRate,
    fxCut: cut,
  };
}
