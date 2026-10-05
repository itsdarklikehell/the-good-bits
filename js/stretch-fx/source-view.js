// source-view.js
//
// The break, drawn once, with everything STRETCH FX knows about it on top: the bar/beat grid, a
// numbered marker for every fragment the current bank was cut from, and a region you drag out
// yourself for MAKE STRETCH FX. Click without dragging to hear the break from that point.
//
// Deliberately its own small canvas rather than editor-waveform.js: that component is a slice
// editor (shared boundaries, add/delete/undo across many contiguous chops), and forcing one
// free-floating selection through it would mean faking a slice list it was never meant to hold.
// Playback, on the other hand, is NOT reinvented - it goes through a preview-waveform.js instance,
// so auditioning the break obeys the page-wide one-player-at-a-time rule like every card does.
import { computePeaksInRange } from "../dsp.js";
import { createPreviewWaveform } from "../preview-waveform.js";

const MIN_SELECTION_SEC = 0.03;
const DRAG_THRESHOLD_PX = 4;
/** A dragged selection's start within this of a detected onset is pulled onto it (minus pre-roll). */
const ONSET_SNAP_SEC = 0.025;
const PRE_ROLL_SEC = 0.003;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * @param {object} opts
 * @param {() => AudioContext} opts.getAudioContext
 * @param {(name:string, fallback:string) => string} opts.color
 * @param {(sel:{start:number,end:number}|null) => void} opts.onSelect
 */
