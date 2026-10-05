// stretch-workspace.js
//
// The STRETCH task's central workspace: a compact file strip, a Time/Target panel (mode, target
// tempo/ratio, detected tempo, resolved ratio - moved in from the old sidebar so the source/target
// relationship sits right next to the audio it produces), an Original vs. Processed A/B audition
// pane (built on preview-waveform.js), and a character browser (a grid of cards grouped by sonic
// family, reading straight from the DSP's own character registry, plus a focused macro-control
// panel for whichever character is selected). app.js owns all real state (timestretchSettings,
// analysisCache, the batch pipeline) - this module is a renderer + interaction surface over it, the
// same relationship editor-waveform.js has with the chop-editor card it's mounted inside.
//
// Deliberately split into several small `setX`/`renderX` methods rather than one big
// `render(viewModel)`: dragging a macro slider must be cheap (update a number, nothing else) and
// must NOT tear down and rebuild the Original/Processed waveforms - that would both look janky and
// silently kill any audio currently playing. Only an actual character switch, file switch, mode
// switch, or a fresh Process result rebuilds the parts of the DOM that need it.
import { characterGroups, MACROS } from "./dsp/stretch/characters.js";
import { RATIO_PCT_MIN, RATIO_PCT_MAX, RATIO_SLIDER_STEPS, sliderToRatioPct, ratioPctToSlider, tidyRatioPct } from "./dsp/stretch/workspace-state.js";
import { mapPreviewPosition } from "./dsp/stretch/workspace-state.js";
import { createPreviewWaveform } from "./preview-waveform.js";

