// controller.js
//
// LAB: screen + session state only - every actual decision lives in generator.js (which graph to
// try next) and render.js (what that graph sounds like and whether it's safe/novel enough to keep).
// Same split, and the same "own workspace, own state, shares nothing with the batch queue" shape as
// PLAY NICE / FLIP / STRETCH FX (js/play-nice, js/flip, js/stretch-fx/controller.js).
//
// The workflow the spec asks for: load a loop, NEW draws a fresh algorithm from the primitive
// registry, MUTATE takes a related step from whatever's currently loaded, KEEP remembers the ones
// worth coming back to (persisted to localStorage so a session survives a reload). Every render -
// NEW, MUTATE, a typed seed, a KEEP recall, a macro slider - goes through render.js's safety pass, so
// nothing that reaches the speaker can be NaN, infinite, or a catastrophic peak, whatever the
// generator produced.
import { buildGraph, mutateGraph, renderMutant, isAcceptable } from "./render.js";
import { DEFAULT_MACRO_VALUES, MACRO_KEYS, describeGraph } from "./generator.js";
import { makeRng, deriveSeed } from "../dsp/stretch/rng.js";
import { toMono } from "../dsp.js";
import { encodeWav } from "../audio-codec.js";
import { createPreviewWaveform } from "../preview-waveform.js";
import { AUDIO_EXTS } from "../io-fs.js";
import { readJSON, writeJSON } from "../local-storage.js";

const STORAGE_KEY = "good-bits-lab-v1";
const MAX_SEARCH_ATTEMPTS = 24;
const MAX_KEPT = 40;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function extOf(name) {
  const dot = String(name || "").lastIndexOf(".");
  return dot === -1 ? "" : String(name).slice(dot).toLowerCase();
}

function yieldToUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fmt(n, digits = 3) {
  return Number.isFinite(n) ? n.toFixed(digits) : String(n);
}

/** One drop target for the whole workspace, same shape as FLIP/STRETCH FX's own copies. */
function wireDropZone(zone, onFiles) {
  ["dragenter", "dragover"].forEach((name) => {
    zone.addEventListener(name, (ev) => {
      if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types || []).includes("Files")) return;
      ev.preventDefault();
      zone.classList.add("is-dragover");
    });
  });
  ["dragleave", "dragend", "drop"].forEach((name) => {
    zone.addEventListener(name, (ev) => {
      if (name === "dragleave" && ev.relatedTarget && zone.contains(ev.relatedTarget)) return;
      zone.classList.remove("is-dragover");
    });
  });
  zone.addEventListener("drop", (ev) => {
    if (!ev.dataTransfer) return;
    ev.preventDefault();
    const files = Array.from(ev.dataTransfer.files || []);
    if (files.length) onFiles(files);
  });
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.container
 * @param {HTMLElement} deps.chromeContainer
 * @param {(file:File, ext:string) => Promise<{buffer:object}>} deps.decodeFile
 * @param {() => AudioContext} deps.getAudioContext
 * @param {(name:string, fallback:string) => string} deps.color
 * @param {(msg:string) => void} deps.log
 * @param {(msg:string) => void} deps.logWarn
 * @param {(msg:string) => void} deps.logSuccess
 */
