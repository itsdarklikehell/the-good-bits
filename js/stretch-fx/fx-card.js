// fx-card.js
//
// One STRETCH FX result: a slot with a waveform, the facts about what was done to it, and three
// buttons - PLAY, MUTATE, EXPORT. Built for clicking down a bank at speed: the card itself is a play
// button (anywhere that isn't another control), and playback goes through preview-waveform.js, so
// starting one card stops whatever else was playing without any co-ordination.
//
// The card holds TWO renders of the same result and one player: SOLO (just the stretched sample)
// and SNAP BACK (the sample dropped back into the break - see snap-back.js). Switching the
// audition mode swaps the buffer under the player rather than rebuilding anything. In Snap Back a
// highlight marks where the stretch sits, so you can see the BREAK -> STRETCH -> BANG shape you're
// hearing.
import { createPreviewWaveform } from "../preview-waveform.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * @param {object} opts
 * @param {string} opts.id
 * @param {() => AudioContext} opts.getAudioContext
 * @param {(name:string, fallback:string) => string} opts.color
 * @param {() => void} opts.onMutate
 * @param {() => void} opts.onExport
 * @param {(playing:boolean) => void} [opts.onPlayStateChange]
 */
export function createFxCard({ id, getAudioContext, color, onMutate, onExport, onPlayStateChange = () => {} }) {
  const root = el("article", "sfx-card is-rendering");

  const head = el("div", "sfx-card-head");
  const idEl = el("span", "sfx-card-id", id);
  const typeEl = el("span", "sfx-card-type");
  const nameEl = el("span", "sfx-card-name");
  const heatEl = el("span", "sfx-card-heat");
  head.append(idEl, typeEl, nameEl, heatEl);

  const waveWrap = el("div", "sfx-card-wave");
  const player = createPreviewWaveform({
    mono: null,
    sampleRate: 0,
    duration: 0,
    color,
    getAudioContext,
    height: 46,
    onPlayStateChange: (playing) => {
      root.classList.toggle("is-playing", playing);
      playBtn.textContent = playing ? "■ STOP" : "▶ PLAY";
      onPlayStateChange(playing);
    },
  });
  const span = el("div", "sfx-card-span");
  span.hidden = true;
  const busy = el("div", "sfx-card-busy", "rendering…");
  waveWrap.append(player.el, span, busy);

  const facts = el("dl", "sfx-card-facts");
  const fact = (label) => {
    const dt = el("dt", null, label);
    const dd = el("dd");
    facts.append(dt, dd);
    return dd;
  };
  const sourceDd = fact("Source");
  const fragDd = fact("Fragment");
  const stretchDd = fact("Stretch");
  const pitchDd = fact("Pitch");
  const reverseDd = fact("Reverse");
  const charDd = fact("Character");

  const actions = el("div", "sfx-card-actions");
  const playBtn = el("button", "btn btn--small sfx-card-play", "▶ PLAY");
  playBtn.type = "button";
  playBtn.title = "Play / stop (the card itself works too)";
  const mutateBtn = el("button", "btn btn--ghost btn--small sfx-card-mutate", "MUTATE");
  mutateBtn.type = "button";
  mutateBtn.title = "A related take: same fragment, some of the processing nudged";
  const exportBtn = el("button", "btn btn--ghost btn--small sfx-card-export", "EXPORT");
  exportBtn.type = "button";
  exportBtn.title = "Download this one as a WAV";
  actions.append(playBtn, mutateBtn, exportBtn);

  root.append(head, waveWrap, facts, actions);

  playBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    player.togglePlay();
  });
  mutateBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onMutate();
  });
  exportBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onExport();
  });
  root.addEventListener("click", (ev) => {
    if (ev.target.closest("button, input, select, canvas")) return;
    player.togglePlay();
  });

  let solo = null;
  let snap = null;
  let mode = "snap";

  function applyMode() {
    const which = mode === "snap" && snap ? snap : solo;
    player.setAudio(which ? { mono: which.mono, channels: which.channels, sampleRate: which.sampleRate, duration: which.duration } : null);
    if (which && which === snap && snap.duration > 0) {
      span.hidden = false;
      span.style.left = `${(snap.fxStart / snap.duration) * 100}%`;
      span.style.width = `${((snap.returnAt - snap.fxStart) / snap.duration) * 100}%`;
    } else span.hidden = true;
  }

  return {
    el: root,
    /** Render in progress (or not) - buttons are disabled while it runs. */
    setBusy(isBusy, text) {
      root.classList.toggle("is-rendering", !!isBusy);
      busy.textContent = text || "rendering…";
      mutateBtn.disabled = exportBtn.disabled = playBtn.disabled = !!isBusy;
    },
    setError(message) {
      root.classList.remove("is-rendering");
      root.classList.add("is-error");
      busy.textContent = message;
      mutateBtn.disabled = false;
      exportBtn.disabled = playBtn.disabled = true;
    },
    setAudio(nextSolo, nextSnap) {
      root.classList.remove("is-error");
      solo = nextSolo;
      snap = nextSnap;
      applyMode();
    },
    setMode(next) {
      if (mode === next) return;
      mode = next;
      const wasPlaying = player.isPlaying();
      applyMode();
      if (wasPlaying) player.play(0);
    },
    setInfo({ id: newId, type, name, heat, source, fragment, stretch, pitch, reverse, character }) {
      if (newId != null) idEl.textContent = newId;
      typeEl.textContent = type || "";
      nameEl.textContent = name || "";
      heatEl.textContent = heat || "";
      sourceDd.textContent = source || "";
      fragDd.textContent = fragment || "";
      stretchDd.textContent = stretch || "";
      pitchDd.textContent = pitch || "";
      reverseDd.textContent = reverse || "";
      charDd.textContent = character || "";
    },
    setHeatLevel(level) {
      root.dataset.heat = String(level);
    },
    play: () => player.play(0),
    stop: () => player.stop(),
    isPlaying: () => player.isPlaying(),
    redraw: () => player.redraw(),
    destroy() {
      player.destroy();
      root.remove();
    },
  };
}
