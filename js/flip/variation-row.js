// variation-row.js
//
// One row in the FLIP results list: the original, or one generated variation.
//
// The whole screen is a list you click down at speed, so the row is built around that: the row
// itself is the play button (clicking anywhere that isn't another control toggles it), the waveform
// is inline rather than stacked so nine rows fit on a screen, and the shared one-instance-at-a-time
// rule in js/preview-waveform.js means starting any row stops whatever was playing without this
// module or the controller having to co-ordinate anything.
//
// The seed is an INPUT, not a label. "I don't want an interesting result to disappear forever" is
// only true if a seed you wrote down can be typed back in, and a read-only seed is a receipt for
// something you can no longer buy.
import { createPreviewWaveform } from "../preview-waveform.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function iconButton(className, label, title) {
  const btn = el("button", `btn btn--ghost btn--small ${className}`, label);
  btn.type = "button";
  btn.title = title;
  return btn;
}

/**
 * @param {object} opts
 * @param {string} opts.id           "ORIGINAL" / "FLIP 03"
 * @param {boolean} opts.isOriginal
 * @param {() => AudioContext} opts.getAudioContext
 * @param {(name:string, fallback:string) => string} opts.color
 * @param {boolean} opts.loop
 * @param {(seed:number) => void} [opts.onSeedChange]
 * @param {() => void} [opts.onRegenerate]
 * @param {() => void} [opts.onExport]
 */
export function createVariationRow({ id, isOriginal = false, getAudioContext, color, loop = false, onSeedChange, onRegenerate, onExport }) {
  const root = el("div", `flip-row${isOriginal ? " flip-row--original" : ""}`);

  const playBtn = iconButton("flip-row-play", "▶", "Play / stop");
  const label = el("span", "flip-row-id", id);

  const player = createPreviewWaveform({
    mono: null,
    channels: null,
    sampleRate: 0,
    duration: 0,
    color,
    getAudioContext,
    loop,
    height: 34,
    onPlayStateChange: (playing) => {
      playBtn.textContent = playing ? "■" : "▶";
      root.classList.toggle("is-playing", playing);
    },
  });
  player.el.classList.add("flip-row-wave");

  // The description and the stale badge share ONE grid cell. The badge has to live somewhere that
  // can't change the geometry of the row: put it in the right-hand rail and every waveform on the
  // page resizes the moment a setting is changed, which is precisely when you most want to compare
  // them against what you just heard.
  const descWrap = el("div", "flip-row-desc-wrap");
  const desc = el("span", "flip-row-desc", isOriginal ? "your loop, untouched" : "");
  descWrap.appendChild(desc);
  const meta = el("div", "flip-row-meta");

  let seedInput = null;
  const actions = el("div", "flip-row-actions");

  if (!isOriginal) {
    const seedWrap = el("label", "flip-seed");
    seedWrap.appendChild(el("span", "flip-seed-label", "seed"));
    seedInput = el("input", "flip-seed-input");
    seedInput.type = "text";
    seedInput.inputMode = "numeric";
    seedInput.spellcheck = false;
    seedInput.title = "This variation's seed. Type a seed you kept and press Enter to get that arrangement back.";
    seedInput.addEventListener("focus", () => seedInput.select());
    seedInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        seedInput.blur();
      }
    });
    seedInput.addEventListener("change", () => {
      const raw = seedInput.value.trim().replace(/[^0-9]/g, "");
      const value = Number(raw);
      if (!raw || !Number.isFinite(value)) {
        render(); // put the current seed back rather than leaving nonsense in the field
        return;
      }
      if (onSeedChange) onSeedChange(value >>> 0);
    });
    seedWrap.appendChild(seedInput);
    meta.appendChild(seedWrap);

    const regenBtn = iconButton("flip-row-regen", "⟳", "Replace this one with a fresh take on the same settings");
    regenBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (onRegenerate) onRegenerate();
    });
    const exportBtn = iconButton("flip-row-export", "↓", "Download this variation as a WAV");
    exportBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (onExport) onExport();
    });
    actions.append(regenBtn, exportBtn);
  }

  const staleBadge = el("span", "flip-stale", "settings changed");
  staleBadge.title = "This was generated before you changed a setting. Generate again to hear the new ones.";
  staleBadge.hidden = true;
  descWrap.appendChild(staleBadge);

  // Six cells, always, even on the original - the empty seed and action cells are what keep its
  // waveform the same width as every variation's. See .flip-row in css/style.css.
  root.append(playBtn, label, player.el, descWrap, meta, actions);

  playBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    player.togglePlay();
  });
  // Anywhere on the row that isn't a control: the row IS the play button. Typing in the seed field
  // must not start playback, hence the explicit opt-out rather than relying on stopPropagation
  // from every interactive descendant.
  root.addEventListener("click", (ev) => {
    if (ev.target.closest("button, input, canvas, .flip-row-actions")) return;
    player.togglePlay();
  });

  let state = { seed: null, description: "", stale: false };

  function render() {
    if (seedInput && state.seed != null && document.activeElement !== seedInput) seedInput.value = String(state.seed);
    desc.textContent = state.description || (isOriginal ? "your loop, untouched" : "");
    staleBadge.hidden = !state.stale;
    root.classList.toggle("is-stale", !!state.stale);
  }

  return {
    el: root,
    setAudio(audio) {
      player.setAudio(audio ? { mono: audio.mono, channels: audio.channels, sampleRate: audio.sampleRate, duration: audio.duration } : { mono: null, sampleRate: 0, duration: 0 });
    },
    setInfo({ seed, description, stale, title }) {
      if (seed !== undefined) state.seed = seed;
      if (description !== undefined) state.description = description;
      if (stale !== undefined) state.stale = !!stale;
      if (title !== undefined) root.title = title;
      render();
    },
    setLoop(next) {
      player.setLoop(next);
    },
    isPlaying: () => player.isPlaying(),
    play: () => player.play(0),
    stop: () => player.stop(),
    redraw: () => player.redraw(),
    destroy() {
      player.destroy();
      root.remove();
    },
  };
}
