import test from "node:test";
import assert from "node:assert/strict";
import { normaliseChapters, normaliseEditRecipe, normaliseHighlights, parseStoredChapters } from "../netlify/functions/lib/editing.mjs";

test("chapters are sanitised, ordered and bounded by duration", () => {
  assert.deepEqual(normaliseChapters([{ title: " End ", start: 80 }, { title: "Start", start: 0 }, { title: "Duplicate", start: 0 }], 60), [
    { title: "Start", start: 0 }, { title: "End", start: 60 },
  ]);
  assert.deepEqual(parseStoredChapters("not-json", 60), []);
});

test("highlight ranges reject empty selections", () => {
  assert.deepEqual(normaliseHighlights([{ name: "Good", start: 2, end: 5 }, { name: "Bad", start: 8, end: 8 }], 10), [{ name: "Good", start: 2, end: 5 }]);
});

test("timeline recipes support clips, title cards and social aspect ratios", () => {
  const uid = "a".repeat(32);
  const recipe = normaliseEditRecipe({ aspectRatio: "9:16", captions: "burned", watermark: true, segments: [
    { type: "title", title: "Welcome", duration: 4 },
    { type: "clip", sourceUid: uid, start: 3, end: 8, transition: "crossfade" },
  ] }, { uid, duration: 20, name: "Training" });
  assert.equal(recipe.aspectRatio, "9:16");
  assert.equal(recipe.segments.length, 2);
  assert.equal(recipe.segments[1].transition, "crossfade");
});
