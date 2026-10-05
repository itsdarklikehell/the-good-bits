// naming.js
//
// What a STRETCH FX export is called:
//
//   breakname_stretch_snare_300.wav
//   breakname_stretch_1-8_600_rev.wav
//   breakname_stretch_hit_400_dn12.wav
//
// Source type, stretch percent, then only the treatments that happened: `_rev` (reversed before
// stretching), `_revpost` (stretched, then reversed - the suck), `_dn12` / `_up7` (sampler pitch
// before stretching). Readable in a sampler's file browser, which is where these end up. The stem
// and the "_2" collision scheme are FLIP's, so the two features name things the same way.
import { sourceStem, uniqueName } from "../flip/naming.js";

export { uniqueName };

const SOURCE_SLUG = { snare: "snare", hit: "hit", "1/16": "1-16", "1/8": "1-8", "1/4": "1-4", manual: "sel" };

export function fxFileName(fileName, recipe) {
  const parts = [sourceStem(fileName), "stretch", SOURCE_SLUG[recipe.source.type] || "fx", String(Math.round(recipe.totalRatio * 100))];
  if (recipe.reverse === "pre") parts.push("rev");
  if (recipe.reverse === "post") parts.push("revpost");
  if (recipe.pitch) parts.push(recipe.pitch < 0 ? `dn${-recipe.pitch}` : `up${recipe.pitch}`);
  return `${parts.join("_")}.wav`;
}

/** The folder (or zip) an Export All writes into. */
export function fxFolderName(fileName) {
  return `${sourceStem(fileName)}_STRETCH_FX`;
}
