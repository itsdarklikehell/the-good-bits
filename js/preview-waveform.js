// preview-waveform.js
//
// A plain audition waveform: peaks, a playhead, click/drag to seek, play/pause/stop, a time
// readout. Deliberately NOT a second copy of editor-waveform.js - that component's entire job is
// slice boundaries (drag handles, shared edges, add/delete, zoom, re-chop), none of which apply
// here. Forcing this to reuse that module would mean threading a fake single "whole file" region
// through boundary-drag code that was never meant to represent one, for no benefit - this is a much
// smaller, simpler thing: the Stretch workspace's Original/Processed audition panes, where the only
// questions are "where am I" and "play from there".
//
// Only one instance plays at a time across the whole page (see the module-level `activeInstance`
// bus below) - starting one stops whichever other instance was playing, so Original and Processed
// (or two different files' waveforms) can never sound simultaneously by accident. That bus is also
// what makes FLIP's "click down the list of variations" audition work without any co-ordination
// between the rows: starting row 4 stops row 3, and nothing is left running behind it.
//
// PLAYBACK vs. DRAWING are separate inputs. `mono` is what the waveform is drawn from; `channels`,
// when given, is what's actually played, so a stereo result auditions in stereo while still being
// drawn from one summed overview. Passing only `mono` (as the Stretch workspace does) plays mono,
// exactly as it always did.
//
// LOOPING is opt-in per instance (`loop: true`, or setLoop() later). Off, a source is scheduled to
// stop at the end of the file and the playhead resets - the original behaviour. On, the buffer
// source loops natively in Web Audio, so the loop point is sample-accurate and gapless rather than
// re-triggered from a timer, and the playhead wraps against the context clock the same way.
import { computePeaksInRange } from "./dsp.js";

