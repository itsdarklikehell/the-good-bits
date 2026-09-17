// naming.js
//
// What a FLIP export is called. Pure, so the scheme can be asserted in a test rather than
// discovered by exporting a batch and looking in Finder.
//
// The format is `<source stem>_FLIP_<nn>_seed<n>.wav` - deliberately underscore-separated rather
// than following the space-separated "{stem} {word}.wav" the chop/stretch exports use. Those names
// are descriptive ("piano loop stretched.wav"); this one is an IDENTIFIER. The seed in the filename
// is the whole point: an interesting variation that got closed, reloaded or regenerated away is
// recoverable from its own filename, and the underscores keep the two numeric fields from blurring
// into the stem when the stem itself contains spaces and digits, which loop names invariably do.
import { sanitizeForPath, truncateStem } from "../dsp.js";

/** Filesystem-safe stem of a source filename, with the extension dropped. */
export function sourceStem(fileName) {
  const base = String(fileName || "loop").replace(/\.[^.]+$/, "");
  return sanitizeForPath(truncateStem(base, 60), 60) || "loop";
}

/**
 * One variation's filename.
 * @param {string} fileName  the source file's name, extension and all
 * @param {number} index     1-based position in the batch
 * @param {number} seed
 */
export function variationFileName(fileName, index, seed) {
  const nn = String(Math.max(1, Math.round(index))).padStart(2, "0");
  return `${sourceStem(fileName)}_FLIP_${nn}_seed${seed >>> 0}.wav`;
}

/** The folder (or zip) an Export All writes into. */
export function batchFolderName(fileName) {
  return `${sourceStem(fileName)}_FLIP`;
}

/** Avoid silently overwriting when two names collide - same "_2" scheme PLAY NICE uses. */
export function uniqueName(name, taken) {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot);
  let n = 2;
  let candidate = `${stem}_${n}${ext}`;
  while (taken.has(candidate)) candidate = `${stem}_${++n}${ext}`;
  taken.add(candidate);
  return candidate;
}
