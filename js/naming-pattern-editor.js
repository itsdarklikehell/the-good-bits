// naming-pattern-editor.js
//
// A token/chip editor for the File Name Pattern setting. The canonical value is still the exact
// same plain string namingSettings.chopPattern has always been ({name}_{number}, and so on) - see
// js/naming-tokens.js for the pure string<->segment conversion this is built on. This file is only
// the DOM layer: a small "available tokens" button row plus a single-line contenteditable field
// where recognised {name}/{tag}/{number} placeholders render as atomic chip spans and everything
// else is normal editable text.
//
// The chip technique - a contenteditable="false" element nested inside a contenteditable="true"
// container - is deliberately the simplest thing that works: browsers already treat such a nested
// element as one atomic unit for caret movement AND for Backspace/Delete (removing the whole node
// in one step, never eating into it character by character), so "select/delete a token as one
// chunk" needs no custom keydown interception at all. That's the reason this reaches for
// contenteditable rather than, say, stacking several plain <input>s between chips: the atomic-node
// behaviour is exactly what a fragile custom implementation would otherwise have to reinvent.
//
// Token buttons insert via a mousedown-preventDefault trick (see the button wiring below) rather
// than saving/restoring a Range: preventing the button's mousedown from taking focus means the
// contenteditable's own selection is simply never disturbed, so "insert at the current logical
// caret position" falls out for free from the browser's own selection state.
import { parsePatternToSegments, segmentsToPattern } from "./naming-tokens.js";

const TOKEN_META = [
  { key: "name", label: "{name}", title: "The source file's name" },
  { key: "folder", label: "{folder}", title: "The folder the source file came from - tells stems apart when every file is called other.m4a" },
  { key: "tag", label: "{tag}", title: "Detected key + tempo combined, e.g. Cm 120bpm" },
  { key: "key", label: "{key}", title: "Detected musical key alone, e.g. Cm" },
  { key: "tempo", label: "{tempo}", title: "Detected tempo alone, e.g. 120" },
  { key: "number", label: "{number}", title: "Chop number - always added if missing" },
];

/**
 * @param {object} opts
 * @param {string} opts.initialValue
 * @param {(pattern:string) => void} opts.onChange  fired only for user edits, never for setValue()
 * @param {string[]} [opts.tokens]  restricts the insert-button row to these token keys (parsing/
 *   rendering still recognises every token in NAMING_TOKENS regardless - this only hides a button
 *   whose token wouldn't mean anything in this particular field, e.g. {number} in a folder-name
 *   pattern that names one source, not one chop). Defaults to every token in naming-tokens.js.
 */
export function createNamingPatternEditor({ initialValue = "", onChange = () => {}, tokens = null }) {
  const wrap = document.createElement("div");
  wrap.className = "naming-pattern-editor-wrap";

  const tokenRow = document.createElement("div");
  tokenRow.className = "naming-token-row";
  wrap.appendChild(tokenRow);

  const field = document.createElement("div");
  field.className = "naming-pattern-editor";
  field.contentEditable = "true";
  field.spellcheck = false;
  field.setAttribute("role", "textbox");
  field.setAttribute("aria-multiline", "false");
  field.setAttribute("aria-label", "File name pattern");
  field.dataset.placeholder = "{number}";
  wrap.appendChild(field);

  function makeChip(key) {
    const chip = document.createElement("span");
    chip.className = "naming-chip";
    chip.contentEditable = "false";
    chip.dataset.token = key;
    const label = document.createElement("span");
    label.className = "naming-chip-label";
    label.textContent = `{${key}}`;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "naming-chip-remove";
    removeBtn.textContent = "×";
    removeBtn.title = `Remove {${key}}`;
    removeBtn.tabIndex = -1;
    removeBtn.addEventListener("mousedown", (ev) => ev.preventDefault());
    removeBtn.addEventListener("click", () => {
      chip.remove();
      sync();
      field.focus();
    });
    chip.append(label, removeBtn);
    return chip;
  }

  /** Rebuilds the field's chips/text from a pattern string. Used for both initial mount and setValue(). */
  function render(pattern) {
    field.innerHTML = "";
    for (const seg of parsePatternToSegments(pattern)) {
      field.appendChild(seg.type === "token" ? makeChip(seg.key) : document.createTextNode(seg.value));
    }
  }

  /** Reads the field's current chips/text back into the canonical pattern string. */
  function domToPattern() {
    const segments = [];
    for (const node of field.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent) segments.push({ type: "text", value: node.textContent });
      } else if (node.nodeType === Node.ELEMENT_NODE && node.dataset && node.dataset.token) {
        segments.push({ type: "token", key: node.dataset.token });
      } else if (node.nodeType === Node.ELEMENT_NODE && node.textContent) {
        // Defensive: some browsers can wrap content in a stray element on odd edit operations even
        // with Enter suppressed below - its text still belongs in the pattern rather than vanishing.
        segments.push({ type: "text", value: node.textContent });
      }
    }
    return segmentsToPattern(segments);
  }

  let lastValue = initialValue || "";

  function sync() {
    const value = domToPattern();
    if (value === lastValue) return;
    lastValue = value;
    onChange(value);
  }

  /** Inserts `node` at the field's current selection (falling back to the end if there isn't one - e.g. before the field has ever had focus), leaving the caret right after it. */
  function insertAtCaret(node) {
    field.focus();
    const sel = window.getSelection();
    let range;
    if (sel && sel.rangeCount > 0 && field.contains(sel.anchorNode)) {
      range = sel.getRangeAt(0);
    } else {
      range = document.createRange();
      range.selectNodeContents(field);
      range.collapse(false);
    }
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.setEndAfter(node);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function insertToken(key) {
    insertAtCaret(makeChip(key));
    sync();
  }

  const tokenMeta = tokens ? TOKEN_META.filter((t) => tokens.includes(t.key)) : TOKEN_META;
  for (const t of tokenMeta) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "naming-token-btn";
    btn.textContent = t.label;
    btn.title = `Insert ${t.label} - ${t.title}`;
    // Keeps focus (and the field's live selection/caret) in the editor rather than moving it to
    // this button - see the file header comment.
    btn.addEventListener("mousedown", (ev) => ev.preventDefault());
    btn.addEventListener("click", () => insertToken(t.key));
    tokenRow.appendChild(btn);
  }

  field.addEventListener("input", sync);
  field.addEventListener("keydown", (ev) => {
    // Single-line field: a literal Enter would insert a <div>/<br> most browsers use for
    // paragraph breaks, which breaks the flat text/chip walk domToPattern() relies on.
    if (ev.key === "Enter") ev.preventDefault();
  });
  field.addEventListener("paste", (ev) => {
    ev.preventDefault();
    const text = (ev.clipboardData || window.clipboardData).getData("text/plain");
    if (!text) return;
    insertAtCaret(document.createTextNode(text));
    sync();
  });
  // Typed braces (rather than a token button click) stay literal text while focused - converting
  // mid-type would mean re-rendering the DOM under a live caret, which is exactly the kind of
  // contenteditable fragility worth avoiding. Blur is a safe point to normalise: focus has already
  // left, so there's no caret position to preserve, and a pattern typed by hand still ends up
  // showing recognised tokens as chips from then on.
  field.addEventListener("blur", () => {
    render(lastValue);
  });

  render(initialValue);

  return {
    el: wrap,
    getValue: () => lastValue,
    /** Programmatic set (e.g. restoring saved settings) - does NOT fire onChange, matching the rest of this app's setRegions()-style setters. */
    setValue: (pattern) => {
      lastValue = pattern || "";
      render(lastValue);
    },
    focus: () => field.focus(),
  };
}