function formatTime(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

let activeInstance = null;

/**
 * @param {object} opts
 * @param {Float32Array} opts.mono
 * @param {number} opts.sampleRate
 * @param {number} opts.duration
 * @param {(name:string,fallback:string)=>string} [opts.color]
 * @param {() => AudioContext} opts.getAudioContext  shared context factory (app.js's getAudioContext)
 * @param {() => void} [opts.onPlayStateChange]
 */
export function createPreviewWaveform({
  mono: initialMono,
  channels: initialChannels = null,
  sampleRate: initialRate,
  duration: initialDuration,
  color = (_n, f) => f,
  getAudioContext,
  onPlayStateChange = () => {},
  loop = false,
  height = 64,
}) {
  // Reassigned by setAudio(); everything below reads these rather than the parameters.
  let mono = initialMono;
  let channels = initialChannels;
  let sampleRate = initialRate;
  let duration = initialDuration;
  let looping = !!loop;
  const wrap = document.createElement("div");
  wrap.className = "preview-waveform";
  wrap.tabIndex = 0;

  const canvas = document.createElement("canvas");
  canvas.className = "waveform-canvas preview-waveform-canvas";
  wrap.appendChild(canvas);

  const bar = document.createElement("div");
  bar.className = "preview-waveform-bar";
  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "btn btn--ghost btn--small";
  playBtn.textContent = "▶";
  playBtn.title = "Play/pause (Space)";
  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "btn btn--ghost btn--small";
  stopBtn.textContent = "■";
  stopBtn.title = "Stop (Esc)";
  const timeEl = document.createElement("span");
  timeEl.className = "preview-waveform-time";
  bar.append(playBtn, stopBtn, timeEl);
  wrap.appendChild(bar);

  const BIN_COUNT = 500;
  // Mutable so setAudio() can swap what this player is showing without tearing the whole
  // widget down - see setAudio's own comment for why that matters.
  let hasAudio = !!(mono && mono.length && sampleRate && duration > 0);
  let peaks = hasAudio ? computePeaksInRange(mono, 0, mono.length, BIN_COUNT) : null;

  let audioCtx = null;
  let buffer = null;
  let source = null;
  let playing = false;
  let anchorPos = 0; // file-time seconds, valid when !playing
  let anchorTime = 0; // audioCtx.currentTime at which playback was at anchorPos, valid when playing
  let rafId = 0;
  let dragPreviewPos = null; // set while dragging, before release commits the seek

  function timeToX(t, w) {
    return duration > 0 ? (t / duration) * w : 0;
  }
  function xToTime(x, w) {
    return w > 0 ? Math.max(0, Math.min(duration, (x / w) * duration)) : 0;
  }

  function currentPos() {
    if (dragPreviewPos != null) return dragPreviewPos;
    if (!playing) return anchorPos;
    const raw = anchorPos + (audioCtx.currentTime - anchorTime);
    if (!looping) return Math.min(duration, raw);
    return duration > 0 ? ((raw % duration) + duration) % duration : 0;
  }

  function redraw() {
    const rectWidth = Math.max(100, Math.round(canvas.getBoundingClientRect().width || 300));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssH = height;
    canvas.width = Math.round(rectWidth * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rectWidth;
    const h = cssH;
    const mid = h / 2;
    ctx.clearRect(0, 0, w, h);

    if (!hasAudio) {
      ctx.fillStyle = color("--text-faint", "#8a929a");
      ctx.font = "500 11px ui-monospace, Menlo, monospace";
      ctx.textBaseline = "middle";
      ctx.fillText("no audio yet", 8, mid);
      timeEl.textContent = "";
      return;
    }

    ctx.fillStyle = color("--wave-fill", "#5b6670");
    const barWidth = w / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const amp = Math.max(1, peaks[i] * (h * 0.44));
      ctx.fillRect(i * barWidth, mid - amp, Math.max(1, barWidth - 0.4), amp * 2);
    }

    const pos = currentPos();
    const x = timeToX(pos, w);
    ctx.strokeStyle = color(dragPreviewPos != null ? "--accent-2" : "--wave-handle", "#eceef1");
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();

    timeEl.textContent = `${formatTime(pos)} / ${formatTime(duration)}`;
    playBtn.textContent = playing ? "❚❚" : "▶";
    playBtn.classList.toggle("is-playing", playing);
  }

  function getBuffer() {
    if (!buffer) {
      audioCtx = audioCtx || getAudioContext();
      // Play the real channel layout when there is one; fall back to the drawn mono overview.
      const src = channels && channels.length && channels[0] && channels[0].length ? channels : [mono];
      buffer = audioCtx.createBuffer(src.length, src[0].length, sampleRate);
      for (let c = 0; c < src.length; c++) buffer.copyToChannel(src[c], c);
    }
    return buffer;
  }

  function tick() {
    if (!playing) return;
    redraw();
    rafId = requestAnimationFrame(tick);
  }

  function pause() {
    if (!playing) return;
    anchorPos = currentPos();
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch (_) {
        /* already stopped */
      }
      source = null;
    }
    playing = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    redraw();
    onPlayStateChange(false);
  }

  function stop() {
    pause();
    anchorPos = 0;
    redraw();
  }

  function play(fromTime) {
    if (!hasAudio) return;
    if (activeInstance && activeInstance !== instance) activeInstance.pause();
    if (source) pause();
    try {
      audioCtx = audioCtx || getAudioContext();
    } catch (_) {
      return; // no Web Audio available; buttons just do nothing rather than throwing
    }
    let startAt = fromTime != null ? fromTime : anchorPos;
    if (startAt >= duration - 0.005) startAt = 0;
    const src = audioCtx.createBufferSource();
    src.buffer = getBuffer();
    src.loop = looping;
    src.connect(audioCtx.destination);
    src.onended = () => {
      if (source === src) {
        playing = false;
        source = null;
        anchorPos = 0;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        redraw();
        onPlayStateChange(false);
      }
    };
    const now = audioCtx.currentTime;
    src.start(now, startAt);
    // A looping source must never be given a stop time - that's what "loop until stopped" means.
    if (!looping) src.stop(now + (duration - startAt));
    source = src;
    anchorTime = now;
    anchorPos = startAt;
    playing = true;
    activeInstance = instance;
    tick();
    onPlayStateChange(true);
  }

  function togglePlay() {
    if (playing) pause();
    else play(anchorPos);
  }

  function seekTo(t) {
    const wasPlaying = playing;
    const clamped = Math.max(0, Math.min(duration, t));
    if (wasPlaying) play(clamped);
    else {
      anchorPos = clamped;
      redraw();
    }
  }

  playBtn.addEventListener("click", togglePlay);
  stopBtn.addEventListener("click", stop);

  canvas.addEventListener("pointerdown", (ev) => {
    if (!hasAudio) return;
    wrap.focus({ preventScroll: true });
    canvas.setPointerCapture(ev.pointerId);
    const rect = canvas.getBoundingClientRect();
    dragPreviewPos = xToTime(ev.clientX - rect.left, rect.width);
    redraw();
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (dragPreviewPos == null) return;
    const rect = canvas.getBoundingClientRect();
    dragPreviewPos = xToTime(ev.clientX - rect.left, rect.width);
    redraw();
  });
  function commitDrag() {
    if (dragPreviewPos == null) return;
    const t = dragPreviewPos;
    dragPreviewPos = null;
    seekTo(t);
  }
  canvas.addEventListener("pointerup", commitDrag);
  canvas.addEventListener("pointercancel", () => {
    dragPreviewPos = null;
    redraw();
  });

  wrap.addEventListener("keydown", (ev) => {
    if (ev.key === " ") {
      ev.preventDefault();
      togglePlay();
    } else if (ev.key === "Escape") {
      stop();
    }
  });

  redraw();
  let resizeObserver = null;
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => redraw());
    resizeObserver.observe(canvas);
  } else {
    window.addEventListener("resize", redraw);
  }

  /**
   * Point this player at different audio, keeping the playhead where it is.
   *
   * Exists for A/B comparison. Two players side by side each have their own playhead, so
   * comparing "the same moment, processed and unprocessed" means starting one, stopping it,
   * starting the other and hunting for the position again. Swapping the buffer underneath a
   * single playhead makes it one click, which is the only way an A/B is actually useful.
   *
   * Position is preserved and clamped to the new duration, and playback continues if it was
   * already running.
   */
  function setAudio(next) {
    const wasPlaying = playing;
    const at = currentPos();
    if (playing) pause();
    mono = next && next.mono;
    channels = (next && next.channels) || null;
    sampleRate = next && next.sampleRate;
    duration = (next && next.duration) || 0;
    buffer = null; // rebuilt lazily by getBuffer() from the new samples
    hasAudio = !!(mono && mono.length && sampleRate && duration > 0);
    peaks = hasAudio ? computePeaksInRange(mono, 0, mono.length, BIN_COUNT) : null;
    anchorPos = Math.max(0, Math.min(duration, at));
    dragPreviewPos = null;
    redraw();
    if (wasPlaying && hasAudio) play(anchorPos);
  }

  /**
   * Turn looping on or off. Restarts the source when playing, because `loop` is read at start()
   * time - the playhead is carried over, so this is a mode change rather than a re-trigger.
   */
  function setLoop(next) {
    const want = !!next;
    if (looping === want) return;
    looping = want;
    if (playing) play(currentPos());
  }

  const instance = {
    el: wrap,
    setAudio,
    setLoop,
    isLooping: () => looping,
    play: (t) => play(t),
    pause,
    stop,
    togglePlay,
    seekTo,
    isPlaying: () => playing,
    hasAudio: () => hasAudio,
    getPosition: () => currentPos(),
    getDuration: () => duration,
    focus: () => wrap.focus({ preventScroll: true }),
    redraw,
    destroy: () => {
      pause();
      if (activeInstance === instance) activeInstance = null;
      if (resizeObserver) resizeObserver.disconnect();
      else window.removeEventListener("resize", redraw);
    },
  };
  return instance;
}