function fmtSeconds(s) {
  return `${s.toFixed(1)}s`;
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.container
 * @param {() => AudioContext} deps.getAudioContext
 * @param {(name:string, fallback:string) => string} deps.color
 * @param {(mode:string) => void} deps.onModeChange
 * @param {(v:number) => void} deps.onTargetBpmChange   BPM, already rounded/clamped by the caller
 * @param {(v:number) => void} deps.onRatioChange        percent (100 = 1.0x), already rounded/clamped
 * @param {(v:number) => void} deps.onSourceBpmChange    a typed source-tempo correction, raw (app.js validates/sanitizes)
 * @param {() => void} deps.onSourceHalve                halve the active file's current effective source tempo
 * @param {() => void} deps.onSourceDouble               double the active file's current effective source tempo
 * @param {() => void} deps.onSourceReset                clear the active file's manual correction, falling back to detection
 */
export function createStretchWorkspace({
  container,
  getAudioContext,
  color,
  onModeChange,
  onTargetBpmChange,
  onRatioChange,
  onSourceBpmChange,
  onSourceHalve,
  onSourceDouble,
  onSourceReset,
}) {
  const fileStrip = document.createElement("div");
  fileStrip.className = "stretch-file-strip";
  container.appendChild(fileStrip);

  // ---- Time / Target ---------------------------------------------------
  //
  // Built once; a mode switch just toggles which of the two mode-specific fields is visible (same
  // show/one-hidden approach the old sidebar used), so dragging the target-tempo or ratio slider
  // never rebuilds anything here - it only calls back into app.js, exactly like the macro sliders
  // in the character detail panel below.

  const timeTarget = document.createElement("div");
  timeTarget.className = "stretch-time-target";
  const timeHead = document.createElement("div");
  timeHead.className = "stretch-pane-head";
  const timeTitle = document.createElement("h3");
  timeTitle.textContent = "Time / Target";
  timeHead.appendChild(timeTitle);
  timeTarget.appendChild(timeHead);

  const modeField = document.createElement("div");
  modeField.className = "field";
  const modeLabel = document.createElement("label");
  modeLabel.textContent = "Mode";
  modeLabel.htmlFor = "stretch-time-mode-select";
  const modeSelect = document.createElement("select");
  modeSelect.id = "stretch-time-mode-select";
  for (const [value, label] of [
    ["target-tempo", "Match a target tempo"],
    ["fixed-ratio", "Fixed ratio"],
  ]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    modeSelect.appendChild(opt);
  }
  modeSelect.addEventListener("change", () => onModeChange(modeSelect.value));
  modeField.append(modeLabel, modeSelect);
  timeTarget.appendChild(modeField);

  const timeGrid = document.createElement("div");
  timeGrid.className = "stretch-time-grid";
  timeTarget.appendChild(timeGrid);

  function makeReadout(label) {
    const el = document.createElement("div");
    el.className = "field-readout stretch-time-readout";
    const span = document.createElement("span");
    span.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = "–";
    el.append(span, strong);
    timeGrid.appendChild(el);
    return strong;
  }

  // ---- Source tempo (editable) -------------------------------------------
  //
  // Not a plain readout like Ratio below: detection can get halved/doubled or simply wrong, so the
  // source tempo every downstream calculation uses needs to be correctable right here, inline, next
  // to the ratio it feeds - see onSourceBpmChange/onSourceHalve/onSourceDouble/onSourceReset. Kept
  // deliberately compact (a number field plus two tiny buttons) rather than a settings panel - the
  // interaction this is built for is "oh, that's actually 140" - click, type, Enter, done.

  const sourceField = document.createElement("div");
  sourceField.className = "field stretch-source-field";
  const sourceLabel = document.createElement("label");
  sourceLabel.textContent = "Source";
  sourceLabel.htmlFor = "stretch-source-bpm-input";
  const sourceRow = document.createElement("div");
  sourceRow.className = "slider-row stretch-source-row";
  const sourceInput = document.createElement("input");
  sourceInput.type = "number";
  sourceInput.id = "stretch-source-bpm-input";
  sourceInput.className = "slider-number stretch-source-input";
  sourceInput.min = "0";
  sourceInput.step = "1";
  sourceInput.placeholder = "–";
  const sourceUnit = document.createElement("span");
  sourceUnit.className = "slider-unit";
  sourceUnit.textContent = "BPM";
  const halveBtn = document.createElement("button");
  halveBtn.type = "button";
  halveBtn.className = "btn btn--ghost stretch-source-mini-btn";
  halveBtn.textContent = "½";
  halveBtn.title = "Halve the source tempo - fixes a double-time detection error";
  halveBtn.addEventListener("click", () => onSourceHalve());
  const doubleBtn = document.createElement("button");
  doubleBtn.type = "button";
  doubleBtn.className = "btn btn--ghost stretch-source-mini-btn";
  doubleBtn.textContent = "×2";
  doubleBtn.title = "Double the source tempo - fixes a half-time detection error";
  doubleBtn.addEventListener("click", () => onSourceDouble());
  sourceRow.append(sourceInput, sourceUnit, halveBtn, doubleBtn);

  const sourceSub = document.createElement("div");
  sourceSub.className = "stretch-source-sub";
  const sourceManualBadge = document.createElement("span");
  sourceManualBadge.className = "stretch-source-manual-badge";
  sourceManualBadge.textContent = "manual";
  const sourceDetectedNote = document.createElement("span");
  sourceDetectedNote.className = "stretch-source-detected";
  const sourceResetBtn = document.createElement("button");
  sourceResetBtn.type = "button";
  sourceResetBtn.className = "btn-link stretch-source-reset";
  sourceResetBtn.textContent = "reset to detected";
  sourceResetBtn.addEventListener("click", () => onSourceReset());
  sourceSub.append(sourceManualBadge, sourceDetectedNote, sourceResetBtn);

  sourceField.append(sourceLabel, sourceRow, sourceSub);
  timeGrid.appendChild(sourceField);

  // Last value setTimeTarget() was told about, so committing an emptied/garbage edit can revert the
  // input back to it without app.js having to round-trip a redraw just to undo a bad keystroke.
  let currentSourceBpm = null;
  function refreshSourceInput() {
    sourceInput.value = currentSourceBpm != null ? String(Math.round(currentSourceBpm)) : "";
  }
  // Fires on blur/Enter, not per-keystroke - the same commit model every other typed field in this
  // panel uses (see targetBpmField/ratioField below), which is what keeps an emptied-then-retyped
  // field from corrupting state mid-edit: nothing reaches app.js until the value settles.
  sourceInput.addEventListener("change", () => {
    const raw = sourceInput.value.trim();
    const v = Number(raw);
    if (raw === "" || !Number.isFinite(v) || v <= 0) {
      refreshSourceInput(); // invalid/empty - just redraw the last-known value, don't touch state
      return;
    }
    onSourceBpmChange(v);
  });

  function makeSliderField(labelText, { min, max, step, unit }) {
    const field = document.createElement("div");
    field.className = "field stretch-time-slider-field";
    const label = document.createElement("label");
    label.textContent = labelText;
    const row = document.createElement("div");
    row.className = "slider-row";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    const number = document.createElement("input");
    number.type = "number";
    number.className = "slider-number";
    number.min = String(min);
    number.max = String(max);
    number.step = String(step);
    const unitEl = document.createElement("span");
    unitEl.className = "slider-unit";
    unitEl.textContent = unit;
    row.append(slider, number, unitEl);
    field.append(label, row);
    timeGrid.appendChild(field);
    return { field, slider, number };
  }

  const targetBpmField = makeSliderField("Target tempo", { min: 40, max: 300, step: 1, unit: "BPM" });
  targetBpmField.slider.addEventListener("input", () => {
    targetBpmField.number.value = targetBpmField.slider.value;
    onTargetBpmChange(Number(targetBpmField.slider.value));
  });
  targetBpmField.number.addEventListener("change", () => {
    let v = Math.min(300, Math.max(40, Math.round(Number(targetBpmField.number.value) || 120)));
    targetBpmField.number.value = targetBpmField.slider.value = String(v);
    onTargetBpmChange(v);
  });

  // Log-scaled slider (see sliderToRatioPct) - the number box holds the actual %.
  const ratioField = makeSliderField("Stretch amount", { min: 0, max: RATIO_SLIDER_STEPS, step: 1, unit: "%" });
  ratioField.number.min = String(RATIO_PCT_MIN);
  ratioField.number.max = String(RATIO_PCT_MAX);
  ratioField.number.classList.add("slider-number-wide");
  ratioField.slider.addEventListener("input", () => {
    const v = sliderToRatioPct(ratioField.slider.value);
    ratioField.number.value = String(v);
    onRatioChange(v);
  });
  ratioField.number.addEventListener("change", () => {
    const v = tidyRatioPct(ratioField.number.value);
    ratioField.number.value = String(v);
    ratioField.slider.value = String(ratioPctToSlider(v));
    onRatioChange(v);
  });

  const ratioReadout = makeReadout("Ratio");
  container.appendChild(timeTarget);

  /**
   * Cheap: no rebuild, just reflects current settings - call on every settings/active-file change.
   * `sourceBpm` is the active file's EFFECTIVE tempo (detected, possibly overridden) - what the input
   * displays and what ½/×2 operate on. `isManual` and `detectedBpm` (the raw, un-overridden value)
   * drive the "manual"/"Detected: N BPM"/Reset sub-row. `canEdit` is false only when there's no active
   * file at all to correct.
   */
  function setTimeTarget({ mode, targetBpm, ratioPct, sourceBpm, isManual, detectedBpm, canEdit, resolvedRatioText }) {
    modeSelect.value = mode;
    targetBpmField.field.hidden = mode !== "target-tempo";
    ratioField.field.hidden = mode !== "fixed-ratio";
    if (document.activeElement !== targetBpmField.number) targetBpmField.slider.value = targetBpmField.number.value = String(targetBpm);
    if (document.activeElement !== ratioField.number) {
      ratioField.number.value = String(ratioPct);
      // Don't yank the slider mid-drag: its position already maps to this % (give or take rounding).
      if (document.activeElement !== ratioField.slider) ratioField.slider.value = String(ratioPctToSlider(ratioPct));
    }

    currentSourceBpm = sourceBpm;
    if (document.activeElement !== sourceInput) refreshSourceInput();
    sourceInput.disabled = !canEdit;
    halveBtn.disabled = doubleBtn.disabled = !canEdit || sourceBpm == null;
    sourceField.classList.toggle("is-manual", !!isManual);
    sourceSub.hidden = !isManual;
    if (isManual) {
      const canReset = detectedBpm != null;
      sourceResetBtn.hidden = !canReset;
      sourceDetectedNote.hidden = !canReset;
      sourceDetectedNote.textContent = canReset ? `detected: ${Math.round(detectedBpm)} BPM` : "";
    }

    ratioReadout.textContent = resolvedRatioText;
  }

  // ---- Original / Processed A/B -----------------------------------------

  const ab = document.createElement("div");
  ab.className = "stretch-ab";
  container.appendChild(ab);

  function makePane(kind, title) {
    const pane = document.createElement("section");
    pane.className = `stretch-pane stretch-pane--${kind}`;
    const head = document.createElement("div");
    head.className = "stretch-pane-head";
    const h = document.createElement("h3");
    h.textContent = title;
    const meta = document.createElement("span");
    meta.className = "stretch-pane-meta";
    head.append(h, meta);
    pane.appendChild(head);
    const processingBadge = document.createElement("p");
    processingBadge.className = "stretch-processing-badge";
    processingBadge.textContent = "Processing…";
    processingBadge.hidden = true;
    pane.appendChild(processingBadge);
    const staleBadge = document.createElement("p");
    staleBadge.className = "stretch-stale-badge";
    staleBadge.textContent = "Settings changed - updating…";
    staleBadge.hidden = true;
    pane.appendChild(staleBadge);
    const errorBadge = document.createElement("p");
    errorBadge.className = "stretch-error-badge";
    errorBadge.hidden = true;
    pane.appendChild(errorBadge);
    const waveHost = document.createElement("div");
    waveHost.className = "stretch-pane-wave";
    pane.appendChild(waveHost);
    ab.appendChild(pane);
    return { pane, meta, waveHost, staleBadge, processingBadge, errorBadge };
  }

  const originalPane = makePane("original", "Original");
  const processedPane = makePane("processed", "Processed");
  processedPane.pane.classList.add("stretch-pane--emphasis");

  // ---- Character browser -------------------------------------------------

  const browser = document.createElement("div");
  browser.className = "stretch-character-browser";
  const browserHead = document.createElement("div");
  browserHead.className = "stretch-character-browser-head";
  const browserTitle = document.createElement("h3");
  browserTitle.textContent = "Character";
  browserHead.appendChild(browserTitle);
  browser.appendChild(browserHead);
  // Static help text for the per-card checkbox below - written once, not touched by
  // renderCharacterBrowser's repeated re-renders (unlike browserExportSummary, whose count changes
  // every time a checkbox is toggled).
  const browserExportHint = document.createElement("p");
  browserExportHint.className = "stretch-character-export-hint";
  browserExportHint.textContent =
    "Check any card to queue it for a multi-variation export - Export then writes one file per checked character into variations/, instead of just the active one below.";
  browser.appendChild(browserExportHint);
  const browserExportSummary = document.createElement("div");
  browserExportSummary.className = "stretch-character-export-summary";
  browserExportSummary.hidden = true;
  const browserExportCount = document.createElement("span");
  const browserExportClear = document.createElement("button");
  browserExportClear.type = "button";
  browserExportClear.className = "stretch-character-export-clear";
  browserExportClear.textContent = "Clear";
  browserExportSummary.append(browserExportCount, browserExportClear);
  browser.appendChild(browserExportSummary);
  const groupsHost = document.createElement("div");
  groupsHost.className = "stretch-character-groups";
  browser.appendChild(groupsHost);
  const detailHost = document.createElement("div");
  detailHost.className = "stretch-character-detail";
  browser.appendChild(detailHost);
  container.appendChild(browser);

  let originalWave = null;
  let processedWave = null;
  let hasProcessedData = false; // tracks whether processedPane currently shows real audio (for setStale)
  let activeSide = "original"; // which pane currently "owns" audition focus - see Left/Right below

  function destroyWave(ref) {
    if (ref) ref.destroy();
  }

  function updateFocusVisual() {
    originalPane.pane.classList.toggle("is-focused", activeSide === "original");
    processedPane.pane.classList.toggle("is-focused", activeSide === "processed");
  }

  /** items: [{key, fileName, processed:boolean}]; onSelect(key) fires on click. */
  function setFileList(items, activeKey, onSelect) {
    fileStrip.innerHTML = "";
    fileStrip.hidden = items.length <= 1;
    for (const item of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "stretch-file-chip" + (item.key === activeKey ? " is-active" : "");
      row.textContent = item.fileName;
      if (!item.processed) row.classList.add("is-unprocessed");
      row.title = item.processed ? item.fileName : `${item.fileName} - not processed yet`;
      row.addEventListener("click", () => onSelect(item.key));
      fileStrip.appendChild(row);
    }
  }

  /** data: null (nothing to show yet) or {mono, sampleRate, duration, bpmText, keyText}. */
  function setOriginal(data) {
    destroyWave(originalWave);
    originalWave = null;
    originalPane.waveHost.innerHTML = "";
    if (!data) {
      originalPane.meta.textContent = "";
      originalWave = createPreviewWaveform({ mono: null, sampleRate: 0, duration: 0, color, getAudioContext });
      originalPane.waveHost.appendChild(originalWave.el);
      return;
    }
    const bits = [data.bpmText, fmtSeconds(data.duration)].filter(Boolean);
    originalPane.meta.textContent = bits.join(" · ");
    originalWave = createPreviewWaveform({
      mono: data.mono,
      sampleRate: data.sampleRate,
      duration: data.duration,
      color,
      getAudioContext,
      onPlayStateChange: (playing) => {
        if (playing) {
          activeSide = "original";
          updateFocusVisual();
        }
      },
    });
    originalPane.waveHost.appendChild(originalWave.el);
  }

  /** data: null, or {mono, sampleRate, duration, characterLabel, ratio}. */
  function setProcessed(data, isStale) {
    destroyWave(processedWave);
    processedWave = null;
    processedPane.waveHost.innerHTML = "";
    processedPane.errorBadge.hidden = true;
    if (!data) {
      hasProcessedData = false;
      processedPane.meta.textContent = "";
      processedPane.staleBadge.hidden = true;
      processedWave = createPreviewWaveform({ mono: null, sampleRate: 0, duration: 0, color, getAudioContext });
      processedPane.waveHost.appendChild(processedWave.el);
      return;
    }
    hasProcessedData = true;
    const bits = [data.characterLabel, `${data.ratio.toFixed(2)}x`, fmtSeconds(data.duration)].filter(Boolean);
    processedPane.meta.textContent = bits.join(" · ");
    processedPane.staleBadge.textContent = "Settings changed - updating…";
    processedPane.staleBadge.hidden = !isStale;
    processedPane.pane.classList.toggle("is-stale", !!isStale);
    processedWave = createPreviewWaveform({
      mono: data.mono,
      sampleRate: data.sampleRate,
      duration: data.duration,
      color,
      getAudioContext,
      onPlayStateChange: (playing) => {
        if (playing) {
          activeSide = "processed";
          updateFocusVisual();
        }
      },
    });
    processedPane.waveHost.appendChild(processedWave.el);
  }

  /** Cheap: just the stale badge/border, no waveform rebuild - safe to call on every settings tweak. */
  function setStale(isStale) {
    processedPane.staleBadge.textContent = "Settings changed - updating…";
    processedPane.staleBadge.hidden = !isStale || !hasProcessedData;
    processedPane.pane.classList.toggle("is-stale", !!isStale && hasProcessedData);
  }

  /** While true, shows a compact "Processing…" indicator on the Processed pane without touching the waveform underneath it. */
  function setProcessing(isProcessing) {
    processedPane.processingBadge.hidden = !isProcessing;
    processedPane.pane.classList.toggle("is-processing", isProcessing);
    if (isProcessing) processedPane.staleBadge.hidden = true; // processing IS the resolution of "stale" in progress
  }

  /** Shows a short error message on the Processed pane (auto-preview failed) - the waveform underneath, if any, is left exactly as it was. */
  function setProcessingError(message) {
    processedPane.errorBadge.textContent = message;
    processedPane.errorBadge.hidden = !message;
  }

  /**
   * opts: { characterKey, macroValues, seed, onSelectCharacter(key), onMacroChange(key,value),
   * onSeedChange(value), onRandomise(), exportKeys (Set of queued character keys),
   * onToggleExportKey(key, checked), onClearExportKeys() }
   */
  function renderCharacterBrowser(opts) {
    const exportKeys = opts.exportKeys || new Set();
    groupsHost.innerHTML = "";
    for (const group of characterGroups()) {
      if (!group.characters.length) continue;
      const section = document.createElement("div");
      section.className = "stretch-character-group";
      const h = document.createElement("h4");
      h.textContent = group.label;
      section.appendChild(h);
      const grid = document.createElement("div");
      grid.className = "stretch-character-grid";
      for (const c of group.characters) {
        const isQueued = exportKeys.has(c.key);
        const card = document.createElement("button");
        card.type = "button";
        card.className = "stretch-character-card" + (c.key === opts.characterKey ? " is-active" : "") + (isQueued ? " is-queued" : "");
        // A checkbox living inside a <button> would be invalid markup and unreachable by its own
        // click semantics, so this is a plain checkbox-styled span, toggled by its own click
        // handler - stopPropagation() is what keeps that click from also firing onSelectCharacter
        // and switching the live preview just because the user meant to queue it for export.
        const checkbox = document.createElement("span");
        checkbox.className = "stretch-character-card-check" + (isQueued ? " is-checked" : "");
        checkbox.setAttribute("role", "checkbox");
        checkbox.setAttribute("aria-checked", String(isQueued));
        checkbox.title = isQueued ? `Remove ${c.label} from the export queue` : `Queue ${c.label} for a multi-variation export`;
        checkbox.addEventListener("click", (ev) => {
          ev.stopPropagation();
          opts.onToggleExportKey(c.key, !isQueued);
        });
        const label = document.createElement("span");
        label.className = "stretch-character-card-label";
        label.textContent = c.label;
        const desc = document.createElement("span");
        desc.className = "stretch-character-card-desc";
        desc.textContent = c.description;
        card.append(checkbox, label, desc);
        card.title = c.description;
        card.addEventListener("click", () => opts.onSelectCharacter(c.key));
        grid.appendChild(card);
      }
      section.appendChild(grid);
      groupsHost.appendChild(section);
    }

    const queuedCount = exportKeys.size;
    browserExportSummary.hidden = queuedCount === 0;
    if (queuedCount > 0) {
      browserExportCount.textContent = `${queuedCount} variation${queuedCount === 1 ? "" : "s"} queued for export`;
      browserExportClear.onclick = () => opts.onClearExportKeys && opts.onClearExportKeys();
    }

    renderCharacterDetail(opts);
  }

  function renderCharacterDetail(opts) {
    detailHost.innerHTML = "";
    const character = characterGroups()
      .flatMap((g) => g.characters)
      .find((c) => c.key === opts.characterKey);
    if (!character) return;

    const head = document.createElement("div");
    head.className = "stretch-character-detail-head";
    const name = document.createElement("strong");
    name.textContent = character.label;
    const desc = document.createElement("span");
    desc.textContent = character.description;
    head.append(name, desc);
    detailHost.appendChild(head);

    const macroKeys = character.macros || [];
    if (macroKeys.length) {
      const macroGrid = document.createElement("div");
      macroGrid.className = "stretch-macro-grid";
      for (const key of macroKeys) {
        const meta = MACROS[key];
        const row = document.createElement("div");
        row.className = "field";
        const label = document.createElement("label");
        label.textContent = meta.label;
        const sliderRow = document.createElement("div");
        sliderRow.className = "slider-row";
        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = "0";
        slider.max = "100";
        slider.step = "1";
        const value = opts.macroValues && typeof opts.macroValues[key] === "number" ? opts.macroValues[key] : meta.default;
        slider.value = String(value);
        const number = document.createElement("input");
        number.type = "number";
        number.className = "slider-number";
        number.min = "0";
        number.max = "100";
        number.step = "1";
        number.value = String(value);
        const unit = document.createElement("span");
        unit.className = "slider-unit";
        unit.textContent = "%";
        slider.addEventListener("input", () => {
          number.value = slider.value;
          opts.onMacroChange(key, Number(slider.value));
        });
        number.addEventListener("change", () => {
          let v = Number(number.value);
          if (!Number.isFinite(v)) v = Number(slider.value);
          v = Math.min(100, Math.max(0, Math.round(v)));
          number.value = String(v);
          slider.value = String(v);
          opts.onMacroChange(key, v);
        });
        sliderRow.append(slider, number, unit);
        const hint = document.createElement("p");
        hint.className = "mod-note";
        hint.textContent = meta.hint || "";
        row.append(label, sliderRow, hint);
        macroGrid.appendChild(row);
      }
      detailHost.appendChild(macroGrid);
    }

    const footRow = document.createElement("div");
    footRow.className = "stretch-character-detail-foot";
    if (character.usesSeed) {
      const seedField = document.createElement("div");
      seedField.className = "field field--inline";
      const seedLabel = document.createElement("label");
      seedLabel.textContent = "Seed";
      const seedInput = document.createElement("input");
      seedInput.type = "number";
      seedInput.min = "0";
      seedInput.max = "999999";
      seedInput.step = "1";
      seedInput.value = String(opts.seed ?? 1);
      seedInput.addEventListener("change", () => {
        const v = Math.max(0, Math.round(Number(seedInput.value) || 0));
        seedInput.value = String(v);
        opts.onSeedChange(v);
      });
      seedField.append(seedLabel, seedInput);
      footRow.appendChild(seedField);
    }
    if (macroKeys.length || character.usesSeed) {
      const randomiseBtn = document.createElement("button");
      randomiseBtn.type = "button";
      randomiseBtn.className = "btn btn--ghost btn--small";
      randomiseBtn.textContent = "Randomise";
      randomiseBtn.title = "Randomise this character's creative controls (and seed, if it has one).";
      randomiseBtn.addEventListener("click", () => opts.onRandomise());
      footRow.appendChild(randomiseBtn);
    }
    if (footRow.childElementCount) detailHost.appendChild(footRow);

    if (character.preservesPitch === false) {
      const note = document.createElement("p");
      note.className = "mod-note";
      note.textContent = "Pitch follows speed with this character - stretching also changes pitch, like tape or varispeed.";
      detailHost.appendChild(note);
    }
  }

  function stopAllPlayback() {
    if (originalWave) originalWave.stop();
    if (processedWave) processedWave.stop();
  }

  // ---- Left/Right A/B switching -------------------------------------------
  //
  // Scoped to `container` (catches keydowns bubbling up from anywhere inside the workspace), not
  // the document, so it can never steal arrow keys from a form control elsewhere on the page (the
  // naming pattern editor, the left rail, etc). Inside the workspace itself, real form controls -
  // the mode select, target-tempo/ratio/macro sliders, the seed input - are excluded by the
  // closest(...) check below, since arrow keys already have expected native behaviour on those.
  // Buttons (character cards, file chips, Randomise, the waveforms' own Play/Stop) are deliberately
  // NOT excluded: a button has no native arrow-key behaviour to preserve, and clicking one (a
  // character card, most obviously) is exactly when a listener would expect Left/Right to work next.

  function switchTo(target) {
    const from = activeSide === "original" ? originalWave : processedWave;
    const to = target === "original" ? originalWave : processedWave;
    if (!to) return;
    if (activeSide === target) {
      // Already the active side - Left/Right when stopped just (re)confirms focus, per spec.
      updateFocusVisual();
      return;
    }
    const wasPlaying = !!(from && from.isPlaying());
    const targetPos =
      from && from.hasAudio() && to.hasAudio() ? mapPreviewPosition(from.getPosition(), from.getDuration(), to.getDuration()) : to.getPosition();
    if (from) from.pause();
    activeSide = target;
    updateFocusVisual();
    if (wasPlaying && to.hasAudio()) to.play(targetPos);
    else to.seekTo(targetPos);
  }

  container.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    const t = ev.target;
    if (t && t.closest && t.closest('input, select, textarea, [contenteditable="true"]')) return;
    ev.preventDefault();
    switchTo(ev.key === "ArrowLeft" ? "original" : "processed");
  });

  function destroy() {
    destroyWave(originalWave);
    destroyWave(processedWave);
    container.innerHTML = "";
  }

  return {
    el: container,
    setFileList,
    setTimeTarget,
    setOriginal,
    setProcessed,
    setStale,
    setProcessing,
    setProcessingError,
    renderCharacterBrowser,
    stopAllPlayback,
    destroy,
  };
}
