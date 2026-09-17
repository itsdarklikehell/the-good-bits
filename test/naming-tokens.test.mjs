// Node-side unit tests for js/naming-tokens.js - the pure string<->segment conversion behind the
// File Name Pattern token editor. Run with: node test/naming-tokens.test.mjs
import assert from "node:assert/strict";
import { parsePatternToSegments, segmentsToPattern, isKnownToken, resolveNamePattern, resolveFolderName } from "../js/naming-tokens.js";

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

test("parsePatternToSegments: plain literal text with no tokens", () => {
  assert.deepEqual(parsePatternToSegments("AMFAS_"), [{ type: "text", value: "AMFAS_" }]);
});

test("parsePatternToSegments: a single token", () => {
  assert.deepEqual(parsePatternToSegments("{number}"), [{ type: "token", key: "number" }]);
});

test("parsePatternToSegments: token then literal text", () => {
  assert.deepEqual(parsePatternToSegments("{name}_{number}"), [
    { type: "token", key: "name" },
    { type: "text", value: "_" },
    { type: "token", key: "number" },
  ]);
});

test("parsePatternToSegments: literal text around a token, and between two tokens", () => {
  assert.deepEqual(parsePatternToSegments("AMFAS_{name}_{number}"), [
    { type: "text", value: "AMFAS_" },
    { type: "token", key: "name" },
    { type: "text", value: "_" },
    { type: "token", key: "number" },
  ]);
  assert.deepEqual(parsePatternToSegments("{tag} - {name}"), [
    { type: "token", key: "tag" },
    { type: "text", value: " - " },
    { type: "token", key: "name" },
  ]);
  assert.deepEqual(parsePatternToSegments("{name} processed {number}"), [
    { type: "token", key: "name" },
    { type: "text", value: " processed " },
    { type: "token", key: "number" },
  ]);
});

test("parsePatternToSegments: tokens are recognised case-insensitively but normalised to lowercase", () => {
  assert.deepEqual(parsePatternToSegments("{NAME}_{Number}"), [
    { type: "token", key: "name" },
    { type: "text", value: "_" },
    { type: "token", key: "number" },
  ]);
});

test("parsePatternToSegments: an unrecognised brace stays literal text, not a token", () => {
  assert.deepEqual(parsePatternToSegments("{foo}_{name}"), [
    { type: "text", value: "{foo}_" },
    { type: "token", key: "name" },
  ]);
});

test("parsePatternToSegments: empty pattern is an empty segment list", () => {
  assert.deepEqual(parsePatternToSegments(""), []);
  assert.deepEqual(parsePatternToSegments(null), []);
  assert.deepEqual(parsePatternToSegments(undefined), []);
});

test("segmentsToPattern: inverse of parsePatternToSegments for every case above", () => {
  const cases = ["AMFAS_", "{number}", "{name}_{number}", "AMFAS_{name}_{number}", "{tag} - {name}", "{name} processed {number}", ""];
  for (const pattern of cases) {
    assert.equal(segmentsToPattern(parsePatternToSegments(pattern)), pattern, `round-trip failed for ${JSON.stringify(pattern)}`);
  }
});

test("segmentsToPattern: case-normalised tokens round-trip to the lowercase canonical form (not the original casing)", () => {
  assert.equal(segmentsToPattern(parsePatternToSegments("{NAME}_{Number}")), "{name}_{number}");
});

test("isKnownToken: recognises name/tag/key/tempo/number, case-insensitively, and nothing else", () => {
  assert.ok(isKnownToken("name"));
  assert.ok(isKnownToken("TAG"));
  assert.ok(isKnownToken("Number"));
  assert.ok(isKnownToken("key"));
  assert.ok(isKnownToken("KEY"));
  assert.ok(isKnownToken("tempo"));
  assert.ok(isKnownToken("Tempo"));
  assert.ok(!isKnownToken("foo"));
  assert.ok(!isKnownToken(""));
});

test("parsePatternToSegments: {tempo} and {key} parse as independent tokens, same as {tag}", () => {
  assert.deepEqual(parsePatternToSegments("{name}_{tempo}_{key}_{number}"), [
    { type: "token", key: "name" },
    { type: "text", value: "_" },
    { type: "token", key: "tempo" },
    { type: "text", value: "_" },
    { type: "token", key: "key" },
    { type: "text", value: "_" },
    { type: "token", key: "number" },
  ]);
});

// --- resolveNamePattern: the actual filename-token substitution ---------------------------------

test("resolveNamePattern: a pattern using both {tempo} and {key} independently", () => {
  assert.equal(
    resolveNamePattern("{name}_{tempo}_{key}_{number}", { name: "vocal", tempo: "120", key: "Cm", number: "01" }),
    "vocal_120_Cm_01"
  );
});

test("resolveNamePattern: {tempo} without {key} - the other token is simply absent, not forced in", () => {
  assert.equal(resolveNamePattern("{name}_{tempo}_{number}", { name: "vocal", tempo: "120", number: "01" }), "vocal_120_01");
});

test("resolveNamePattern: {key} without {tempo}", () => {
  assert.equal(resolveNamePattern("{name}_{key}_{number}", { name: "vocal", key: "Cm", number: "01" }), "vocal_Cm_01");
});

test("resolveNamePattern: neither {tempo} nor {key} - unaffected, same as before either existed", () => {
  assert.equal(resolveNamePattern("{name}_{number}", { name: "vocal", tempo: "120", key: "Cm", number: "01" }), "vocal_01");
});

