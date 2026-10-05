// controller.js
//
// STRETCH FX: take a drum break and hand back a bank of aggressively time-stretched fragments of it -
// the CRRRRRAAAASHHH in the middle of a jungle break that snaps straight back into the groove.
//
// Not a tempo tool and not a production interface. Drop a break, press GENERATE, click down the
// cards, MUTATE the ones that are nearly there, EXPORT the ones that are. The pipeline is split into
// pure modules so every musical decision is testable in Node:
//
//   analysis.js   onsets, hits, snare scores, the bar grid     (js/dsp.js detectors, reused)
//   sources.js    which fragments are worth destroying        (snares, hits, 1/16 1/8 1/4 on the grid)
//   recipe.js     what to do to each one, as data             (archetypes x MELT x CHARACTER)
//   render.js     recipe -> audio                             (the existing stretch engine + drive/crunch)
//   snap-back.js  the result dropped back into the break
//
// This file owns SESSION STATE and the screen, the same split FLIP uses (js/flip/controller.js) and
// for the same reason: STRETCH FX works on one break, has its own settings, results and export
// destination, and shares nothing with the CHOP/STRETCH batch queue. Rendering goes through
// deps.renderFx, which app.js backs with the shared heavy-dsp worker, so eight stretches at 800%
// never freeze the page.
import { analyseBreak, gridPosition, snareTempoOctave } from "./analysis.js";
import { buildSourcePools, SOURCE_TYPES, DEFAULT_SOURCE_TYPE, resolveSourceType } from "./sources.js";
import { planBank, mutateRecipe, FLAVOURS, DEFAULT_FLAVOUR, resolveFlavour, describeMelt, heatWord, sourceTypeLabel, pitchText, reverseText, characterText, ratioPct } from "./recipe.js";
import { sliceFragment } from "./render.js";
import { renderSnapBack } from "./snap-back.js";
import { fxFileName, fxFolderName, uniqueName } from "./naming.js";
import { createFxCard } from "./fx-card.js";
import { createSourceView } from "./source-view.js";
import { makeRng } from "../dsp/stretch/rng.js";
import { toMono } from "../dsp.js";
import { encodeWav } from "../audio-codec.js";
import { sanitizeSourceBpm, resolveEffectiveTempo, formatBpmText } from "../tempo-override.js";
import { AUDIO_EXTS } from "../io-fs.js";
import { readJSON, writeJSON } from "../local-storage.js";

const STORAGE_KEY = "good-bits-stretch-fx-v1";
const DEFAULT_BATCH_SIZE = 8;
const BATCH_SIZES = [4, 8, 12, 16];
const DEFAULT_MELT = 55;

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