export function createSourceView({ getAudioContext, color, onSelect }) {
  const root = el("div", "sfx-source-view");
  const canvas = el("canvas", "waveform-canvas sfx-source-canvas");
  root.appendChild(canvas);

  // The audition player: never shown, just played - see this file's header.
  const player = createPreviewWaveform({
    mono: null,
    sampleRate: 0,
    duration: 0,
    color,
    getAudioContext,
    height: 10,
    onPlayStateChange: (playing) => {
      root.classList.toggle("is-playing", playing);
      if (playing) tick();
      onPlayStateChangeCb(playing);
    },
  });
  let onPlayStateChangeCb = () => {};

  let audio = null; // {mono, channels, sampleRate, duration}
  let peaks = null;
  let grid = null;
  let onsets = [];
  let markers = []; // [{start, end, label, active}]
  let selection = null; // {start, end}
  let drag = null;
  let rafId = 0;

  const HEIGHT = 96;

  function xToTime(x, w) {
    return audio ? Math.max(0, Math.min(audio.duration, (x / w) * audio.duration)) : 0;
  }
  function timeToX(t, w) {
    return audio ? (t / audio.duration) * w : 0;
  }

  function redraw() {
    const w = Math.max(100, Math.round(canvas.getBoundingClientRect().width || 600));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, HEIGHT);
    const mid = HEIGHT / 2;
    if (!audio) {
      ctx.fillStyle = color("--text-faint", "#8a929a");
      ctx.font = "500 11px ui-monospace, Menlo, monospace";
      ctx.textBaseline = "middle";
      ctx.fillText("no break loaded", 8, mid);
      return;
    }

    // Grid first, under everything: faint beats, stronger bars.
    if (grid && !grid.assumed) {
      for (let k = Math.ceil((0 - grid.downbeat) / grid.beat); ; k++) {
        const t = grid.downbeat + k * grid.beat;
        if (t > audio.duration) break;
        if (t < 0) continue;
        const isBar = ((k % 4) + 4) % 4 === 0;
        ctx.fillStyle = color(isBar ? "--wave-line" : "--border", isBar ? "rgba(236,238,241,.45)" : "#2b2f36");
        ctx.fillRect(Math.round(timeToX(t, w)), 0, 1, HEIGHT);
      }
    }

    // Where the current bank came from.
    for (const m of markers) {
      const x0 = timeToX(m.start, w);
      const x1 = Math.max(x0 + 2, timeToX(m.end, w));
      ctx.fillStyle = color(m.active ? "--wave-region-sel" : "--wave-region-b", m.active ? "rgba(255,75,59,.16)" : "rgba(255,130,102,.07)");
      ctx.fillRect(x0, 0, x1 - x0, HEIGHT);
    }

    ctx.fillStyle = color("--wave-fill", "#5b6670");
    const bw = w / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const amp = Math.max(1, peaks[i] * (HEIGHT * 0.42));
      ctx.fillRect(i * bw, mid - amp, Math.max(1, bw - 0.4), amp * 2);
    }

    // Marker tags on top of the waveform so they stay readable.
    ctx.font = "600 10px ui-monospace, Menlo, monospace";
    ctx.textBaseline = "top";
    const tagRows = [];
    for (const m of markers) {
      const x = timeToX(m.start, w);
      // Stagger overlapping tags onto a second row rather than printing them over each other.
      let row = 0;
      while (tagRows[row] != null && x < tagRows[row] + 4) row++;
      const text = m.label;
      const tw = ctx.measureText(text).width + 6;
      tagRows[row] = x + tw;
      ctx.fillStyle = color(m.active ? "--accent" : "--accent-dim", m.active ? "#ff4b3b" : "#7d2b22");
      ctx.fillRect(x, 2 + row * 14, tw, 13);
      ctx.fillStyle = color(m.active ? "--on-accent" : "--text", m.active ? "#1a0906" : "#eceef1");
      ctx.fillText(text, x + 3, 3 + row * 14);
    }

    if (selection) {
      const x0 = timeToX(selection.start, w);
      const x1 = timeToX(selection.end, w);
      ctx.fillStyle = color("--wave-region-sel", "rgba(255,75,59,.16)");
      ctx.fillRect(x0, 0, x1 - x0, HEIGHT);
      ctx.fillStyle = color("--accent", "#ff4b3b");
      ctx.fillRect(Math.round(x0), 0, 2, HEIGHT);
      ctx.fillRect(Math.round(x1) - 2, 0, 2, HEIGHT);
    }

    if (player.isPlaying()) {
      const x = timeToX(player.getPosition(), w);
      ctx.fillStyle = color("--wave-handle", "#eceef1");
      ctx.fillRect(Math.round(x), 0, 1.5, HEIGHT);
    }
  }

  function tick() {
    cancelAnimationFrame(rafId);
    const step = () => {
      redraw();
      if (player.isPlaying()) rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }

  function snapStart(t) {
    let best = null;
    for (const o of onsets) {
      const d = Math.abs(o.time - t);
      if (d <= ONSET_SNAP_SEC && (!best || d < Math.abs(best.time - t))) best = o;
    }
    return best ? Math.max(0, best.time - PRE_ROLL_SEC) : t;
  }

  canvas.addEventListener("pointerdown", (ev) => {
    if (!audio) return;
    canvas.setPointerCapture(ev.pointerId);
    const rect = canvas.getBoundingClientRect();
    drag = { x0: ev.clientX - rect.left, t0: xToTime(ev.clientX - rect.left, rect.width), moved: false, alt: ev.altKey };
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    if (!drag.moved && Math.abs(x - drag.x0) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    const t = xToTime(x, rect.width);
    selection = { start: Math.min(drag.t0, t), end: Math.max(drag.t0, t) };
    redraw();
  });
  const endDrag = () => {
    if (!drag) return;
    const wasDrag = drag.moved;
    const alt = drag.alt;
    const t0 = drag.t0;
    drag = null;
    if (!wasDrag) {
      // A click: hear the break from here.
      player.play(t0);
      return;
    }
    if (selection && selection.end - selection.start >= MIN_SELECTION_SEC) {
      // Alt-drag takes the region exactly as drawn; otherwise its start is pulled onto a transient.
      if (!alt) {
        const snapped = snapStart(selection.start);
        if (selection.end - snapped >= MIN_SELECTION_SEC) selection.start = snapped;
      }
      onSelect({ ...selection });
    } else {
      selection = null;
      onSelect(null);
    }
    redraw();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", () => {
    drag = null;
    redraw();
  });

  let resizeObserver = null;
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => redraw());
    resizeObserver.observe(canvas);
  }

  return {
    el: root,
    setAudio(next) {
      player.stop();
      audio = next;
      peaks = next ? computePeaksInRange(next.mono, 0, next.mono.length, 900) : null;
      selection = null;
      markers = [];
      player.setAudio(next ? { mono: next.mono, channels: next.channels, sampleRate: next.sampleRate, duration: next.duration } : null);
      redraw();
    },
    setAnalysis({ grid: g, onsets: o }) {
      grid = g;
      onsets = o || [];
      redraw();
    },
    setMarkers(list) {
      markers = list || [];
      redraw();
    },
    getSelection: () => (selection ? { ...selection } : null),
    clearSelection() {
      selection = null;
      redraw();
    },
    /** Play the whole break, or just the selection. */
    play({ selectionOnly = false } = {}) {
      if (!audio) return;
      if (player.isPlaying()) {
        player.stop();
        return;
      }
      if (selectionOnly && selection) {
        player.play(selection.start);
        const stopAt = selection.end;
        const guard = () => {
          if (!player.isPlaying()) return;
          if (player.getPosition() >= stopAt) player.stop();
          else requestAnimationFrame(guard);
        };
        requestAnimationFrame(guard);
      } else player.play(0);
    },
    isPlaying: () => player.isPlaying(),
    onPlayStateChange(cb) {
      onPlayStateChangeCb = cb || (() => {});
    },
    stop: () => player.stop(),
    redraw,
    destroy() {
      player.destroy();
      if (resizeObserver) resizeObserver.disconnect();
      cancelAnimationFrame(rafId);
    },
  };
}
