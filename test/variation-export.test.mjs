// Node-side unit tests for js/variation-export.js - the pure ordering/naming logic behind the
// Stretch workspace's "export multiple character variations at once" feature.
// Run with: node test/variation-export.test.mjs
import assert from "node:assert/strict";
import { resolveVariationSet, variationFileName } from "../js/variation-export.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const ALL = [
  { key: "clean", label: "Clean" },
  { key: "tight", label: "Tight" },
  { key: "vintage", label: "Vintage" },
  { key: "glitch", label: "Glitch" },
  { key: "grain", label: "Grain" },
];

// --- resolveVariationSet ----------------------------------------------------------------------

test("resolveVariationSet: orders by the registry's own order, not Set insertion order", () => {
  const keys = new Set(["glitch", "clean", "vintage"]); // insertion order deliberately scrambled
  const result = resolveVariationSet(keys, ALL);
  assert.deepEqual(result.map((c) => c.key), ["clean", "vintage", "glitch"]);
});

test("resolveVariationSet: drops keys the registry no longer recognises", () => {
  const keys = new Set(["clean", "some-removed-character", "grain"]);
  const result = resolveVariationSet(keys, ALL);
  assert.deepEqual(result.map((c) => c.key), ["clean", "grain"]);
});

test("resolveVariationSet: de-duplicates repeated keys", () => {
  const keys = ["clean", "clean", "tight"]; // a plain array works too, not just a Set
  const result = resolveVariationSet(keys, ALL);
  assert.deepEqual(result.map((c) => c.key), ["clean", "tight"]);
});

test("resolveVariationSet: empty input -> empty output, never throws", () => {
  assert.deepEqual(resolveVariationSet([], ALL), []);
  assert.deepEqual(resolveVariationSet(new Set(), ALL), []);
});

test("resolveVariationSet: every character in the registry, in registry order", () => {
  const keys = new Set(ALL.map((c) => c.key));
  const result = resolveVariationSet(keys, ALL);
  assert.deepEqual(result, ALL);
});

// --- variationFileName -------------------------------------------------------------------------

test("variationFileName: base stem + character label + .wav, space-separated", () => {
  assert.equal(variationFileName("drum_take Cm 120bpm", "Glitch"), "drum_take Cm 120bpm Glitch.wav");
});

test("variationFileName: two different characters on the same stem produce two distinct names", () => {
  const a = variationFileName("loop", "Clean");
  const b = variationFileName("loop", "Vintage");
  assert.notEqual(a, b);
  assert.equal(a, "loop Clean.wav");
  assert.equal(b, "loop Vintage.wav");
});

console.log(`\n${passed} test(s) passed.`);