export function createLab(deps) {
  const { container, chromeContainer, decodeFile, getAudioContext, color, log, logWarn, logSuccess } = deps;

  const state = {
    file: null,
    name: "",
    audio: null, // {channels, mono, sampleRate, duration}
    status: "empty", // empty | decoding | ready | error
    error: null,
    graph: null,
    macroValues: { ...DEFAULT_MACRO_VALUES },
    mutant: null, // {channels, mono, analysis, novelty, attempts, gaveUp}
    audition: "mutant", // "original" | "mutant"
    busy: false,
    busyLabel: "",
    kept: [],
  };
  restore();

  // The only place LAB touches Math.random-adjacent nondeterminism: minting a fresh NOMINAL seed to
  // hand to NEW/MUTATE. Everything downstream of that seed (buildGraph, mutateGraph, the safety
  // search's retries) is pure - see generator.js/render.js.
  const seedSource = makeRng((Date.now() ^ 0x4c1a2e77) >>> 0);
  const mintSeed = () => Math.floor(seedSource.next() * 900000000) + 1000;
  let generation = 0;

  const root = el("div", "lab");
  container.appendChild(root);

  // -------------------------------------------------------------------------
  // Source
  // -------------------------------------------------------------------------

  const sourcePanel = el("section", "lab-panel lab-source");
  const sourceHead = el("div", "lab-panel-head");
  sourceHead.appendChild(el("h2", "lab-panel-title", "Source"));
  const sourceSummary = el("span", "lab-summary");
  sourceHead.appendChild(sourceSummary);
  sourcePanel.appendChild(sourceHead);

  const dropzone = el("div", "lab-dropzone");
  const dropCopy = el("div", "lab-dropzone-copy");
  dropCopy.appendChild(el("strong", null, "Drop a loop here"));
  dropCopy.appendChild(el("span", null, "anything you can loop - LAB grows unfamiliar processing graphs from it, not effect presets."));
  const addBtn = el("button", "btn btn--primary", "Add audio");
  addBtn.type = "button";
  dropzone.append(dropCopy, addBtn);
  sourcePanel.appendChild(dropzone);

  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = [...AUDIO_EXTS].join(",");
  fileInput.hidden = true;
  sourcePanel.appendChild(fileInput);

  const loaded = el("div", "lab-loaded");
  loaded.hidden = true;
  const loadedHead = el("div", "lab-loaded-head");
  const loadedName = el("span", "lab-loaded-name");
  const loadedActions = el("div", "lab-loaded-actions");
  const replaceBtn = el("button", "btn btn--ghost btn--small", "Replace");
  replaceBtn.type = "button";
  const clearBtn = el("button", "btn btn--ghost btn--small", "×");
  clearBtn.type = "button";
  clearBtn.title = "Remove this loop and the current mutant";
  loadedActions.append(replaceBtn, clearBtn);
  loadedHead.append(loadedName, loadedActions);
  loaded.appendChild(loadedHead);
  const sourceStatus = el("p", "lab-status");
  loaded.appendChild(sourceStatus);
  sourcePanel.appendChild(loaded);
  root.appendChild(sourcePanel);

  addBtn.addEventListener("click", () => fileInput.click());
  replaceBtn.addEventListener("click", () => fileInput.click());
  clearBtn.addEventListener("click", () => clearSource());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (file) void loadFile(file);
  });
  wireDropZone(root, (files) => {
    const audio = files.filter((f) => AUDIO_EXTS.has(extOf(f.name)));
    if (!audio.length) {
      logWarn("LAB takes one loop - that wasn't audio.");
      return;
    }
    if (audio.length > 1) log(`LAB works on one loop at a time - using "${audio[0].name}".`);
    void loadFile(audio[0]);
  });

  // -------------------------------------------------------------------------
  // Player: one waveform, two buffers underneath it - see preview-waveform.js's setAudio(), built
  // exactly for this A/B (position preserved, playback continues across the swap).
  // -------------------------------------------------------------------------

  const playerPanel = el("section", "lab-panel lab-player");
  playerPanel.hidden = true;
  const playerHead = el("div", "lab-panel-head");
  playerHead.appendChild(el("h2", "lab-panel-title", "Audition"));
  const auditionSeg = el("div", "seg lab-audition-seg");
  auditionSeg.setAttribute("role", "group");
  auditionSeg.setAttribute("aria-label", "Original or mutant");
  const auditionButtons = new Map();
  for (const [key, label, title] of [
    ["original", "ORIGINAL", "The loop as loaded"],
    ["mutant", "MUTANT", "The current processing graph applied to the loop"],
  ]) {
    const btn = el("button", "seg-btn", label);
    btn.type = "button";
    btn.title = title;
    btn.addEventListener("click", () => setAudition(key));
    auditionSeg.appendChild(btn);
    auditionButtons.set(key, btn);
  }
  playerHead.appendChild(auditionSeg);
  playerPanel.appendChild(playerHead);

  const player = createPreviewWaveform({ getAudioContext, color, loop: true, height: 72 });
  playerPanel.appendChild(player.el);
  const mutantStatus = el("p", "lab-mutant-status");
  playerPanel.appendChild(mutantStatus);
  root.appendChild(playerPanel);

  // -------------------------------------------------------------------------
  // Macros: four generic controls. What each one actually touches is decided per-graph by the
  // generator (see generator.js's macro binding) - here they're just four sliders that trigger a
  // live re-render, debounced so a drag doesn't render on every pixel.
  // -------------------------------------------------------------------------

  const macrosPanel = el("section", "lab-panel lab-macros");
  macrosPanel.appendChild(el("h2", "lab-panel-title", "Macros"));
  const macroSliders = new Map();
  const macroRow = el("div", "lab-macro-row");
  for (const letter of MACRO_KEYS) {
    const field = el("div", "field lab-field lab-macro-field");
    const label = el("label", null, letter);
    label.htmlFor = `lab-macro-${letter}`;
    field.appendChild(label);
    const row = el("div", "slider-row");
    const slider = el("input");
    slider.id = `lab-macro-${letter}`;
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.value = "50";
    const number = el("input", "slider-number");
    number.type = "number";
    number.min = "0";
    number.max = "100";
    number.step = "1";
    number.value = "50";
    row.append(slider, number);
    field.appendChild(row);
    macroRow.appendChild(field);
    const commit = (raw) => {
      const v = Math.max(0, Math.min(100, Math.round(Number(raw) || 0))) / 100;
      state.macroValues[letter] = v;
      scheduleLiveRender();
    };
    slider.addEventListener("input", () => commit(slider.value));
    number.addEventListener("change", () => commit(number.value));
    macroSliders.set(letter, { slider, number });
  }
  macrosPanel.appendChild(macroRow);
  root.appendChild(macrosPanel);

  let liveRenderTimer = null;
  function scheduleLiveRender() {
    syncMacroInputs();
    if (liveRenderTimer) clearTimeout(liveRenderTimer);
    liveRenderTimer = setTimeout(() => {
      liveRenderTimer = null;
      if (state.graph && state.audio) applyGraph(state.graph, { keepAttempts: true });
    }, 90);
  }
  function syncMacroInputs() {
    for (const [letter, { slider, number }] of macroSliders) {
      const pct = String(Math.round((state.macroValues[letter] ?? 0.5) * 100));
      if (document.activeElement !== slider) slider.value = pct;
      if (document.activeElement !== number) number.value = pct;
    }
  }

  // -------------------------------------------------------------------------
  // Inspector: a mutant is not an opaque blob - every primitive, its live params, the routing and
  // which macro touches what, plus the raw graph JSON to copy out if something's worth keeping
  // outside a browser tab.
  // -------------------------------------------------------------------------

  const inspectDetails = el("details", "lab-inspect");
  const inspectSummary = el("summary", "lab-inspect-summary", "Inspect this mutant");
  inspectDetails.appendChild(inspectSummary);
  const inspectBody = el("div", "lab-inspect-body");
  const stagesList = el("dl", "lab-inspect-stages");
  const macrosList = el("dl", "lab-inspect-macros");
  const jsonRow = el("div", "lab-inspect-json-row");
  const copyBtn = el("button", "btn btn--ghost btn--small", "Copy graph JSON");
  copyBtn.type = "button";
  const jsonArea = el("textarea", "lab-inspect-json");
  jsonArea.readOnly = true;
  jsonArea.rows = 6;
  jsonRow.append(copyBtn);
  inspectBody.append(el("h3", "lab-inspect-heading", "Primitives"), stagesList, el("h3", "lab-inspect-heading", "Macro mapping"), macrosList, jsonRow, jsonArea);
  inspectDetails.appendChild(inspectBody);
  root.appendChild(inspectDetails);

  copyBtn.addEventListener("click", () => {
    jsonArea.select();
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(jsonArea.value).catch(() => {});
    else document.execCommand("copy");
  });

  // -------------------------------------------------------------------------
  // Kept mutants
  // -------------------------------------------------------------------------

  const keptPanel = el("section", "lab-panel lab-kept");
  keptPanel.appendChild(el("h2", "lab-panel-title", "Kept"));
  const keptEmpty = el("p", "lab-empty", "Nothing kept yet - press KEEP on a mutant worth coming back to.");
  keptPanel.appendChild(keptEmpty);
  const keptList = el("div", "lab-kept-list");
  keptPanel.appendChild(keptList);
  root.appendChild(keptPanel);

  // -------------------------------------------------------------------------
  // Bottom bar: SEED, NEW, MUTATE, KEEP, EXPORT - the same "own transport bar" shape FLIP and
  // STRETCH FX use, appended into the shared footer slot rather than living inside the scrolling panel.
  // -------------------------------------------------------------------------

  const bar = el("div", "lab-bar");
  bar.hidden = true;
  const barInner = el("div", "lab-bar-inner");

  const seedField = el("div", "lab-seed-field");
  seedField.appendChild(el("span", "lab-seed-label", "SEED"));
  const seedInput = el("input", "lab-seed-input");
  seedInput.type = "number";
  seedInput.min = "0";
  seedInput.step = "1";
  seedInput.title = "A seed fully reproduces its mutant - type one in and press Load, or Enter.";
  const loadSeedBtn = el("button", "btn btn--ghost btn--small", "Load");
  loadSeedBtn.type = "button";
  seedField.append(seedInput, loadSeedBtn);

  const newBtn = el("button", "btn btn--primary lab-new", "NEW");
  newBtn.type = "button";
  newBtn.title = "A fresh processing graph, drawn from the primitive registry";
  const mutateBtn = el("button", "btn lab-mutate", "MUTATE");
  mutateBtn.type = "button";
  mutateBtn.title = "A related descendant of the current graph";
  const keepBtn = el("button", "btn btn--ghost lab-keep", "KEEP");
  keepBtn.type = "button";
  keepBtn.title = "Remember this mutant";
  const exportBtn = el("button", "btn btn--ghost btn--small", "Export WAV");
  exportBtn.type = "button";

  const barStatus = el("span", "lab-bar-status");

  const barControls = el("div", "lab-bar-controls");
  barControls.append(seedField, newBtn, mutateBtn, keepBtn);
  const barActions = el("div", "lab-bar-actions");
  barActions.append(exportBtn);
  barInner.append(barControls, barStatus, barActions);
  bar.appendChild(barInner);
  chromeContainer.appendChild(bar);

  loadSeedBtn.addEventListener("click", () => void loadSeed());
  seedInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") void loadSeed();
  });
  newBtn.addEventListener("click", () => void runNew());
  mutateBtn.addEventListener("click", () => void runMutate());
  keepBtn.addEventListener("click", () => keepCurrent());
  exportBtn.addEventListener("click", () => void exportCurrent());

  // -------------------------------------------------------------------------
  // Source loading
  // -------------------------------------------------------------------------

  async function loadFile(file) {
    generation++; // supersedes any in-flight NEW/MUTATE search - see searchAndApply()'s generation check
    stopAllPlayback();
    Object.assign(state, { file, name: file.name, audio: null, graph: null, mutant: null, error: null, status: "decoding", busy: false, busyLabel: "" });
    render();
    try {
      const { buffer } = await decodeFile(file, extOf(file.name));
      const channels = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
      if (!channels.length || !channels[0].length) throw new Error("there's no audio in that file");
      state.audio = { channels, mono: toMono(channels), sampleRate: buffer.sampleRate, duration: channels[0].length / buffer.sampleRate };
      state.status = "ready";
      log(`LAB loaded ${file.name} - ${state.audio.duration.toFixed(2)}s, ${channels.length === 1 ? "mono" : `${channels.length} ch`}, ${buffer.sampleRate} Hz.`);
      setAudition("original", { silent: true });
      player.setAudio({ mono: state.audio.mono, channels: state.audio.channels, sampleRate: state.audio.sampleRate, duration: state.audio.duration });
    } catch (err) {
      state.status = "error";
      state.error = err.message || String(err);
      logWarn(`LAB couldn't use "${file.name}": ${state.error}`);
    }
    render();
  }

  function clearSource() {
    generation++; // supersedes any in-flight NEW/MUTATE search
    stopAllPlayback();
    Object.assign(state, { file: null, name: "", audio: null, graph: null, mutant: null, status: "empty", error: null, busy: false, busyLabel: "" });
    player.setAudio(null);
    render();
  }

  // -------------------------------------------------------------------------
  // Generation - NEW / MUTATE / seed reload
  // -------------------------------------------------------------------------

  function setBusy(isBusy, label) {
    state.busy = isBusy;
    state.busyLabel = label || "";
    render();
  }

  /** NEW / MUTATE's shared search: try `nominalSeed`, and if the result is unsafe/near-silent/not
   * novel enough, keep trying seeds derived from it (deterministically) until one passes or the
   * attempt budget runs out - yielding to the UI between attempts so a long search never freezes
   * the page. The seed on the result is whichever attempt actually produced it. */
  async function searchAndApply({ nominalSeed, mode, parentGraph, actionLabel }) {
    if (!state.audio || state.busy) return;
    const myGeneration = generation;
    setBusy(true, actionLabel);
    let attemptSeed = nominalSeed;
    let last = null;
    for (let attempt = 0; attempt < MAX_SEARCH_ATTEMPTS; attempt++) {
      const graph = mode === "mutate" ? mutateGraph(parentGraph, attemptSeed) : buildGraph(attemptSeed);
      const rendered = renderMutant({ sourceChannels: state.audio.channels, sampleRate: state.audio.sampleRate, graph, macroValues: DEFAULT_MACRO_VALUES });
      last = { graph, attempts: attempt + 1, ...rendered };
      if (isAcceptable(rendered)) {
        last.gaveUp = false;
        break;
      }
      last.gaveUp = true;
      attemptSeed = deriveSeed(nominalSeed, attempt + 1);
      if (attempt % 3 === 2) await yieldToUi();
      if (generation !== myGeneration) return; // superseded (source changed / cleared while searching)
    }
    if (generation !== myGeneration) return;
    state.graph = last.graph;
    state.macroValues = { ...DEFAULT_MACRO_VALUES };
    applyRendered(last);
    setBusy(false, "");
    const tag = last.gaveUp ? ` (gave up after ${last.attempts} attempts - safety net applied)` : last.attempts > 1 ? ` (${last.attempts} attempts)` : "";
    log(`LAB ${mode === "mutate" ? "MUTATE" : "NEW"} → #${last.graph.seed}${tag}`);
  }

  async function runNew() {
    await searchAndApply({ nominalSeed: mintSeed(), mode: "new", parentGraph: null, actionLabel: "generating…" });
  }

  async function runMutate() {
    if (!state.graph) {
      await runNew();
      return;
    }
    await searchAndApply({ nominalSeed: mintSeed(), mode: "mutate", parentGraph: state.graph, actionLabel: "mutating…" });
  }

  /** An explicit seed is honoured exactly - no search, no substitution. Only the mandatory safety
   * pass (never silent, never NaN/Infinity/catastrophic peak) still runs. */
  async function loadSeed() {
    if (!state.audio) {
      logWarn("Load a loop before a seed.");
      return;
    }
    const raw = Number(seedInput.value);
    if (!Number.isFinite(raw) || raw < 0) {
      logWarn("That's not a usable seed.");
      return;
    }
    const graph = buildGraph(raw);
    state.graph = graph;
    state.macroValues = { ...DEFAULT_MACRO_VALUES };
    applyGraph(graph);
    log(`LAB loaded seed #${graph.seed}.`);
  }

  /** Re-render the CURRENT graph - used by a macro move and by recalling a kept mutant. Always the
   * exact graph given, never a search. */
  function applyGraph(graph, { keepAttempts = false } = {}) {
    if (!state.audio) return;
    const rendered = renderMutant({ sourceChannels: state.audio.channels, sampleRate: state.audio.sampleRate, graph, macroValues: state.macroValues });
    applyRendered({ graph, attempts: keepAttempts && state.mutant ? state.mutant.attempts : 1, gaveUp: keepAttempts && state.mutant ? state.mutant.gaveUp : false, ...rendered });
  }

  function applyRendered(result) {
    const mono = toMono(result.channels);
    state.mutant = {
      channels: result.channels,
      mono,
      sampleRate: state.audio.sampleRate,
      duration: state.audio.duration,
      analysis: result.analysis,
      novelty: result.novelty,
      attempts: result.attempts,
      gaveUp: result.gaveUp,
    };
    if (state.audition === "mutant") player.setAudio({ mono, channels: result.channels, sampleRate: state.audio.sampleRate, duration: state.audio.duration });
    render();
  }

  function setAudition(mode, { silent = false } = {}) {
    state.audition = mode;
    for (const [key, btn] of auditionButtons) btn.classList.toggle("is-active", key === mode);
    if (!state.audio) return;
    if (mode === "original") {
      player.setAudio({ mono: state.audio.mono, channels: state.audio.channels, sampleRate: state.audio.sampleRate, duration: state.audio.duration });
    } else if (state.mutant) {
      player.setAudio({ mono: state.mutant.mono, channels: state.mutant.channels, sampleRate: state.audio.sampleRate, duration: state.audio.duration });
    }
    if (!silent) render();
  }

  // -------------------------------------------------------------------------
  // KEEP
  // -------------------------------------------------------------------------

  function keepCurrent() {
    if (!state.graph || !state.mutant) return;
    const item = {
      id: `${state.graph.seed}-${Date.now()}`,
      seed: state.graph.seed,
      graph: state.graph,
      macroValues: { ...state.macroValues },
      sourceName: state.name,
      keptAt: Date.now(),
    };
    state.kept.unshift(item);
    if (state.kept.length > MAX_KEPT) state.kept.length = MAX_KEPT;
    save();
    render();
    logSuccess(`Kept mutant #${item.seed}.`);
  }

  function loadKept(item) {
    if (!state.audio) {
      logWarn("Load a loop before recalling a kept mutant.");
      return;
    }
    state.graph = item.graph;
    state.macroValues = { ...item.macroValues };
    applyGraph(item.graph);
    log(`LAB recalled kept mutant #${item.seed}.`);
  }

  function removeKept(id) {
    state.kept = state.kept.filter((k) => k.id !== id);
    save();
    render();
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  async function exportCurrent() {
    if (!state.mutant) {
      logWarn("Nothing to export yet - press NEW first.");
      return;
    }
    const blob = encodeWav(state.mutant.channels, state.audio.sampleRate, 24);
    const base = state.name ? state.name.replace(/\.[^.]+$/, "") : "lab";
    const filename = `${base}_LAB_${state.graph.seed}.wav`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    logSuccess(`Exported ${filename}.`);
  }

  // -------------------------------------------------------------------------
  // Persistence - the kept list only. Everything about a currently-loaded loop is session state and
  // deliberately not remembered, same as every other workspace here.
  // -------------------------------------------------------------------------

  function save() {
    writeJSON(STORAGE_KEY, { kept: state.kept });
  }

  function restore() {
    const saved = readJSON(STORAGE_KEY);
    if (saved && Array.isArray(saved.kept)) state.kept = saved.kept.slice(0, MAX_KEPT);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  function render() {
    dropzone.hidden = !!state.file;
    loaded.hidden = !state.file;
    loadedName.textContent = state.name || "";

    sourceStatus.classList.toggle("is-error", state.status === "error");
    if (state.status === "error") sourceStatus.textContent = state.error || "That file couldn't be used.";
    else if (state.status === "decoding") sourceStatus.textContent = "Decoding…";
    else if (state.audio) {
      const ch = state.audio.channels.length === 1 ? "mono" : state.audio.channels.length === 2 ? "stereo" : `${state.audio.channels.length} ch`;
      sourceStatus.textContent = `${state.audio.duration.toFixed(2)}s · ${ch} · ${state.audio.sampleRate} Hz`;
    } else sourceStatus.textContent = "";
    sourceSummary.textContent = state.audio ? (state.graph ? `mutant #${state.graph.seed}` : "no mutant yet") : "";

    const hasAudio = !!state.audio;
    playerPanel.hidden = !hasAudio;
    bar.hidden = !hasAudio;
    for (const [key, btn] of auditionButtons) btn.classList.toggle("is-active", key === state.audition);

    if (state.mutant) {
      const a = state.mutant.analysis;
      const flags = [];
      if (state.mutant.gaveUp) flags.push("safety net applied");
      if (a.extremeDc) flags.push("DC corrected");
      mutantStatus.textContent = `peak ${fmt(a.peak, 2)} · rms ${fmt(a.rms, 3)} · novelty ${fmt(state.mutant.novelty, 2)} · ${state.mutant.attempts} attempt${state.mutant.attempts === 1 ? "" : "s"}${flags.length ? ` · ${flags.join(", ")}` : ""}`;
    } else mutantStatus.textContent = hasAudio ? "Press NEW to draw the first mutant." : "";

    syncMacroInputs();
    for (const input of macrosPanel.querySelectorAll("input")) input.disabled = !state.graph;

    newBtn.disabled = !hasAudio || state.busy;
    mutateBtn.disabled = !hasAudio || state.busy || !state.graph;
    keepBtn.disabled = !state.graph || !state.mutant;
    exportBtn.disabled = !state.mutant;
    loadSeedBtn.disabled = !hasAudio || state.busy;
    barStatus.textContent = state.busy ? state.busyLabel : "";
    barStatus.classList.toggle("is-working", state.busy);
    if (document.activeElement !== seedInput && state.graph) seedInput.value = String(state.graph.seed);

    inspectDetails.hidden = !state.graph;
    if (state.graph) renderInspector();

    keptEmpty.hidden = state.kept.length > 0;
    renderKeptList();
  }

  function renderInspector() {
    const info = describeGraph(state.graph, state.macroValues);
    stagesList.innerHTML = "";
    info.stages.forEach((s) => {
      const dt = el("dt", null, s.heading);
      const dd = el("dd", null, s.body);
      stagesList.append(dt, dd);
    });
    macrosList.innerHTML = "";
    MACRO_KEYS.forEach((letter, i) => {
      const dt = el("dt", null, letter);
      const dd = el("dd", null, info.macros[i].replace(/^\w:\s*/, ""));
      macrosList.append(dt, dd);
    });
    jsonArea.value = JSON.stringify(state.graph, null, 2);
  }

  function renderKeptList() {
    keptList.innerHTML = "";
    for (const item of state.kept) {
      const card = el("article", "lab-kept-item");
      card.appendChild(el("span", "lab-kept-seed", `#${item.seed}`));
      card.appendChild(el("span", "lab-kept-meta", `${item.sourceName || "loop"} · ${new Date(item.keptAt).toLocaleString()}`));
      const actions = el("div", "lab-kept-actions");
      const loadBtn = el("button", "btn btn--ghost btn--small", "Load");
      loadBtn.type = "button";
      loadBtn.addEventListener("click", () => loadKept(item));
      const removeBtn = el("button", "btn btn--ghost btn--small", "Remove");
      removeBtn.type = "button";
      removeBtn.addEventListener("click", () => removeKept(item.id));
      actions.append(loadBtn, removeBtn);
      card.appendChild(actions);
      keptList.appendChild(card);
    }
  }

  render();

  // -------------------------------------------------------------------------
  // Public API - same shape as PLAY NICE/FLIP/STRETCH FX.
  // -------------------------------------------------------------------------

  function stopAllPlayback() {
    player.stop();
  }

  return {
    element: root,
    setActive(active) {
      bar.hidden = !active || !state.audio;
      if (!active) stopAllPlayback();
      else player.redraw();
    },
    // Kept mutants are persisted, "saved settings"-style state (see save()/restore()) - New Session
    // never destroys them, so they don't count towards "is there unsaved work to warn about".
    hasContent() {
      return !!state.audio;
    },
    reset() {
      generation++; // supersedes any in-flight NEW/MUTATE search
      stopAllPlayback();
      Object.assign(state, { file: null, name: "", audio: null, graph: null, mutant: null, status: "empty", error: null, macroValues: { ...DEFAULT_MACRO_VALUES }, audition: "mutant", busy: false, busyLabel: "" });
      player.setAudio(null);
      render();
    },
    stopAllPlayback,
  };
}
