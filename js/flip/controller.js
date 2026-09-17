// controller.js
//
// FLIP: give me this loop back, but wrong.
//
// Drop in one musically coherent loop; FLIP proposes alternative interpretations of it. Not a
// slicer, not a pad instrument, not a sequencer - the user supplies the musical intent and this
// supplies the accidents. Every control on screen exists because it changes the CHARACTER of what
// gets proposed; anything that would only let you specify an individual edit was deliberately left
// out, because specifying edits is what a DAW is for.
//
// PIPELINE, in four separable stages, each its own module:
//
//   analyse source   js/essentia-bridge.js (shared with the rest of the app - FLIP does not have
//                    its own tempo detector) + a manual correction, exactly as STRETCH does it
//   slice map        js/flip/slice-map.js      where the cuts are, and what each one means musically
//   recipe           js/flip/recipe.js + operations.js + styles.js   what to do, as instructions
//   render           js/flip/render.js         instructions -> samples, once, into exact-length buffers
//
// This file owns none of that. It owns SESSION STATE and the screen: what's loaded, what's been
// generated, what's playing, what's stale, and what gets written when you press Export.
//
// WHY ITS OWN STATE, like PLAY NICE and unlike STRETCH: FLIP works on one loop, not on the shared
// source queue, and it has its own settings, its own results and its own export destination. Adding
// a dozen more module-level variables to js/app.js to describe a workflow that shares nothing with
// the batch pipeline would put CHOP/STRETCH/BOTH at risk for no benefit.
//
// EIGHT RENDERED VARIATIONS, NOT EIGHT LAZY ONES. Rendering a recipe is array copying - a four-bar
// loop takes single-digit milliseconds - so the whole batch is rendered up front and held as plain
// Float32Arrays. Auditioning is then instant and identical to export, there is no "render on first
// play" stall in the middle of clicking down the list, and the export path has nothing to re-derive.
// Generating a new batch destroys the previous one's players and drops its buffers first.
import { createSliceMap, sliceMapReadiness, describeSliceMap, SUBDIVISIONS, DEFAULT_SUBDIVISION, resolveSubdivision, MIN_SLICES } from "./slice-map.js";
import { generateRecipe, describeRecipe, recipePattern, recipeDeparture } from "./recipe.js";
import { renderVariationAudio } from "./render.js";
import { STYLES, DEFAULT_STYLE, resolveStyle, describeIntensity, describeStructure, describeActivity, describeDepth } from "./styles.js";
import { PITCH_MODES, DEFAULT_PITCH_MODE, resolvePitchMode, resolveKey, NOTE_NAMES, formatKey } from "./pitch-plan.js";
import { profilesForBatch } from "./diversity.js";
import { PRESETS, DEFAULT_SETTINGS, matchPreset } from "./presets.js";
import { variationFileName, batchFolderName, uniqueName } from "./naming.js";
import { createVariationRow } from "./variation-row.js";
import { makeRng } from "../dsp/stretch/rng.js";
import { toMono } from "../dsp.js";
import { encodeWav } from "../audio-codec.js";
import { sanitizeSourceBpm, resolveEffectiveTempo, formatBpmText } from "../tempo-override.js";
import { AUDIO_EXTS } from "../io-fs.js";
import { readJSON, writeJSON } from "../local-storage.js";

const STORAGE_KEY = "good-bits-flip-v1";
const DEFAULT_BATCH_SIZE = 8;
const BATCH_SIZES = [4, 8, 12, 16];
const DEFAULT_BIT_DEPTH = 24;

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

/**
 * @param {object} deps
 * @param {HTMLElement} deps.container
 * @param {HTMLElement} deps.chromeContainer   where the fixed bottom bar mounts (the app shell)
 * @param {(file:File, ext:string) => Promise<{buffer:object}>} deps.decodeFile
 * @param {(mono:Float32Array, sampleRate:number, want:object) => Promise<object>} deps.analyze
 * @param {() => AudioContext} deps.getAudioContext
 * @param {(name:string, fallback:string) => string} deps.color
 * @param {(msg:string) => void} deps.log
 * @param {(msg:string) => void} deps.logWarn
 * @param {(msg:string) => void} deps.logSuccess
 * @param {object} deps.io  {supportsFSA, pickFiles, pickFolder, ensurePermission, writeFile, ZipBatch}
 */
