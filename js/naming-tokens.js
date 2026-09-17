// naming-tokens.js
//
// Pure string <-> segment conversion behind the File Name Pattern token editor
// (js/naming-pattern-editor.js), plus resolveNamePattern() itself - the substitution resolveNamePattern
// performs on export is the exact same thing this module's parse/segments round-trip needs to agree
// with, so it lives here rather than duplicated in app.js. No DOM in this file on purpose - the
// editor is a presentation/editing layer over the exact same plain string app.js has always stored
// in namingSettings.chopPattern and fed to resolveNamePattern()/buildChopFileName(); this module is
// what keeps the two directions (string -> chips for display, chips -> string for storage/export)
// in exact agreement, and it's simple enough to unit-test without a browser.
//
// Recognised tokens are name, folder, tag, key, tempo, number - matched case-insensitively. {folder}
// is the source file's own parent folder name, which is what tells two files apart when a batch is
// full of stem exports that are all called "other.m4a" or "drums.m4a". {tag} is the
// original combined "Cm 120bpm"-style key+tempo tag (still fully supported: existing saved patterns
// using it, e.g. the legacy "{name} {tag} {number}" preset, keep working exactly as before). {key}
// and {tempo} are the same detected values split into two independent tokens, so a pattern can use
// either, both, or neither without being forced to pull in the other - see buildChopFileName() in
// app.js for how each is formatted. Anything else in braces (typos, a stray literal "{foo}") is left
// as plain text: it was never a valid token before this editor existed, and turning it into one
// would change what gets exported.

export const NAMING_TOKENS = ["name", "folder", "tag", "key", "tempo", "number"];

const TOKEN_RE = /\{(name|folder|tag|key|tempo|number)\}/gi;

/**
 * Splits a pattern string into an ordered list of segments: {type:"token", key:"name"|"tag"|"number"}
 * for a recognised placeholder (key is always lowercase, regardless of the source casing), or
 * {type:"text", value} for everything else, including any unrecognised "{...}". Adjacent text runs
 * are never split - only genuine token boundaries break a segment.
 */
export function parsePatternToSegments(pattern) {
  const segments = [];
  const str = pattern || "";
  let lastIndex = 0;
  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(str))) {
    if (match.index > lastIndex) segments.push({ type: "text", value: str.slice(lastIndex, match.index) });
    segments.push({ type: "token", key: match[1].toLowerCase() });
    lastIndex = TOKEN_RE.lastIndex;
  }
  if (lastIndex < str.length) segments.push({ type: "text", value: str.slice(lastIndex) });
  return segments;
}

/** Inverse of parsePatternToSegments: joins segments back into the canonical pattern string. */
export function segmentsToPattern(segments) {
  return segments.map((s) => (s.type === "token" ? `{${s.key}}` : s.value)).join("");
}

/** True if `key` is one of the tokens this editor (and resolveNamePattern) recognises. */
export function isKnownToken(key) {
  return NAMING_TOKENS.includes(String(key).toLowerCase());
}

/**
 * Substitutes {name}/{folder}/{tag}/{key}/{tempo}/{number} tokens (case-insensitively) in a typed naming
 * pattern. A token missing from `tokens` (e.g. {key} when nothing was detected) resolves to "" -
 * same fallback for every token, so an unmatched token just quietly drops out rather than leaving a
 * literal "{key}" in the exported filename.
 */
export function resolveNamePattern(template, tokens) {
  return template.replace(TOKEN_RE, (match, key) => {
    const value = tokens[key.toLowerCase()];
    return value === undefined || value === null ? "" : String(value);
  });
}

/**
 * Resolves a FOLDER/base-name pattern - the same {name}/{folder}/{tag}/{key}/{tempo} tokens a filename
 * pattern uses, minus {number} (a source's own output folder has no per-chop number to add, unlike
 * buildChopFileName's filenames - see js/app.js's buildTaggedStem, the one caller). Falls back to
 * "{name}" for an empty/blank pattern, and collapses the run of whitespace a missing token can leave
 * behind (e.g. "{name} {key} {tempo}bpm" with no key detected) the same way buildChopFileName already
 * does for filenames, so a source with unavailable metadata still produces a clean name instead of
 * doubled spaces or a dangling separator. Falls back to the bare source name if the resolved pattern
 * is empty outright (e.g. a pattern that's only tokens, all of which are unavailable).
 */
export function resolveFolderName(pattern, tokens) {
  const template = (pattern || "").trim() || "{name}";
  const resolved = resolveNamePattern(template, tokens).replace(/\s+/g, " ").trim();
  return resolved || tokens.name || "";
}
