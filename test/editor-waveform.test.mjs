// Node-side unit tests for the pure, DOM-free parts of js/editor-waveform.js.
// Run with: node test/editor-waveform.test.mjs
import assert from "node:assert/strict";
import { viewXToTime, formatEditorTime, normalizeSnapMode, SNAP_OPTIONS } from "../js/editor-waveform.js";

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

// --- viewXToTime (double-click-to-split's canvas-X -> file-time conversion) -------------------

test("viewXToTime: unzoomed, unpanned - maps linearly across the full duration", () => {
  assert.equal(viewXToTime(0, 600, 0, 4), 0);
  assert.equal(viewXToTime(300, 600, 0, 4), 2);
  assert.equal(viewXToTime(600, 600, 0, 4), 4);
});

test("viewXToTime: correct split time under a non-zero viewStart (panned)", () => {
  // Viewing the [10, 14] window of a longer file - the midpoint of the canvas must map to 12, not 2.
  assert.equal(viewXToTime(300, 600, 10, 4), 12);
});

test("viewXToTime: correct split time when zoomed in (small viewDuration)", () => {
  // Zoomed into a 0.1s window starting at 2.3s - a quarter of the way across is 2.325s.
  const t = viewXToTime(150, 600, 2.3, 0.1);
  assert.ok(Math.abs(t - 2.325) < 1e-9, `expected ~2.325, got ${t}`);
});

test("viewXToTime: zero-width canvas falls back to viewStart rather than dividing by zero", () => {
  assert.equal(viewXToTime(50, 0, 3, 4), 3);
});

test("formatEditorTime: sub-minute durations render as seconds", () => {
  assert.equal(formatEditorTime(2.3), "2.30s");
});

test("formatEditorTime: minute-plus durations render as m:ss.ss", () => {
  assert.equal(formatEditorTime(65.5), "1:05.50");
});

test("normalizeSnapMode: keeps valid granularities, maps the old Beat setting and junk", () => {
  for (const [v] of SNAP_OPTIONS) assert.equal(normalizeSnapMode(v), v);
  assert.equal(normalizeSnapMode("beat"), "1/4");
  assert.equal(normalizeSnapMode(null), "bar");
  assert.equal(normalizeSnapMode("nonsense"), "bar");
});

console.log(`\n${passed} test(s) passed.`);