export function createFlip(deps) {
  const { container, chromeContainer, decodeFile, analyze, getAudioContext, color, log, logWarn, logSuccess, io } = deps;

  const state = {
    file: null,
    name: "",
    audio: null, // {channels, mono, sampleRate, duration}
    detected: null, // {bpm, key, scale}
    bpmOverride: null,
    analysisAvailable: false,
    status: "empty", // empty | decoding | analysing | ready | error
    error: null,
    subdivision: DEFAULT_SUBDIVISION,
    ...DEFAULT_SETTINGS,
    // THREE controls, not one. See js/flip/recipe.js for what each actually does; the short version
    // is that a single "intensity" conflated "how much of the loop is touched" with "how far each
    // edit goes" with "is the large-scale shape allowed to change", and those are three different
    // musical intentions that people want in different combinations. Structure 85 / Activity 25 /
    // Depth 75 - recognisably the original, mostly left alone, but occasionally does something
    // dramatic - is not expressible with one slider at all.
    //
    // The opening values live in js/flip/presets.js alongside the eight one-click starting points,
    // so "what FLIP opens on" and "what the presets offer" can't drift apart.
    // Which preset is showing as active. Tracked explicitly rather than inferred by comparing every
    // field, because a preset's chop size can be coerced finer on a short loop (see coerceChopSize)
    // - and a chip that refuses to light up when you just clicked it reads as a broken button.
    presetKey: null,
    // Manual key correction, same "analysis proposes, user overrides" split as the tempo above it.
    keyRoot: null,
    keyMode: null,
    batchSize: DEFAULT_BATCH_SIZE,
    bitDepth: DEFAULT_BIT_DEPTH,
    looping: true,
    variations: [],
    exportDir: null,
    busy: false,
    progress: null,
  };

  restore();

  // The ONLY non-deterministic thing in FLIP. Seeds have to come from somewhere, and once minted
  // every downstream decision is a pure function of (source, settings, seed) - so a variation is
  // reproducible forever from the number printed on its row and in its filename. Deliberately not
  // scattered Math.random() calls inside the remix algorithms, which would make a result that
  // sounded good impossible to get back.
  const seedSource = makeRng((Date.now() ^ 0x5f3759df) >>> 0);
  function mintSeed() {
    return Math.floor(seedSource.next() * 900000000) + 1000;
  }

  let generation = 0; // bumped whenever a batch is superseded, so an in-flight one can bail
  let nextRowId = 1;

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  const root = el("div", "flip");
  container.appendChild(root);

  // ---- source ------------------------------------------------------------

  const sourcePanel = el("section", "flip-panel flip-source");
  const sourceHead = el("div", "flip-panel-head");
  sourceHead.appendChild(el("h2", "flip-panel-title", "Loop"));
  const sourceSummary = el("span", "flip-source-summary");
  sourceHead.appendChild(sourceSummary);
  sourcePanel.appendChild(sourceHead);

  const dropzone = el("div", "flip-dropzone");
  const dropCopy = el("div", "flip-dropzone-copy");
  dropCopy.appendChild(el("strong", null, "Drop a loop here"));
  dropCopy.appendChild(el("span", null, "one musical loop - a bar, two bars, four bars. FLIP gives it back to you wrong."));
  const dropActions = el("div", "flip-dropzone-actions");
  const addBtn = el("button", "btn btn--primary", "Add a loop");
  addBtn.type = "button";
  const replaceBtn = el("button", "btn btn--ghost btn--small", "Replace");
  replaceBtn.type = "button";
  dropActions.appendChild(addBtn);
  dropzone.append(dropCopy, dropActions);
  sourcePanel.appendChild(dropzone);

  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = [...AUDIO_EXTS].join(",");
  fileInput.hidden = true;
  sourcePanel.appendChild(fileInput);

  const loaded = el("div", "flip-loaded");
  loaded.hidden = true;
  const loadedHead = el("div", "flip-loaded-head");
  const loadedName = el("span", "flip-loaded-name");
  const loadedActions = el("div", "flip-loaded-actions");
  loadedActions.appendChild(replaceBtn);
  const clearBtn = el("button", "btn btn--ghost btn--small", "×");
  clearBtn.type = "button";
  clearBtn.title = "Remove this loop and everything generated from it";
  loadedActions.appendChild(clearBtn);
  loadedHead.append(loadedName, loadedActions);
  loaded.appendChild(loadedHead);

  const sourceStatus = el("p", "flip-source-status");
  loaded.appendChild(sourceStatus);

  // Tempo correction - the same ANALYSIS PROPOSES, USER OVERRIDES split the rest of the app uses
  // (js/tempo-override.js). It matters more here than anywhere else: the tempo IS the slice grid,
  // so a half-time detection doesn't just mislabel the file, it halves the resolution of every
  // variation you generate from it.
  const tempoRow = el("div", "flip-tempo-row");
  tempoRow.appendChild(el("span", "flip-tempo-label", "Tempo"));
  const bpmInput = el("input", "flip-bpm-input");
  bpmInput.type = "number";
  bpmInput.min = "20";
  bpmInput.max = "400";
  bpmInput.step = "0.01";
  bpmInput.title = "The tempo the slice grid is built from. Correct it if detection got it wrong.";
  const halveBtn = el("button", "btn btn--ghost btn--small", "½");
  halveBtn.type = "button";
  halveBtn.title = "Half-time - detection heard double";
  const doubleBtn = el("button", "btn btn--ghost btn--small", "×2");
  doubleBtn.type = "button";
  doubleBtn.title = "Double-time - detection heard half";
  const resetBpmBtn = el("button", "btn btn--ghost btn--small", "Reset");
  resetBpmBtn.type = "button";
  resetBpmBtn.title = "Back to what was detected";
  const tempoNote = el("span", "flip-tempo-note");
  tempoRow.append(bpmInput, halveBtn, doubleBtn, resetBpmBtn, tempoNote);
  loaded.appendChild(tempoRow);

  // Key sits with the loop rather than with the pitch controls, for the same reason tempo does:
  // it's a fact about the source, not a setting. Detection proposes; these override. Nothing here
  // is a music-theory interface - a root and a mode is all the pitch planner needs.
  const keyRow = el("div", "flip-tempo-row");
  keyRow.appendChild(el("span", "flip-tempo-label", "Key"));
  const keyRootSelect = el("select", "flip-key-select");
  const anyOpt = el("option", null, "—");
  anyOpt.value = "";
  keyRootSelect.appendChild(anyOpt);
  for (const note of NOTE_NAMES) {
    const opt = el("option", null, note);
    opt.value = note;
    keyRootSelect.appendChild(opt);
  }
  const keyModeSelect = el("select", "flip-key-select");
  for (const mode of ["minor", "major"]) {
    const opt = el("option", null, mode);
    opt.value = mode;
    keyModeSelect.appendChild(opt);
  }
  const keyNote = el("span", "flip-tempo-note");
  const onKeyChange = () => {
    state.keyRoot = keyRootSelect.value || null;
    state.keyMode = keyModeSelect.value || null;
    save();
    markStale();
    render();
  };
  keyRootSelect.addEventListener("change", onKeyChange);
  keyModeSelect.addEventListener("change", onKeyChange);
  keyRow.append(keyRootSelect, keyModeSelect, keyNote);
  loaded.appendChild(keyRow);
  sourcePanel.appendChild(loaded);
  root.appendChild(sourcePanel);

  // ---- controls ----------------------------------------------------------

  /** One labelled slider with a live word next to it - there are five of these now. */
  function makeSlider({ id, label, hint, value, describe, onChange }) {
    const field = el("div", "field flip-field");
    const labelEl = el("label", null, label);
    labelEl.htmlFor = id;
    field.appendChild(labelEl);
    const row = el("div", "slider-row");
    const slider = el("input");
    slider.id = id;
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.value = String(value);
    const number = el("input", "slider-number");
    number.type = "number";
    number.min = "0";
    number.max = "100";
    number.step = "1";
    number.value = String(value);
    const word = el("span", "flip-slider-word");
    row.append(slider, number, word);
    field.appendChild(row);
    if (hint) field.appendChild(el("p", "mod-note flip-slider-hint", hint));

    const commit = (raw) => {
      const v = Math.max(0, Math.min(100, Math.round(Number(raw) || 0)));
      onChange(v);
    };
    slider.addEventListener("input", () => commit(slider.value));
    number.addEventListener("change", () => commit(number.value));

    return {
      field,
      sync(v) {
        if (document.activeElement !== slider) slider.value = String(v);
        if (document.activeElement !== number) number.value = String(v);
        word.textContent = describe ? describe(v) : "";
      },
    };
  }

  const controlsPanel = el("section", "flip-panel flip-controls");
  const controlsHead = el("div", "flip-panel-head");
  controlsHead.appendChild(el("h2", "flip-panel-title", "How wrong"));
  const gridSummary = el("span", "flip-grid-summary");
  controlsHead.appendChild(gridSummary);
  controlsPanel.appendChild(controlsHead);

  // PRESETS first. Everything below is the honest model; this row is how you start. A preset writes
  // every field at once, so clicking one always lands on a complete, coherent state.
  const presetField = el("div", "field flip-field");
  presetField.appendChild(el("label", null, "Start from"));
  const presetChips = el("div", "flip-chips");
  const presetButtons = new Map();
  for (const preset of PRESETS) {
    const chip = el("button", "flip-chip flip-preset-chip", preset.label);
    chip.type = "button";
    chip.title = preset.blurb;
    chip.addEventListener("click", () => applyPreset(preset));
    presetChips.appendChild(chip);
    presetButtons.set(preset.key, chip);
  }
  presetField.appendChild(presetChips);
  const presetBlurb = el("p", "mod-note flip-preset-blurb");
  presetField.appendChild(presetBlurb);
  controlsPanel.appendChild(presetField);

  const tweakDetails = el("details", "flip-advanced flip-tweak");
  tweakDetails.appendChild(el("summary", "flip-advanced-summary", "Fine tuning"));
  controlsPanel.appendChild(tweakDetails);

  // REMIX TYPE first: it decides which hierarchy scales and which transformation families are in
  // play at all, so the three sliders below are read as modifiers of it rather than as peers.
  const styleField = el("div", "field flip-field");
  styleField.appendChild(el("label", null, "Remix type"));
  const styleChips = el("div", "flip-chips");
  const styleButtons = new Map();
  for (const style of STYLES) {
    const chip = el("button", "flip-chip", style.label);
    chip.type = "button";
    chip.title = style.blurb;
    chip.addEventListener("click", () => setStyle(style.key));
    styleChips.appendChild(chip);
    styleButtons.set(style.key, chip);
  }
  styleField.appendChild(styleChips);
  const styleBlurb = el("p", "mod-note flip-style-blurb");
  styleField.appendChild(styleBlurb);
  tweakDetails.appendChild(styleField);

  // The three that matter most, in the order you reach for them.
  const structureSlider = makeSlider({
    id: "flip-structure",
    label: "Structure",
    hint: "How much of the large-scale shape survives. High keeps bars where they are and edits inside them; low lets bars move, repeat and be substituted wholesale.",
    value: state.structure,
    describe: describeStructure,
    onChange: (v) => setParam("structure", v),
  });
  tweakDetails.appendChild(structureSlider.field);

  const activitySlider = makeSlider({
    id: "flip-activity",
    label: "Activity",
    hint: "How often FLIP intervenes at all. Low leaves whole bars untouched - which is usually what makes a variation usable.",
    value: state.activity,
    describe: describeActivity,
    onChange: (v) => setParam("activity", v),
  });
  tweakDetails.appendChild(activitySlider.field);

  const depthSlider = makeSlider({
    id: "flip-depth",
    label: "Depth",
    hint: "How far any one intervention goes. Low substitutes a neighbour; high jumps across the phrase, subdivides into micro-slices and reverses.",
    value: state.depth,
    describe: describeDepth,
    onChange: (v) => setParam("depth", v),
  });
  tweakDetails.appendChild(depthSlider.field);

  const rollSlider = makeSlider({
    id: "flip-roll",
    label: "Rolls",
    hint: "How often a fragment is rapidly repeated to fill a beat. Placed at the ends of beats, bars and the phrase, where a fill belongs.",
    value: state.rollAmount,
    describe: (v) => (v === 0 ? "none" : v < 25 ? "rare" : v < 55 ? "occasional" : v < 80 ? "frequent" : "constant"),
    onChange: (v) => setParam("rollAmount", v),
  });
  tweakDetails.appendChild(rollSlider.field);

  // The grid everything else is measured against - the smallest thing FLIP can move. Sized in
  // musical units rather than as a raw count so it stays readable and stays on the bar line, with
  // the resulting chop count in the readout because that is the number you are really choosing.
  const sliceField = el("div", "field flip-field");
  sliceField.appendChild(el("label", null, "Chop size"));
  const sliceSeg = el("div", "seg flip-seg");
  sliceSeg.setAttribute("role", "group");
  sliceSeg.setAttribute("aria-label", "Slice size");
  const sliceButtons = new Map();
  for (const sub of SUBDIVISIONS) {
    const btn = el("button", "seg-btn", sub.label);
    btn.type = "button";
    btn.title = `Cut on ${sub.hint} - the smallest thing FLIP will move`;
    btn.addEventListener("click", () => setSubdivision(sub.key));
    sliceSeg.appendChild(btn);
    sliceButtons.set(sub.key, btn);
  }
  sliceField.appendChild(sliceSeg);
  const sliceNote = el("p", "mod-note flip-slider-hint");
  sliceField.appendChild(sliceNote);
  tweakDetails.appendChild(sliceField);

  // ---- pitch -------------------------------------------------------------
  //
  // A peer of the other controls rather than hidden behind a second disclosure. The RS7000 lists
  // PITCH alongside REVERSE, BREAK and ROLL as one of the things a Loop Remix variation can BE, and
  // that is the right billing: key-aware transposition is one of the most musical things FLIP does,
  // and burying it is most of why it went unnoticed.
  const pitchDetails = tweakDetails;

  const pitchModeField = el("div", "field flip-field");
  const pitchModeLabel = el("label", null, "Pitch mode");
  pitchModeLabel.htmlFor = "flip-pitch-mode";
  pitchModeField.appendChild(pitchModeLabel);
  const pitchModeSelect = el("select");
  pitchModeSelect.id = "flip-pitch-mode";
  for (const mode of PITCH_MODES) {
    const opt = el("option", null, mode.label);
    opt.value = mode.key;
    pitchModeSelect.appendChild(opt);
  }
  pitchModeSelect.addEventListener("change", () => {
    state.pitchMode = resolvePitchMode(pitchModeSelect.value).key;
    state.presetKey = null;
    save();
    markStale();
    render();
  });
  pitchModeField.appendChild(pitchModeSelect);
  const pitchBlurb = el("p", "mod-note");
  pitchModeField.appendChild(pitchBlurb);
  pitchDetails.appendChild(pitchModeField);

  const pitchSlider = makeSlider({
    id: "flip-pitch-amount",
    label: "Pitch amount",
    hint: "How much of the loop gets transposed. Kept low on purpose - pitch works best on repeats and rolls, as an accident you notice, not as a wash.",
    value: state.pitchAmount,
    describe: (v) => (v === 0 ? "none" : v < 20 ? "a touch" : v < 45 ? "occasional" : v < 75 ? "prominent" : "everywhere"),
    onChange: (v) => setParam("pitchAmount", v),
  });
  pitchDetails.appendChild(pitchSlider.field);
  const gridWarning = el("p", "flip-warning");
  gridWarning.hidden = true;
  controlsPanel.appendChild(gridWarning);

  root.appendChild(controlsPanel);

  // ---- results -----------------------------------------------------------

  const listPanel = el("section", "flip-panel flip-results");
  const listHead = el("div", "flip-panel-head");
  listHead.appendChild(el("h2", "flip-panel-title", "Variations"));
  const listSummary = el("span", "flip-list-summary");
  listHead.appendChild(listSummary);
  listPanel.appendChild(listHead);

  const emptyNote = el("p", "flip-empty");
  listPanel.appendChild(emptyNote);

  const rowList = el("div", "flip-row-list");
  listPanel.appendChild(rowList);
  root.appendChild(listPanel);

  // The original always sits at the top of the same list, in the same shape as the variations, so
  // ORIGINAL -> FLIP 1 -> FLIP 2 is one continuous click-down rather than a comparison you have to
  // set up. A/B is the whole point of generating alternatives.
  const originalRow = createVariationRow({
    id: "ORIGINAL",
    isOriginal: true,
    getAudioContext,
    color,
    loop: state.looping,
  });
  rowList.appendChild(originalRow.el);

  // ---- bottom bar --------------------------------------------------------

  const bar = el("div", "flip-bar");
  bar.hidden = true;
  const barInner = el("div", "flip-bar-inner");

  const generateBtn = el("button", "flip-generate", "GENERATE 8");
  generateBtn.type = "button";
  generateBtn.title = "Throw away this batch and propose a fresh one";
  generateBtn.addEventListener("click", () => void generateBatch());

  const sizeSelect = el("select", "flip-size-select");
  sizeSelect.title = "How many variations per batch";
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

  const loopBtn = el("button", "btn btn--ghost btn--small flip-loop-btn", "Loop");
  loopBtn.type = "button";
  loopBtn.title = "Repeat while auditioning, so you can hear whether it works as an actual loop";
  loopBtn.addEventListener("click", () => {
    state.looping = !state.looping;
    for (const row of allRows()) row.setLoop(state.looping);
    save();
    render();
  });

  const depthSelect = el("select", "flip-depth-select");
  depthSelect.title = "Export bit depth";
  for (const depth of [24, 16]) {
    const opt = el("option", null, `${depth}-bit`);
    opt.value = String(depth);
    depthSelect.appendChild(opt);
  }
  depthSelect.addEventListener("change", () => {
    state.bitDepth = Number(depthSelect.value) || DEFAULT_BIT_DEPTH;
    save();
  });

  const exportAllBtn = el("button", "btn btn--small", "Export all");
  exportAllBtn.type = "button";
  exportAllBtn.title = "Write every variation in this batch";
  exportAllBtn.addEventListener("click", () => void exportAll());

  const status = el("span", "flip-bar-status");

  const barControls = el("div", "flip-bar-controls");
  barControls.append(generateBtn, sizeSelect, loopBtn);
  const barActions = el("div", "flip-bar-actions");
  barActions.append(depthSelect, exportAllBtn);
  barInner.append(barControls, status, barActions);
  bar.appendChild(barInner);
  chromeContainer.appendChild(bar);

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  function setSubdivision(key) {
    if (state.subdivision === key) return;
    state.subdivision = resolveSubdivision(key).key;
    state.presetKey = null;
    save();
    markStale();
    render();
  }

  /** Every 0-100 control funnels through here, so they all invalidate and persist the same way. */
  function setParam(name, value) {
    const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    if (state[name] === v) return;
    state[name] = v;
    state.presetKey = null;
    save();
    markStale();
    render();
  }

  /**
   * The coarsest chop size at or finer than `wanted` that still yields enough chops to rearrange.
   *
   * A preset that asks for half-bar blocks is asking for something a two-bar loop cannot give it -
   * four chops, of which nothing can move anywhere interesting. Silently stepping finer is better
   * than handing back a disabled GENERATE button and a warning the user didn't cause.
   */
  /** How many chops `size` would produce for the current source. */
  function sliceCountFor(size) {
    if (!state.audio) return 0;
    return createSliceMap({
      totalSamples: state.audio.channels[0].length,
      sampleRate: state.audio.sampleRate,
      bpm: effectiveBpm(),
      subdivision: size,
    }).count;
  }

  function coerceChopSize(wanted) {
    if (!state.audio) return wanted;
    const from = SUBDIVISIONS.findIndex((s) => s.key === resolveSubdivision(wanted).key);
    for (let i = Math.max(0, from); i < SUBDIVISIONS.length; i++) {
      const map = createSliceMap({
        totalSamples: state.audio.channels[0].length,
        sampleRate: state.audio.sampleRate,
        bpm: effectiveBpm(),
        subdivision: SUBDIVISIONS[i].key,
      });
      if (map.count >= MIN_SLICES) return SUBDIVISIONS[i].key;
    }
    return SUBDIVISIONS[SUBDIVISIONS.length - 1].key;
  }

  /** Write a whole preset at once - see js/flip/presets.js for why it is all-or-nothing. */
  function applyPreset(preset) {
    Object.assign(state, preset.settings);
    state.subdivision = coerceChopSize(preset.settings.subdivision || state.subdivision);
    state.presetKey = preset.key;
    save();
    markStale();
    render();
    log(`FLIP preset: ${preset.label} - ${preset.blurb}`);
  }

  function setStyle(key) {
    if (state.style === key) return;
    state.style = resolveStyle(key).key;
    state.presetKey = null;
    save();
    markStale();
    render();
  }

  function save() {
    writeJSON(STORAGE_KEY, {
      subdivision: state.subdivision,
      structure: state.structure,
      activity: state.activity,
      depth: state.depth,
      rollAmount: state.rollAmount,
      pitchMode: state.pitchMode,
      pitchAmount: state.pitchAmount,
      style: state.style,
      batchSize: state.batchSize,
      bitDepth: state.bitDepth,
      looping: state.looping,
    });
  }

  function restore() {
    const saved = readJSON(STORAGE_KEY);
    if (!saved) return;
    if (saved.subdivision) state.subdivision = resolveSubdivision(saved.subdivision).key;
    for (const name of ["structure", "activity", "depth", "rollAmount", "pitchAmount"]) {
      if (Number.isFinite(saved[name])) state[name] = Math.max(0, Math.min(100, Math.round(saved[name])));
    }
    if (saved.pitchMode) state.pitchMode = resolvePitchMode(saved.pitchMode).key;
    if (typeof saved.presetKey === "string" || saved.presetKey === null) state.presetKey = saved.presetKey;
    if (saved.style) state.style = resolveStyle(saved.style).key;
    if (BATCH_SIZES.includes(saved.batchSize)) state.batchSize = saved.batchSize;
    if (saved.bitDepth === 16 || saved.bitDepth === 24) state.bitDepth = saved.bitDepth;
    if (typeof saved.looping === "boolean") state.looping = saved.looping;
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
        // io.pickFiles() hands back FileSystemFileHandles, not Files - same as PLAY NICE.
        const handles = await io.pickFiles({ multiple: false });
        if (!handles || !handles.length) return; // cancelled
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
      logWarn("FLIP takes one audio loop - that wasn't audio.");
      return;
    }
    if (audio.length > 1) log(`FLIP works on one loop at a time - using "${audio[0].name}".`);
    void loadFile(audio[0]);
  });

  async function loadFile(file) {
    // A new source invalidates everything: the seeds still reproduce their recipes, but a recipe
    // against different audio is a different piece of music, so keeping the old batch on screen
    // would be a lie about what you are listening to.
    clearVariations();
    stopAllPlayback();
    state.file = file;
    state.name = file.name;
    state.audio = null;
    state.detected = null;
    state.bpmOverride = null;
    state.analysisAvailable = false;
    state.error = null;
    state.status = "decoding";
    render();

    try {
      const { buffer } = await decodeFile(file, extOf(file.name));
      const channels = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
      if (!channels.length || !channels[0].length) throw new Error("there's no audio in that file");
      state.audio = { channels, mono: toMono(channels), sampleRate: buffer.sampleRate, duration: channels[0].length / buffer.sampleRate };
      originalRow.setAudio(state.audio);
      log(`FLIP loaded ${file.name} - ${state.audio.duration.toFixed(2)}s, ${channels.length === 1 ? "mono" : `${channels.length} ch`}, ${buffer.sampleRate} Hz.`);

      state.status = "analysing";
      render();
      await yieldToUi();

      // Key is analysed as well as tempo purely so the log line matches what the rest of the app
      // reports about a file. Only the tempo is used - FLIP rearranges time, it doesn't transpose.
      const result = await analyze(state.audio.mono, state.audio.sampleRate, { key: true, tempo: true });
      state.detected = { bpm: result.bpm ?? null, key: result.key ?? null, scale: result.scale ?? null };
      state.analysisAvailable = !!result.available;
      state.status = "ready";
      // A one-bar break loaded while the grid is on whole-bar chops is one chop, which is nothing to
      // rearrange - and arriving at a disabled GENERATE button you did not cause is a bad first
      // second. Step the grid finer instead, and say so.
      const coerced = coerceChopSize(state.subdivision);
      if (coerced !== state.subdivision) {
        log(`  ${resolveSubdivision(state.subdivision).label} chops would only give ${sliceCountFor(state.subdivision)} - using ${resolveSubdivision(coerced).label} instead.`);
        state.subdivision = coerced;
      }
      log(`  ${file.name}: ${state.detected.bpm ? `${Math.round(state.detected.bpm)} BPM` : state.analysisAvailable ? "no confident tempo" : "tempo detection unavailable"}.`);
    } catch (err) {
      state.status = "error";
      state.error = err.message || String(err);
      logWarn(`FLIP couldn't use "${file.name}": ${state.error}`);
    }
    render();
  }

  function clearSource() {
    stopAllPlayback();
    clearVariations();
    state.file = null;
    state.name = "";
    state.audio = null;
    state.detected = null;
    state.bpmOverride = null;
    state.status = "empty";
    state.error = null;
    originalRow.setAudio(null);
    render();
  }

  bpmInput.addEventListener("change", () => {
    const sanitized = sanitizeSourceBpm(bpmInput.value);
    if (sanitized == null) {
      render(); // invalid - put the current value back rather than silently accepting nonsense
      return;
    }
    state.bpmOverride = sanitized;
    markStale();
    render();
  });
  halveBtn.addEventListener("click", () => nudgeTempo(0.5));
  doubleBtn.addEventListener("click", () => nudgeTempo(2));
  resetBpmBtn.addEventListener("click", () => {
    state.bpmOverride = null;
    markStale();
    render();
  });

  function nudgeTempo(factor) {
    const current = effectiveBpm();
    if (current == null) return;
    const sanitized = sanitizeSourceBpm(current * factor);
    if (sanitized == null) return;
    state.bpmOverride = sanitized;
    markStale();
    render();
  }

  function effectiveBpm() {
    return resolveEffectiveTempo(state.bpmOverride, state.detected && state.detected.bpm);
  }

  /** The slice map for the current source and settings, or null when there's nothing to slice. */
  function currentMap() {
    if (!state.audio) return null;
    return createSliceMap({
      totalSamples: state.audio.channels[0].length,
      sampleRate: state.audio.sampleRate,
      bpm: effectiveBpm(),
      subdivision: state.subdivision,
    });
  }

  /**
   * The key a pitch decision should use: the manual override where there is one, detection
   * otherwise. Same shape as effectiveBpm() above, and the same reason for existing.
   */
  function effectiveKey() {
    const root = state.keyRoot || (state.detected && state.detected.key) || null;
    const mode = state.keyMode || (state.detected && state.detected.scale) || null;
    return resolveKey({ root, mode });
  }

  /** Everything a generated variation depends on besides its own seed. */
  function settingsSignature() {
    const map = currentMap();
    const key = effectiveKey();
    return JSON.stringify([
      state.name,
      state.subdivision,
      state.style,
      state.structure,
      state.activity,
      state.depth,
      state.rollAmount,
      state.pitchMode,
      state.pitchAmount,
      key.known ? `${key.root} ${key.mode}` : "",
      map ? map.count : 0,
      map ? Math.round((map.bpm || 0) * 100) : 0,
    ]);
  }

  /** Flag the on-screen batch as generated under settings that have since changed. */
  function markStale() {
    const signature = settingsSignature();
    for (const variation of state.variations) variation.stale = variation.signature !== signature;
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  function allRows() {
    return [originalRow, ...state.variations.map((v) => v.row)];
  }

  function stopAllPlayback() {
    for (const row of allRows()) row.stop();
  }

  /** Destroy the batch's players and drop its buffers, so a new batch doesn't pile up on the old. */
  function clearVariations() {
    for (const variation of state.variations) {
      variation.row.destroy();
      variation.audio = null;
      variation.recipe = null;
    }
    state.variations.length = 0;
  }

  async function generateBatch() {
    if (state.busy) return; // rapid clicking generates one batch, not five overlapping ones
    const map = currentMap();
    const readiness = sliceMapReadiness(map);
    if (!map || !readiness.ok) {
      logWarn(readiness.reason || "FLIP needs a loop first.");
      render();
      return;
    }

    const myGeneration = ++generation;
    state.busy = true;
    stopAllPlayback();
    clearVariations();
    render();

    const signature = settingsSignature();
    const count = state.batchSize;
    const styleLabel = resolveStyle(state.style).label;
    const key = effectiveKey();
    const pitchLabel = state.pitchMode === "off" || !state.pitchAmount ? "no pitch" : `${resolvePitchMode(state.pitchMode).label.toLowerCase()} pitch${key.known ? ` in ${formatKey(key.root, key.mode)}` : ""}`;
    log(
      `FLIP generating ${count} variations - ${describeSliceMap(map)}, ${styleLabel}, ` +
        `structure ${state.structure} (${describeStructure(state.structure)}), activity ${state.activity} (${describeActivity(state.activity)}), ` +
        `depth ${state.depth} (${describeDepth(state.depth)}), ${pitchLabel}.`
    );

    // A batch of eight seeds explores one region of the space eight times. Profiles spread it -
    // see js/flip/diversity.js. Derived from a seed of their own so pressing GENERATE again deals
    // a fresh order rather than the same eight characters in the same eight slots.
    const profiles = profilesForBatch(makeRng(mintSeed()), count);

    for (let i = 0; i < count; i++) {
      if (myGeneration !== generation) break; // superseded - stop rather than filling a stale list
      state.progress = `generating ${i + 1}/${count}`;
      renderBar();
      const variation = buildVariation({ map, signature, index: i + 1, seed: mintSeed(), profile: profiles[i] });
      state.variations.push(variation);
      rowList.appendChild(variation.row.el);
      refreshVariationRow(variation);
      // Yield between variations so rows appear as they land rather than all at once at the end -
      // on a long loop at 1/32 that's the difference between "working" and "frozen".
      await yieldToUi();
    }

    state.progress = null;
    state.busy = false;
    if (myGeneration === generation) {
      logSuccess(`FLIP proposed ${state.variations.length} variation${state.variations.length === 1 ? "" : "s"}.`);
    }
    render();
  }

  /** Everything the generator needs from the session, in one place so the batch path and the
   *  single-row regenerate path can never drift apart. */
  function generationSettings(map) {
    return {
      map,
      style: state.style,
      structure: state.structure,
      activity: state.activity,
      depth: state.depth,
      rollAmount: state.rollAmount,
      pitchMode: state.pitchMode,
      pitchAmount: state.pitchAmount,
      key: effectiveKey(),
    };
  }

  /** Generate + render one variation. Pure inputs -> everything the row needs. */
  function buildVariation({ map, signature, index, seed, profile }) {
    const recipe = generateRecipe({ ...generationSettings(map), seed, profile });
    const audio = renderVariationAudio({
      recipe,
      map,
      channels: state.audio.channels,
      sampleRate: state.audio.sampleRate,
    });
    return {
      id: nextRowId++,
      index,
      seed: recipe.seed,
      recipe,
      audio,
      signature,
      stale: false,
      profile,
      row: createVariationRow({
        id: `FLIP ${String(index).padStart(2, "0")}`,
        getAudioContext,
        color,
        loop: state.looping,
        onSeedChange: (value) => regenerate(index, value),
        onRegenerate: () => regenerate(index, mintSeed()),
        onExport: () => exportOne(index),
      }),
    };
  }

  /**
   * Replace a single variation in place, keeping its position in the list. This is what makes a
   * batch worth sitting with: seven good ones and one dud is a one-click fix, not a reason to
   * throw the whole batch away and lose the seven.
   */
  function regenerate(index, seed) {
    const slot = state.variations.findIndex((v) => v.index === index);
    if (slot === -1 || state.busy) return;
    const map = currentMap();
    const readiness = sliceMapReadiness(map);
    if (!map || !readiness.ok) {
      logWarn(readiness.reason || "Nothing to regenerate from.");
      return;
    }
    const old = state.variations[slot];
    const wasPlaying = old.row.isPlaying();
    old.row.stop();

    const recipe = generateRecipe({ ...generationSettings(map), seed, profile: old.profile });
    old.recipe = recipe;
    old.seed = recipe.seed;
    old.audio = renderVariationAudio({ recipe, map, channels: state.audio.channels, sampleRate: state.audio.sampleRate });
    old.signature = settingsSignature();
    old.stale = false;
    refreshVariationRow(old);
    if (wasPlaying) old.row.play();
    render();
  }

  function refreshVariationRow(variation) {
    variation.row.setAudio(variation.audio);
    const departure = Math.round(recipeDeparture(variation.recipe) * 100);
    variation.row.setInfo({
      seed: variation.seed,
      description: `${describeRecipe(variation.recipe)} · ${departure}% changed`,
      stale: variation.stale,
      title: recipePattern(variation.recipe),
    });
    variation.row.setLoop(state.looping);
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  function encode(variation) {
    return encodeWav(variation.audio.channels, variation.audio.sampleRate, state.bitDepth);
  }

  function exportOne(index) {
    const variation = state.variations.find((v) => v.index === index);
    if (!variation) return;
    const name = variationFileName(state.name, variation.index, variation.seed);
    downloadBlob(encode(variation), name);
    logSuccess(`Exported ${name}`);
  }

  async function exportAll() {
    if (state.busy) return;
    if (!state.variations.length) {
      logWarn("Nothing generated yet.");
      return;
    }

    const folder = batchFolderName(state.name);
    let dirHandle = null;
    if (io.supportsFSA) {
      // Asked once per session and remembered, the same way PLAY NICE's Export All does it.
      dirHandle = state.exportDir;
      if (!dirHandle) {
        dirHandle = await io.pickFolder();
        if (!dirHandle) return; // cancelled
        if (!(await io.ensurePermission(dirHandle))) {
          logWarn("No write permission for that folder, so nothing was exported.");
          return;
        }
        state.exportDir = dirHandle;
      }
    }

    state.busy = true;
    render();

    const zip = dirHandle ? null : new io.ZipBatch();
    const taken = new Set();
    let written = 0;
    let failed = 0;
    let index = 0;

    for (const variation of state.variations) {
      state.progress = `exporting ${++index}/${state.variations.length}`;
      renderBar();
      const name = uniqueName(variationFileName(state.name, variation.index, variation.seed), taken);
      try {
        const blob = encode(variation);
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
    if (written) logSuccess(`Exported ${written} variation${written === 1 ? "" : "s"} to ${dirHandle ? `${folder}/` : `${folder}.zip`}.`);
    if (failed) logWarn(`${failed} variation${failed === 1 ? "" : "s"} couldn't be exported.`);
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

  function render() {
    const hasSource = !!state.audio;
    const map = currentMap();
    const readiness = sliceMapReadiness(map);

    dropzone.hidden = hasSource || state.status === "decoding" || state.status === "analysing";
    loaded.hidden = !state.file;
    loadedName.textContent = state.name || "";

    if (state.status === "error") {
      sourceStatus.textContent = state.error || "That file couldn't be used.";
      sourceStatus.classList.add("is-error");
    } else {
      sourceStatus.classList.remove("is-error");
      if (state.status === "decoding") sourceStatus.textContent = "Decoding…";
      else if (state.status === "analysing") sourceStatus.textContent = "Detecting tempo…";
      else if (hasSource) {
        const ch = state.audio.channels.length === 1 ? "mono" : state.audio.channels.length === 2 ? "stereo" : `${state.audio.channels.length} ch`;
        sourceStatus.textContent = `${state.audio.duration.toFixed(2)}s · ${ch} · ${state.audio.sampleRate} Hz`;
      } else sourceStatus.textContent = "";
    }

    tempoRow.hidden = !hasSource;
    const bpm = effectiveBpm();
    if (document.activeElement !== bpmInput) bpmInput.value = bpm != null ? String(Math.round(bpm * 100) / 100) : "";
    tempoNote.textContent = formatBpmText(bpm, state.bpmOverride != null, state.analysisAvailable);
    resetBpmBtn.disabled = state.bpmOverride == null;
    halveBtn.disabled = bpm == null;
    doubleBtn.disabled = bpm == null;

    sourceSummary.textContent = hasSource && map ? describeSliceMap(map) : "";
    gridSummary.textContent = map ? `${map.count} chops` : "";
    sliceNote.textContent = map
      ? `${map.count} chops across the loop. Coarse sizes move whole bars around; fine ones let it work down to micro-fragments.`
      : "Coarse sizes move whole bars around; fine ones let it work down to micro-fragments.";

    for (const [key, btn] of sliceButtons) btn.classList.toggle("is-active", key === state.subdivision);
    // The explicitly-clicked preset wins; matchPreset() is the fallback for a restored session
    // whose saved settings happen to line up with one.
    const activePreset = (state.presetKey && PRESETS.find((p) => p.key === state.presetKey)) || matchPreset(state);
    for (const [key, chip] of presetButtons) chip.classList.toggle("is-active", !!activePreset && activePreset.key === key);
    presetBlurb.textContent = activePreset ? activePreset.blurb : "Your own settings. Pick a starting point above, or open Fine tuning.";
    for (const [key, chip] of styleButtons) chip.classList.toggle("is-active", key === state.style);
    styleBlurb.textContent = resolveStyle(state.style).blurb;
    structureSlider.sync(state.structure);
    activitySlider.sync(state.activity);
    depthSlider.sync(state.depth);
    rollSlider.sync(state.rollAmount);
    pitchSlider.sync(state.pitchAmount);
    pitchModeSelect.value = state.pitchMode;
    pitchBlurb.textContent = resolvePitchMode(state.pitchMode).blurb;

    const key = effectiveKey();
    keyRow.hidden = !hasSource;
    keyRootSelect.value = key.known ? key.root : "";
    keyModeSelect.value = key.mode;
    keyModeSelect.disabled = !key.known;
    const detectedKey = state.detected && state.detected.key ? formatKey(state.detected.key, state.detected.scale) : null;
    const manualKey = !!(state.keyRoot || state.keyMode);
    if (!key.known) keyNote.textContent = state.pitchMode === "off" ? "no key needed" : "no key detected - in-key pitch needs one";
    else keyNote.textContent = manualKey ? `${formatKey(key.root, key.mode)} (manual)` : detectedKey ? `${detectedKey} (detected)` : formatKey(key.root, key.mode);

    const warning = hasSource ? readiness.reason || readiness.warning : null;
    gridWarning.hidden = !warning;
    gridWarning.textContent = warning || "";
    gridWarning.classList.toggle("is-error", !!(hasSource && readiness.reason));

    originalRow.setInfo({ description: hasSource ? "your loop, untouched" : "no loop loaded yet" });
    originalRow.el.hidden = !hasSource;
    emptyNote.hidden = state.variations.length > 0;
    emptyNote.textContent = hasSource ? "Nothing generated yet - press GENERATE and start listening." : "Load a loop above, then press GENERATE.";
    listSummary.textContent = state.variations.length ? `${state.variations.length} in this batch` : "";
    for (const variation of state.variations) variation.row.setInfo({ stale: variation.stale });

    sizeSelect.value = String(state.batchSize);
    depthSelect.value = String(state.bitDepth);
    renderBar();
  }

  function renderBar() {
    const canGenerate = !!state.audio && !state.busy && sliceMapReadiness(currentMap()).ok;
    generateBtn.textContent = state.variations.length ? `GENERATE ${state.batchSize} MORE` : `GENERATE ${state.batchSize}`;
    generateBtn.disabled = !canGenerate;
    exportAllBtn.disabled = !state.variations.length || state.busy;
    sizeSelect.disabled = state.busy;
    loopBtn.classList.toggle("is-active", state.looping);
    loopBtn.setAttribute("aria-pressed", state.looping ? "true" : "false");
    status.textContent = state.progress || (state.busy ? "working…" : "");
    status.classList.toggle("is-working", !!state.progress);
  }

  render();

  return {
    element: root,
    /** FLIP is on screen (or not) - the bottom bar follows. */
    setActive(active) {
      bar.hidden = !active;
      if (!active) stopAllPlayback();
      else requestAnimationFrame(() => {
        for (const row of allRows()) row.redraw();
      });
    },
    stopAllPlayback,
    hasContent() {
      return !!state.file || state.variations.length > 0;
    },
    /** Wipe the session - what New Session calls. */
    reset() {
      generation++;
      clearSource();
      state.exportDir = null;
      state.busy = false;
      state.progress = null;
      render();
    },
    redraw() {
      for (const row of allRows()) row.redraw();
    },
  };
}

/**
 * Drag and drop onto the whole FLIP workspace. Its own copy rather than an import from
 * js/play-nice/target-panel.js: that one exists to let an INNER zone win over an outer one via
 * stopPropagation, which is a PLAY NICE layout problem. FLIP has exactly one target - anywhere.
 */
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
