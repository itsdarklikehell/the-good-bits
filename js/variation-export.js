// variation-export.js
//
// Pure logic behind "export multiple stretch-character variations of a loop at once" (the Stretch
// workspace's character browser, js/stretch-workspace.js, wired up in app.js's
// renderStretchCharacterBrowser). Kept out of app.js for the same reason js/chop-regions.js and
// js/tempo-override.js are: it's a plain decision - which characters to render, what to call each
// file - with no DOM, decode, or DSP in it, so it can be unit-tested without a browser.
//
// The set of checked characters lives in app.js as a Set of keys (cheap membership checks as
// checkboxes are clicked), but a Set has no defined iteration order and can outlive a character
// that characters.js later renames or removes (a stale save, or a mid-session registry change in
// dev). Neither is safe to hand straight to a batch export: order needs to be deterministic so a
// repeated export and the on-screen "N variations selected" legend always agree, and an unknown key
// needs to disappear quietly rather than crash or render as an empty label.

/**
 * Resolves a raw collection of character keys into the ordered, de-duplicated list an export
 * should actually produce - in the character registry's own group/display order, not whatever
 * order the keys happen to iterate in.
 * @param {Iterable<string>} keys - e.g. the raw Set of checked character keys
 * @param {{key:string, label:string}[]} allCharacters - flat list in registry display order (see
 *   characterGroups() in js/dsp/stretch/characters.js - flatMap its `.characters` to get this)
 * @returns {{key:string, label:string}[]}
 */
export function resolveVariationSet(keys, allCharacters) {
  const wanted = new Set(keys);
  return allCharacters.filter((c) => wanted.has(c.key));
}

/**
 * The filename for one variation - the same "{base} {word}.wav" scheme the single-character
 * derived copy already uses for its own suffix ("{taggedStem} stretched.wav"), just naming the
 * character instead of the generic word "stretched".
 */
export function variationFileName(baseStem, characterLabel) {
  return `${baseStem} ${characterLabel}.wav`;
}