test("resolveNamePattern: the combined {tag} token still works unchanged, independently of {tempo}/{key}", () => {
  assert.equal(
    resolveNamePattern("{name}_{tag}_{number}", { name: "vocal", tag: "Cm 120bpm", tempo: "120", key: "Cm", number: "01" }),
    "vocal_Cm 120bpm_01"
  );
});

test("resolveNamePattern: {tag}, {tempo} and {key} can all coexist in one pattern", () => {
  assert.equal(
    resolveNamePattern("{tag}_{tempo}_{key}_{number}", { tag: "Cm 120bpm", tempo: "120", key: "Cm", number: "01" }),
    "Cm 120bpm_120_Cm_01"
  );
});

test("resolveNamePattern: an undetected {tempo}/{key} (undefined) drops out as empty text, not a literal token", () => {
  assert.equal(resolveNamePattern("{name}_{tempo}_{key}_{number}", { name: "vocal", number: "01" }), "vocal___01");
});

test("resolveNamePattern: tokens are matched case-insensitively, same as parsePatternToSegments", () => {
  assert.equal(resolveNamePattern("{NAME}_{Tempo}_{KEY}_{number}", { name: "vocal", tempo: "120", key: "Cm", number: "01" }), "vocal_120_Cm_01");
});

test("resolveNamePattern: an unrecognised {foo} is left literal, same as parsePatternToSegments", () => {
  assert.equal(resolveNamePattern("{foo}_{name}", { name: "vocal" }), "{foo}_vocal");
});

// --- resolveFolderName: the folder-name pattern resolution (js/app.js's buildTaggedStem) ----------

test("resolveFolderName: {name} and {key} both present", () => {
  assert.equal(resolveFolderName("{name} {key}", { name: "rhodes_loop", tag: "Cm 120bpm", key: "Cm", tempo: "120" }), "rhodes_loop Cm");
});

test("resolveFolderName: {name} and {tempo} both present", () => {
  assert.equal(resolveFolderName("{name} {tempo}bpm", { name: "drum_take", tag: "Cm 120bpm", key: "Cm", tempo: "120" }), "drum_take 120bpm");
});

test("resolveFolderName: {name}, {key} and {tempo} all present", () => {
  assert.equal(
    resolveFolderName("{name} {key} {tempo}bpm", { name: "rhodes_loop", tag: "Cm 120bpm", key: "Cm", tempo: "120" }),
    "rhodes_loop Cm 120bpm"
  );
});

test("resolveFolderName: neither {key} nor {tempo} - plain {name} pattern", () => {
  assert.equal(resolveFolderName("{name}", { name: "drum_take", tag: "", key: "", tempo: "" }), "drum_take");
});

test("resolveFolderName: missing key cleans up rather than leaving 'undefined' or a doubled space", () => {
  assert.equal(resolveFolderName("{name} {key} {tempo}bpm", { name: "drum_take", tag: "120bpm", key: "", tempo: "120" }), "drum_take 120bpm");
});

test("resolveFolderName: missing tempo cleans up the same way", () => {
  assert.equal(resolveFolderName("{name} {key} {tempo}bpm", { name: "drum_take", tag: "Cm", key: "Cm", tempo: "" }), "drum_take Cm bpm");
});

test("resolveFolderName: both key and tempo missing - falls all the way back to the bare name, not an empty string", () => {
  assert.equal(resolveFolderName("{name} {key} {tempo}bpm", { name: "drum_take", tag: "", key: "", tempo: "" }), "drum_take bpm");
  assert.equal(resolveFolderName("{key} {tempo}", { name: "drum_take", tag: "", key: "", tempo: "" }), "drum_take");
});

test("resolveFolderName: an empty/blank pattern falls back to {name}", () => {
  assert.equal(resolveFolderName("", { name: "drum_take", tag: "", key: "", tempo: "" }), "drum_take");
  assert.equal(resolveFolderName("   ", { name: "drum_take", tag: "", key: "", tempo: "" }), "drum_take");
});

test("resolveFolderName: the legacy combined {tag} token still works, independently of {key}/{tempo}", () => {
  assert.equal(resolveFolderName("{name} {tag}", { name: "drum_take", tag: "Cm 120bpm", key: "Cm", tempo: "120" }), "drum_take Cm 120bpm");
});

test("resolveFolderName: {number} is not a recognised part of this call's contract - a stray one resolves to empty like any other missing token", () => {
  assert.equal(resolveFolderName("{name} {number}", { name: "drum_take", tag: "", key: "", tempo: "" }), "drum_take");
});

test("{folder} resolves to the source's own folder, telling identically-named stems apart", () => {
  const pattern = "{folder} {name} {tag}";
  assert.equal(
    resolveFolderName(pattern, { folder: "1971 Sax Warm-Up", name: "other", tag: "Cm 88bpm" }),
    "1971 Sax Warm-Up other Cm 88bpm"
  );
  // Loose files have no folder of their own; the token drops out without leaving a double space.
  assert.equal(resolveFolderName(pattern, { folder: "", name: "other", tag: "Cm 88bpm" }), "other Cm 88bpm");
});

test("{folder} is a real token in patterns, not literal text", () => {
  assert.deepEqual(parsePatternToSegments("{folder}/{number}"), [
    { type: "token", key: "folder" },
    { type: "text", value: "/" },
    { type: "token", key: "number" },
  ]);
  assert.ok(isKnownToken("folder"));
  assert.equal(resolveNamePattern("{folder}_{number}", { folder: "take2", number: "01" }), "take2_01");
});

console.log(`\n${passed} test(s) passed.`);