function fmtTime(t) {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(3).padStart(6, "0")}`;
}

function fmtSec(t) {
  return t >= 10 ? `${t.toFixed(1)}s` : `${t.toFixed(2)}s`;
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.container
 * @param {HTMLElement} deps.chromeContainer
 * @param {(file:File, ext:string) => Promise<{buffer:object}>} deps.decodeFile
 * @param {(mono:Float32Array, sampleRate:number, want:object) => Promise<object>} deps.analyze
 * @param {(job:{channels:Float32Array[], sampleRate:number, recipe:object}) => Promise<{channels:Float32Array[]}>} deps.renderFx
 * @param {() => AudioContext} deps.getAudioContext
 * @param {(name:string, fallback:string) => string} deps.color
 * @param {(msg:string) => void} deps.log
 * @param {(msg:string) => void} deps.logWarn
 * @param {(msg:string) => void} deps.logSuccess
 * @param {object} deps.io
 */
export function createStretchFx(deps) {
  const { container, chromeContainer, decodeFile, analyze, renderFx, getAudioContext, color, log, logWarn, logSuccess, io } = deps;

  const state = {
    file: null,
    name: "",
    audio: null, // {channels, mono, sampleRate, duration}
    detected: null, // {bpm}
    bpmOverride: null,
    analysisAvailable: false,
    status: "empty", // empty | decoding | analysing | ready | error
    error: null,
    analysis: null,
    pools: null,
    sourceType: DEFAULT_SOURCE_TYPE,
    flavour: DEFAULT_FLAVOUR,
    melt: DEFAULT_MELT,
    batchSize: DEFAULT_BATCH_SIZE,
    audition: "snap", // snap | solo
    bitDepth: 24,
    selection: null,
    results: [],
    exportDir: null,
    busy: false,
    progress: null,
  };
  restore();

  // Seeds make every result reproducible from (source, recipe); this is the only randomness source.
  const seedSource = makeRng((Date.now() ^ 0x2c1b3c6d) >>> 0);
  const mintSeed = () => Math.floor(seedSource.next() * 900000000) + 1000;
  let generation = 0;
  let nextId = 1;

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  const root = el("div", "sfx");
  container.appendChild(root);

  // ---- the break ----------------------------------------------------------
  const sourcePanel = el("section", "sfx-panel sfx-source");
  const sourceHead = el("div", "sfx-panel-head");
  sourceHead.appendChild(el("h2", "sfx-panel-title", "Break"));
  const sourceSummary = el("span", "sfx-summary");
  sourceHead.appendChild(sourceSummary);
  sourcePanel.appendChild(sourceHead);

  const dropzone = el("div", "sfx-dropzone");
  const dropCopy = el("div", "sfx-dropzone-copy");
  dropCopy.appendChild(el("strong", null, "Drop a drum break here"));
  dropCopy.appendChild(el("span", null, "an Amen, a Think, anything with snares in it. STRETCH FX melts bits of it into a bank of break-malfunction FX."));
  const addBtn = el("button", "btn btn--primary", "Add a break");
  addBtn.type = "button";
  dropzone.append(dropCopy, addBtn);
  sourcePanel.appendChild(dropzone);

  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = [...AUDIO_EXTS].join(",");
  fileInput.hidden = true;
  sourcePanel.appendChild(fileInput);

  const loaded = el("div", "sfx-loaded");
  loaded.hidden = true;
  const loadedHead = el("div", "sfx-loaded-head");
  const loadedName = el("span", "sfx-loaded-name");
  const loadedActions = el("div", "sfx-loaded-actions");
  const replaceBtn = el("button", "btn btn--ghost btn--small", "Replace");
  replaceBtn.type = "button";
  const clearBtn = el("button", "btn btn--ghost btn--small", "×");
  clearBtn.type = "button";
  clearBtn.title = "Remove this break and everything made from it";
  loadedActions.append(replaceBtn, clearBtn);
  loadedHead.append(loadedName, loadedActions);
  loaded.appendChild(loadedHead);
  const sourceStatus = el("p", "sfx-status");
  loaded.appendChild(sourceStatus);

  // Tempo: the grid 1/16, 1/8 and 1/4 are measured on, and what Snap Back returns on. Same
  // "analysis proposes, you correct" controls FLIP has (js/tempo-override.js).
  const tempoRow = el("div", "sfx-tempo-row");
  tempoRow.appendChild(el("span", "sfx-tempo-label", "Tempo"));
  const bpmInput = el("input", "sfx-bpm-input");
  bpmInput.type = "number";
  bpmInput.min = "20";
  bpmInput.max = "400";
  bpmInput.step = "0.01";
  bpmInput.title = "The tempo the grid is built from. Correct it if detection got it wrong.";
  const halveBtn = el("button", "btn btn--ghost btn--small", "½");
  halveBtn.type = "button";
  halveBtn.title = "Half-time - detection heard double";
  const doubleBtn = el("button", "btn btn--ghost btn--small", "×2");
  doubleBtn.type = "button";
  doubleBtn.title = "Double-time - detection heard half";
  const resetBpmBtn = el("button", "btn btn--ghost btn--small", "Reset");
  resetBpmBtn.type = "button";
  const tempoNote = el("span", "sfx-tempo-note");
  // Half-time reads are routine on jungle-tempo breaks; when the snares say so, offer the fix.
  const octaveBtn = el("button", "sfx-chip sfx-octave-chip");
  octaveBtn.type = "button";
  octaveBtn.hidden = true;
  octaveBtn.title = "The snares sit on 2 and 4 at this tempo, not at the detected one. Click to use it.";
  tempoRow.append(bpmInput, halveBtn, doubleBtn, resetBpmBtn, octaveBtn, tempoNote);
  loaded.appendChild(tempoRow);

  const sourceView = createSourceView({
    getAudioContext,
    color,
    onSelect: (sel) => {
      state.selection = sel;
      renderSelection();
    },
  });
  loaded.appendChild(sourceView.el);

  const selRow = el("div", "sfx-selection-row");
  const playBreakBtn = el("button", "btn btn--ghost btn--small", "▶ Break");
  playBreakBtn.type = "button";
  playBreakBtn.title = "Play the whole break (or click anywhere on it)";
  const playSelBtn = el("button", "btn btn--ghost btn--small", "▶ Selection");
  playSelBtn.type = "button";
  const makeBtn = el("button", "btn btn--primary btn--small sfx-make", "MAKE STRETCH FX");
  makeBtn.type = "button";
  makeBtn.title = "Generate a bank from just this region";
  const clearSelBtn = el("button", "btn btn--ghost btn--small", "Clear");
  clearSelBtn.type = "button";
  const selNote = el("span", "sfx-selection-note");
  selRow.append(playBreakBtn, playSelBtn, makeBtn, clearSelBtn, selNote);
  loaded.appendChild(selRow);
  sourceView.onPlayStateChange((playing) => {
    playBreakBtn.textContent = playing ? "■ Stop" : "▶ Break";
  });
  sourcePanel.appendChild(loaded);
  root.appendChild(sourcePanel);

  // ---- controls -----------------------------------------------------------
  const controls = el("section", "sfx-panel sfx-controls");
  const controlsHead = el("div", "sfx-panel-head");
  controlsHead.appendChild(el("h2", "sfx-panel-title", "Melt"));
  const controlsSummary = el("span", "sfx-summary");
  controlsHead.appendChild(controlsSummary);
  controls.appendChild(controlsHead);

  const chipField = (label, options, onPick) => {
    const field = el("div", "field sfx-field");
    field.appendChild(el("label", null, label));
    const chips = el("div", "sfx-chips");
    const buttons = new Map();
    for (const opt of options) {
      const chip = el("button", "sfx-chip", opt.label);
      chip.type = "button";
      chip.title = opt.hint || opt.blurb || "";
      chip.addEventListener("click", () => onPick(opt.key));
      chips.appendChild(chip);
      buttons.set(opt.key, chip);
    }
    field.appendChild(chips);
    const blurb = el("p", "mod-note sfx-blurb");
    field.appendChild(blurb);
    return { field, buttons, blurb };
  };

  const sourceField = chipField("Source", SOURCE_TYPES, (key) => {
    state.sourceType = resolveSourceType(key).key;
    save();
    render();
  });
  const flavourField = chipField("Character", FLAVOURS, (key) => {
    state.flavour = resolveFlavour(key).key;
    save();
    render();
  });

  const meltField = el("div", "field sfx-field");
  const meltLabel = el("label", null, "Melt");
  meltLabel.htmlFor = "sfx-melt";
  meltField.appendChild(meltLabel);
  const meltRow = el("div", "slider-row");
  const meltSlider = el("input");
  meltSlider.id = "sfx-melt";
  meltSlider.type = "range";
  meltSlider.min = "0";
  meltSlider.max = "100";
  meltSlider.step = "1";
  const meltNumber = el("input", "slider-number");
  meltNumber.type = "number";
  meltNumber.min = "0";
  meltNumber.max = "100";
  meltNumber.step = "1";
  const meltWord = el("span", "sfx-melt-word");
  meltRow.append(meltSlider, meltNumber, meltWord);
  meltField.appendChild(meltRow);
  meltField.appendChild(el("p", "mod-note sfx-blurb", "How hard the bank pushes. Every bank still runs from a recognisable stretched snare to something much worse - this moves the whole range."));
  const setMelt = (raw) => {
    state.melt = Math.max(0, Math.min(100, Math.round(Number(raw) || 0)));
    save();
    render();
  };
  meltSlider.addEventListener("input", () => setMelt(meltSlider.value));
  meltNumber.addEventListener("change", () => setMelt(meltNumber.value));

  controls.append(sourceField.field, flavourField.field, meltField);
  const warning = el("p", "sfx-warning");
  warning.hidden = true;
  controls.appendChild(warning);
  root.appendChild(controls);

  // ---- results ------------------------------------------------------------
  const resultsPanel = el("section", "sfx-panel sfx-results");
  const resultsHead = el("div", "sfx-panel-head");
  resultsHead.appendChild(el("h2", "sfx-panel-title", "Bank"));
  const resultsSummary = el("span", "sfx-summary");
  resultsHead.appendChild(resultsSummary);
  resultsPanel.appendChild(resultsHead);
  const emptyNote = el("p", "sfx-empty");
  resultsPanel.appendChild(emptyNote);
  const grid = el("div", "sfx-grid");
  resultsPanel.appendChild(grid);
  root.appendChild(resultsPanel);

  // ---- bottom bar ---------------------------------------------------------
  const bar = el("div", "sfx-bar");
  bar.hidden = true;
  const barInner = el("div", "sfx-bar-inner");
  const generateBtn = el("button", "sfx-generate", "GENERATE 8");
  generateBtn.type = "button";
  generateBtn.title = "Throw this bank away and melt a fresh one";
  generateBtn.addEventListener("click", () => void generateBank());
  const sizeSelect = el("select", "sfx-size-select");
  sizeSelect.title = "How many results per bank";
  for (const n of BATCH_SIZES) {
    const opt = el("option", null, `${n} at a time`);
    opt.value = String(n);
    sizeSelect.appendChild(opt);
  }
  sizeSelect.addEventListener("change", () => {
    state.batchSize = Number(sizeSelect.value) || DEFAULT_BATCH_SIZE;
    save();
    render();
  });

  const auditionSeg = el("div", "seg sfx-audition-seg");
  auditionSeg.setAttribute("role", "group");
  auditionSeg.setAttribute("aria-label", "Audition mode");
  const auditionButtons = new Map();
  for (const [key, label, title] of [
    ["solo", "Solo", "Hear just the stretched sample"],
    ["snap", "Snap back", "Hear it inside the break: break → stretch → straight back in on the beat"],
  ]) {
    const btn = el("button", "seg-btn", label);
    btn.type = "button";
    btn.title = title;
    btn.addEventListener("click", () => setAudition(key));
    auditionSeg.appendChild(btn);
    auditionButtons.set(key, btn);
  }

  const depthSelect = el("select", "sfx-depth-select");
  depthSelect.title = "Export bit depth";
  for (const depth of [24, 16]) {
    const opt = el("option", null, `${depth}-bit`);
    opt.value = String(depth);
    depthSelect.appendChild(opt);
  }
  depthSelect.addEventListener("change", () => {
    state.bitDepth = Number(depthSelect.value) || 24;
    save();
  });
  const exportAllBtn = el("button", "btn btn--small", "Export all");
  exportAllBtn.type = "button";
  exportAllBtn.title = "Write every result in this bank";
  exportAllBtn.addEventListener("click", () => void exportAll());
  const status = el("span", "sfx-bar-status");

  const barControls = el("div", "sfx-bar-controls");
  barControls.append(generateBtn, sizeSelect, auditionSeg);
  const barActions = el("div", "sfx-bar-actions");
  barActions.append(depthSelect, exportAllBtn);
  barInner.append(barControls, status, barActions);
  bar.appendChild(barInner);
  chromeContainer.appendChild(bar);

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  function save() {
    writeJSON(STORAGE_KEY, {
      sourceType: state.sourceType,
      flavour: state.flavour,
      melt: state.melt,
      batchSize: state.batchSize,
      audition: state.audition,
      bitDepth: state.bitDepth,
    });
  }

  function restore() {
    const saved = readJSON(STORAGE_KEY);
    if (!saved) return;
    if (saved.sourceType) state.sourceType = resolveSourceType(saved.sourceType).key;
    if (saved.flavour) state.flavour = resolveFlavour(saved.flavour).key;
    if (Number.isFinite(saved.melt)) state.melt = Math.max(0, Math.min(100, Math.round(saved.melt)));
    if (BATCH_SIZES.includes(saved.batchSize)) state.batchSize = saved.batchSize;
    if (saved.audition === "solo" || saved.audition === "snap") state.audition = saved.audition;
    if (saved.bitDepth === 16 || saved.bitDepth === 24) state.bitDepth = saved.bitDepth;
  }

  function setAudition(mode) {
    state.audition = mode;
    for (const r of state.results) r.card.setMode(mode);
    save();
    render();
  }

  // -------------------------------------------------------------------------
  // Source
  // -------------------------------------------------------------------------

  addBtn.addEventListener("click", () => void pickFile());
  replaceBtn.addEventListener("click", () => void pickFile());
  clearBtn.addEventListener("click", () => clearSource());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (file) void loadFile(file);
  });

  async function pickFile() {
    if (io.supportsFSA) {
      try {
        const handles = await io.pickFiles({ multiple: false });
        if (!handles || !handles.length) return;
        const files = await Promise.all(handles.map((h) => h.getFile()));
        if (files.length) void loadFile(files[0]);
        return;
      } catch (err) {
        logWarn(`File picker failed: ${err.message || err}`);
        return;
      }
    }
    fileInput.click();
  }

  wireDropZone(root, (files) => {
    const audio = files.filter((f) => AUDIO_EXTS.has(extOf(f.name)));
    if (!audio.length) {
      logWarn("STRETCH FX takes one audio break - that wasn't audio.");
      return;
    }
    if (audio.length > 1) log(`STRETCH FX works on one break at a time - using "${audio[0].name}".`);
    void loadFile(audio[0]);
  });

  async function loadFile(file) {
    // Supersede any bank still rendering - its loop sees the new generation and stops - and drop its
    // busy state here, since that loop returns without getting the chance to.
    generation++;
    state.busy = false;
    state.progress = null;
    clearResults();
    stopAllPlayback();
    Object.assign(state, { file, name: file.name, audio: null, detected: null, bpmOverride: null, octaveSuggestion: null, analysisAvailable: false, analysis: null, pools: null, selection: null, error: null, status: "decoding" });
    sourceView.setAudio(null);
    render();
    try {
      const { buffer } = await decodeFile(file, extOf(file.name));
      const channels = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
      if (!channels.length || !channels[0].length) throw new Error("there's no audio in that file");
      state.audio = { channels, mono: toMono(channels), sampleRate: buffer.sampleRate, duration: channels[0].length / buffer.sampleRate };
      sourceView.setAudio(state.audio);
      log(`STRETCH FX loaded ${file.name} - ${state.audio.duration.toFixed(2)}s, ${channels.length === 1 ? "mono" : `${channels.length} ch`}, ${buffer.sampleRate} Hz.`);
      state.status = "analysing";
      render();
      await yieldToUi();
      // The app's shared tempo detector - STRETCH FX doesn't have its own.
      const result = await analyze(state.audio.mono, state.audio.sampleRate, { key: false, tempo: true });
      state.detected = { bpm: result.bpm ?? null };
      state.analysisAvailable = !!result.available;
      reanalyse();
      state.status = "ready";
      const g = state.analysis.grid;
      if (state.octaveSuggestion) log(`  the snares sit on the backbeat at ${Math.round(state.octaveSuggestion)} BPM - the button next to the tempo switches to it.`);
      log(
        `  ${file.name}: ${state.detected.bpm ? `${Math.round(state.detected.bpm)} BPM` : state.analysisAvailable ? "no confident tempo" : "tempo detection unavailable"}, ` +
          `${state.analysis.hits.length} hits, ${state.pools.snare.length} snare candidates${g.assumed ? "" : `, ${g.loopBars} bar${g.loopBars === 1 ? "" : "s"}`}.`
      );
    } catch (err) {
      state.status = "error";
      state.error = err.message || String(err);
      logWarn(`STRETCH FX couldn't use "${file.name}": ${state.error}`);
    }
    render();
  }

  /** Analysis depends on the tempo (the grid), so it reruns whenever the tempo is corrected. */
  function reanalyse() {
    if (!state.audio) return;
    const bpm = effectiveBpm();
    state.analysis = analyseBreak({ mono: state.audio.mono, sampleRate: state.audio.sampleRate, bpm });
    const suggested = bpm ? snareTempoOctave(state.analysis.hits, bpm) : bpm;
    state.octaveSuggestion = suggested && Math.abs(suggested - bpm) > 0.5 ? suggested : null;
    state.pools = buildSourcePools(state.analysis, state.audio.mono, state.audio.sampleRate);
    sourceView.setAnalysis(state.analysis);
    // Existing results keep their audio, but their Snap Back context is measured on the grid.
    for (const r of state.results) if (r.fx) r.snap = buildSnap(r);
    for (const r of state.results) if (r.fx) r.card.setAudio(r.fx, r.snap);
  }

  function clearSource() {
    generation++;
    state.busy = false;
    state.progress = null;
    stopAllPlayback();
    clearResults();
    Object.assign(state, { file: null, name: "", audio: null, detected: null, bpmOverride: null, octaveSuggestion: null, analysis: null, pools: null, selection: null, status: "empty", error: null });
    sourceView.setAudio(null);
    render();
  }

  function effectiveBpm() {
    return resolveEffectiveTempo(state.bpmOverride, state.detected && state.detected.bpm);
  }

  bpmInput.addEventListener("change", () => {
    const sanitized = sanitizeSourceBpm(bpmInput.value);
    if (sanitized == null) {
      render();
      return;
    }
    state.bpmOverride = sanitized;
    reanalyse();
    render();
  });
  halveBtn.addEventListener("click", () => nudgeTempo(0.5));
  doubleBtn.addEventListener("click", () => nudgeTempo(2));
  octaveBtn.addEventListener("click", () => {
    if (!state.octaveSuggestion) return;
    state.bpmOverride = sanitizeSourceBpm(state.octaveSuggestion);
    reanalyse();
    render();
  });
  resetBpmBtn.addEventListener("click", () => {
    state.bpmOverride = null;
    reanalyse();
    render();
  });
  function nudgeTempo(factor) {
    const current = effectiveBpm();
    if (current == null) return;
    const sanitized = sanitizeSourceBpm(current * factor);
    if (sanitized == null) return;
    state.bpmOverride = sanitized;
    reanalyse();
    render();
  }

  playBreakBtn.addEventListener("click", () => sourceView.play());
  playSelBtn.addEventListener("click", () => sourceView.play({ selectionOnly: true }));
  clearSelBtn.addEventListener("click", () => {
    state.selection = null;
    sourceView.clearSelection();
    renderSelection();
  });
  makeBtn.addEventListener("click", () => {
    if (state.selection) void generateBank({ manual: state.selection });
  });

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  function stopAllPlayback() {
    sourceView.stop();
    for (const r of state.results) r.card.stop();
  }

  function clearResults() {
    for (const r of state.results) r.card.destroy();
    state.results.length = 0;
    sourceView.setMarkers([]);
  }

  async function generateBank({ manual = null } = {}) {
    if (state.busy || !state.audio || !state.pools) return;
    const myGeneration = ++generation;
    state.busy = true;
    stopAllPlayback();
    clearResults();
    render();

    const rng = makeRng(mintSeed());
    const recipes = planBank({
      pools: state.pools,
      grid: state.analysis.grid,
      count: state.batchSize,
      melt: state.melt / 100,
      flavour: state.flavour,
      sourceType: state.sourceType,
      manual,
      rng,
      mintSeed,
    });
    if (!recipes.length) {
      state.busy = false;
      logWarn("Couldn't find anything in this break to stretch - is it silent?");
      render();
      return;
    }
    log(
      `STRETCH FX melting ${recipes.length} from ${manual ? `your selection (${fmtSec(manual.end - manual.start)})` : `${resolveSourceType(state.sourceType).label.toLowerCase()} sources`} - ` +
        `${resolveFlavour(state.flavour).label.toLowerCase()} character, melt ${state.melt} (${describeMelt(state.melt)}).`
    );

    // Cards go up immediately, in bank order, and fill in as each render lands.
    recipes.forEach((recipe, i) => {
      const result = makeResult(recipe, i + 1);
      state.results.push(result);
      grid.appendChild(result.card.el);
    });
    updateMarkers();
    render();

    let failed = 0;
    for (let i = 0; i < state.results.length; i++) {
      if (myGeneration !== generation) return; // superseded by a newer bank or a new source
      state.progress = `melting ${i + 1}/${state.results.length}`;
      renderBar();
      const ok = await renderResult(state.results[i], myGeneration);
      if (!ok) failed++;
    }
    if (myGeneration !== generation) return;
    state.progress = null;
    state.busy = false;
    render();
    logSuccess(`STRETCH FX made ${state.results.length - failed} result${state.results.length - failed === 1 ? "" : "s"}.`);
    if (failed) logWarn(`${failed} couldn't be rendered.`);
  }

  function makeResult(recipe, index) {
    const result = { id: nextId++, index, recipe, fx: null, snap: null, card: null };
    result.card = createFxCard({
      id: String(index).padStart(2, "0"),
      getAudioContext,
      color,
      onMutate: () => void mutate(result),
      onExport: () => exportOne(result),
      onPlayStateChange: () => updateMarkers(),
    });
    result.card.setMode(state.audition);
    fillCardInfo(result);
    return result;
  }

  function fillCardInfo(result) {
    const r = result.recipe;
    const g = state.analysis && state.analysis.grid;
    const pos = g && !g.assumed ? gridPosition(g, r.source.start) : null;
    const frag = r.source.end - r.source.start;
    result.card.setInfo({
      id: String(result.index).padStart(2, "0"),
      type: sourceTypeLabel(r.source),
      name: r.name,
      heat: heatWord(r.heat),
      source: `${pos ? `bar ${pos.text} · ` : ""}${fmtTime(r.source.start)}${r.source.note ? ` · ${r.source.note}` : ""}`,
      fragment: fmtSec(frag),
      stretch: `${ratioPct(r.totalRatio)}% → ${fmtSec(result.fx ? result.fx.duration : frag * r.totalRatio)}`,
      pitch: pitchText(r.pitch),
      reverse: reverseText(r.reverse),
      character: characterText(r),
    });
    result.card.setHeatLevel(Math.min(4, Math.floor(r.heat * 5)));
  }

  /** Render one result's audio through the worker, then build its Snap Back context. */
  async function renderResult(result, myGeneration) {
    result.card.setBusy(true);
    const recipe = result.recipe;
    try {
      const fragment = sliceFragment(state.audio.channels, state.audio.sampleRate, recipe.source.start, recipe.source.end);
      const rendered = await renderFx({ channels: fragment, sampleRate: state.audio.sampleRate, recipe });
      if (myGeneration != null && myGeneration !== generation) return false;
      if (result.recipe !== recipe) return false; // mutated again while this was in flight
      const channels = rendered.channels;
      // Drawn from the left channel rather than a fresh downmix: a card waveform doesn't need one, and
      // at sixteen results a second copy of every buffer is memory for nothing.
      result.fx = { channels, mono: channels[0], sampleRate: state.audio.sampleRate, duration: channels[0].length / state.audio.sampleRate };
      result.snap = buildSnap(result);
      result.card.setAudio(result.fx, result.snap);
      result.card.setBusy(false);
      fillCardInfo(result);
      return true;
    } catch (err) {
      result.card.setError(`couldn't render: ${err.message || err}`);
      logWarn(`STRETCH FX ${String(result.index).padStart(2, "0")} failed: ${err.message || err}`);
      return false;
    }
  }

  function buildSnap(result) {
    const s = renderSnapBack({
      channels: state.audio.channels,
      sampleRate: state.audio.sampleRate,
      grid: state.analysis.grid,
      source: result.recipe.source,
      fx: result.fx.channels,
    });
    return { ...s, mono: s.channels[0] };
  }

  /** Same fragment, some processing nudged - then play it straight away, since hearing it is the point. */
  async function mutate(result) {
    if (!state.audio) return;
    const seed = mintSeed();
    result.card.stop();
    result.recipe = mutateRecipe(result.recipe, makeRng(seed), seed);
    fillCardInfo(result);
    const ok = await renderResult(result, null);
    if (ok) {
      log(`  ${String(result.index).padStart(2, "0")} mutated: ${ratioPct(result.recipe.totalRatio)}%, ${pitchText(result.recipe.pitch)}, ${reverseText(result.recipe.reverse)}, ${characterText(result.recipe)}.`);
      result.card.play();
    }
  }

  function updateMarkers() {
    sourceView.setMarkers(
      state.results.map((r) => ({
        start: r.recipe.source.start,
        end: r.recipe.source.end,
        label: String(r.index).padStart(2, "0"),
        active: r.card.isPlaying(),
      }))
    );
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  function encode(result) {
    return encodeWav(result.fx.channels, result.fx.sampleRate, state.bitDepth);
  }

  // Names already handed out this session, so two single exports of different results that would
  // share a name (same source type, amount and treatment) come down as _2 rather than a duplicate.
  const exportedNames = new Set();

  function exportOne(result) {
    if (!result.fx) return;
    const name = uniqueName(fxFileName(state.name, result.recipe), exportedNames);
    downloadBlob(encode(result), name);
    logSuccess(`Exported ${name}`);
  }

  async function exportAll() {
    if (state.busy) return;
    const ready = state.results.filter((r) => r.fx);
    if (!ready.length) {
      logWarn("Nothing generated yet.");
      return;
    }
    const folder = fxFolderName(state.name);
    let dirHandle = null;
    if (io.supportsFSA) {
      dirHandle = state.exportDir;
      if (!dirHandle) {
        dirHandle = await io.pickFolder();
        if (!dirHandle) return;
        if (!(await io.ensurePermission(dirHandle))) {
          logWarn("No write permission for that folder, so nothing was exported.");
          return;
        }
        state.exportDir = dirHandle;
      }
    }

    state.busy = true;
    render();
    // Never overwrite: every name already in the destination folder is treated as taken, so a second
    // Export All of a new bank lands next to the first one instead of on top of it.
    const taken = new Set();
    if (dirHandle) {
      try {
        const sub = await dirHandle.getDirectoryHandle(folder, { create: true });
        for await (const [entryName] of sub.entries()) taken.add(entryName);
      } catch (_) {
        /* can't list it - the write below will create it */
      }
    }
    const zip = dirHandle ? null : new io.ZipBatch();
    let written = 0;
    let failed = 0;
    for (let i = 0; i < ready.length; i++) {
      state.progress = `exporting ${i + 1}/${ready.length}`;
      renderBar();
      const name = uniqueName(fxFileName(state.name, ready[i].recipe), taken);
      try {
        const blob = encode(ready[i]);
        if (dirHandle) await io.writeFile(dirHandle, folder, "", name, blob);
        else zip.addFile(folder, "", "", name, blob);
        written++;
      } catch (err) {
        failed++;
        logWarn(`Couldn't write "${name}": ${err.message || err}`);
      }
      await yieldToUi();
    }
    state.progress = null;
    if (zip && written > 0) await zip.downloadAs(`${folder}.zip`);
    state.busy = false;
    render();
    if (written) logSuccess(`Exported ${written} STRETCH FX to ${dirHandle ? `${folder}/` : `${folder}.zip`}.`);
    if (failed) logWarn(`${failed} couldn't be exported.`);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  function renderSelection() {
    const sel = state.selection;
    const has = !!sel && !!state.audio;
    makeBtn.disabled = !has || state.busy;
    playSelBtn.disabled = !has;
    clearSelBtn.disabled = !has;
    if (!has) {
      selNote.textContent = state.audio ? "Drag across the break to pick your own region. Click to listen from there." : "";
      return;
    }
    const g = state.analysis && state.analysis.grid;
    const len = sel.end - sel.start;
    const beats = g && !g.assumed ? len / g.beat : null;
    selNote.textContent = `${fmtTime(sel.start)} – ${fmtTime(sel.end)} · ${fmtSec(len)}${beats ? ` · ${beats < 1 ? `1/${Math.max(1, Math.round(4 / beats))} note-ish` : `${beats.toFixed(beats < 4 ? 2 : 1)} beats`}` : ""}`;
  }

  function render() {
    const hasSource = !!state.audio;
    dropzone.hidden = !!state.file;
    loaded.hidden = !state.file;
    loadedName.textContent = state.name || "";

    sourceStatus.classList.toggle("is-error", state.status === "error");
    if (state.status === "error") sourceStatus.textContent = state.error || "That file couldn't be used.";
    else if (state.status === "decoding") sourceStatus.textContent = "Decoding…";
    else if (state.status === "analysing") sourceStatus.textContent = "Finding the hits and the tempo…";
    else if (hasSource) {
      const ch = state.audio.channels.length === 1 ? "mono" : state.audio.channels.length === 2 ? "stereo" : `${state.audio.channels.length} ch`;
      sourceStatus.textContent = `${state.audio.duration.toFixed(2)}s · ${ch} · ${state.audio.sampleRate} Hz`;
    } else sourceStatus.textContent = "";

    tempoRow.hidden = !hasSource;
    sourceView.el.hidden = !hasSource;
    selRow.hidden = !hasSource || state.status !== "ready";
    const bpm = effectiveBpm();
    if (document.activeElement !== bpmInput) bpmInput.value = bpm != null ? String(Math.round(bpm * 100) / 100) : "";
    tempoNote.textContent = formatBpmText(bpm, state.bpmOverride != null, state.analysisAvailable);
    resetBpmBtn.disabled = state.bpmOverride == null;
    halveBtn.disabled = doubleBtn.disabled = bpm == null;
    octaveBtn.hidden = !state.octaveSuggestion;
    if (state.octaveSuggestion) octaveBtn.textContent = `snares say ${Math.round(state.octaveSuggestion)} →`;

    const a = state.analysis;
    if (a && hasSource) {
      const g = a.grid;
      sourceSummary.textContent = `${a.hits.length} hits · ${state.pools.snare.length} snares${g.assumed ? "" : ` · ${g.loopBars || "<1"} bar${g.loopBars === 1 ? "" : "s"}`}`;
    } else sourceSummary.textContent = "";

    for (const [key, chip] of sourceField.buttons) chip.classList.toggle("is-active", key === state.sourceType);
    sourceField.blurb.textContent = resolveSourceType(state.sourceType).hint;
    for (const [key, chip] of flavourField.buttons) chip.classList.toggle("is-active", key === state.flavour);
    flavourField.blurb.textContent = resolveFlavour(state.flavour).blurb;
    if (document.activeElement !== meltSlider) meltSlider.value = String(state.melt);
    if (document.activeElement !== meltNumber) meltNumber.value = String(state.melt);
    meltWord.textContent = describeMelt(state.melt);
    controlsSummary.textContent = `${resolveSourceType(state.sourceType).label} · ${resolveFlavour(state.flavour).label} · ${describeMelt(state.melt)}`;

    // The grid source types are only as good as the tempo under them - say so when it's a guess.
    let warn = null;
    if (a && a.grid.assumed && ["1/16", "1/8", "1/4", "auto"].includes(state.sourceType)) {
      warn = `No tempo, so the grid (and Snap Back's return point) assumes ${Math.round(a.grid.bpm)} BPM. Type the real tempo above for musically aligned fragments.`;
    } else if (a && state.sourceType === "snare" && !state.pools.snare.length) warn = "No snare-like hits found - SNARE will fall back to other hits.";
    warning.hidden = !warn;
    warning.textContent = warn || "";

    emptyNote.hidden = state.results.length > 0;
    emptyNote.textContent = hasSource ? "Nothing melted yet - press GENERATE, or drag a region on the break and MAKE STRETCH FX." : "Load a break above, then press GENERATE.";
    const ready = state.results.filter((r) => r.fx).length;
    resultsSummary.textContent = state.results.length ? `${ready}/${state.results.length} ready · ${state.audition === "snap" ? "snap back" : "solo"}` : "";

    renderSelection();
    sizeSelect.value = String(state.batchSize);
    depthSelect.value = String(state.bitDepth);
    for (const [key, btn] of auditionButtons) btn.classList.toggle("is-active", key === state.audition);
    renderBar();
  }

  function renderBar() {
    generateBtn.textContent = `GENERATE ${state.batchSize}`;
    generateBtn.disabled = !state.audio || !state.pools || state.busy;
    exportAllBtn.disabled = state.busy || !state.results.some((r) => r.fx);
    sizeSelect.disabled = state.busy;
    makeBtn.disabled = !state.selection || state.busy;
    status.textContent = state.progress || (state.busy ? "working…" : "");
    status.classList.toggle("is-working", !!state.progress);
  }

  render();

  return {
    element: root,
    setActive(active) {
      bar.hidden = !active;
      if (!active) stopAllPlayback();
      else
        requestAnimationFrame(() => {
          sourceView.redraw();
          for (const r of state.results) r.card.redraw();
        });
    },
    stopAllPlayback,
    hasContent() {
      return !!state.file || state.results.length > 0;
    },
    reset() {
      clearSource();
      state.exportDir = null;
      state.busy = false;
      state.progress = null;
      render();
    },
    redraw() {
      sourceView.redraw();
      for (const r of state.results) r.card.redraw();
    },
  };
}

/** Drop onto the whole STRETCH FX workspace - one break, anywhere. Same shape as FLIP's. */
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
