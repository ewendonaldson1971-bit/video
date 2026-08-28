import test from "node:test";
import assert from "node:assert/strict";
import {
  accessIsIndexable,
  accessRequiresSignedPlayback,
  modelMetadata,
  parseExternalVideoUrl,
  purposeDefaults,
  toCoreVideo,
  validateDirectMediaUrl,
} from "../netlify/functions/lib/model.mjs";

test("purpose templates supply reusable conservative defaults", () => {
  assert.deepEqual(purposeDefaults("website"), { purpose: "website", label: "Website content", access: "public", reviewStatus: "draft", indexable: true });
  assert.deepEqual(purposeDefaults("testing"), { purpose: "testing", label: "Testing", access: "organisation", reviewStatus: "draft", indexable: false });
  assert.equal(purposeDefaults("unknown").purpose, "general");
});

test("only public access is indexable and protected audiences require signed playback", () => {
  assert.equal(accessIsIndexable("public"), true);
  assert.equal(accessIsIndexable("link"), false);
  assert.equal(accessRequiresSignedPlayback("link"), false);
  assert.equal(accessRequiresSignedPlayback("client"), true);
});

test("legacy private metadata migrates to expiring access", () => {
  const core = toCoreVideo({ uid: "abc", requireSignedURLs: true, meta: { name: "Example", vivadVisibility: "private" } });
  assert.equal(core.access, "expiring");
  assert.equal(core.provider, "cloudflare");
});

test("model metadata preserves existing values and sanitises lengths", () => {
  const meta = modelMetadata({ name: "New", purpose: "sop", access: "team", tags: ["safety", "training"], chapters: [{ title: "Prepare", start: 0 }, { title: "Install", start: 30 }] }, { custom: "keep" });
  assert.equal(meta.custom, "keep");
  assert.equal(meta.vivadPurpose, "sop");
  assert.equal(meta.vivadAccess, "team");
  assert.equal(meta.vivadTags, "safety,training");
  assert.deepEqual(toCoreVideo({ uid: "abc", duration: 60, meta }).chapters, [{ title: "Prepare", start: 0 }, { title: "Install", start: 30 }]);
});

test("external URLs accept official providers without downloading content", () => {
  assert.deepEqual(parseExternalVideoUrl("https://youtu.be/dQw4w9WgXcQ"), { provider: "youtube", providerId: "dQw4w9WgXcQ", url: "https://youtu.be/dQw4w9WgXcQ" });
  assert.equal(parseExternalVideoUrl("https://vimeo.com/123456789").providerId, "123456789");
  assert.throws(() => parseExternalVideoUrl("https://example.com/watch?v=dQw4w9WgXcQ"), /official/);
});

test("direct imports reject local, credentialed and non-HTTPS targets", () => {
  assert.equal(validateDirectMediaUrl("https://media.example.com/video.mp4"), "https://media.example.com/video.mp4");
  assert.throws(() => validateDirectMediaUrl("http://example.com/video.mp4"), /HTTPS/);
  assert.throws(() => validateDirectMediaUrl("https://127.0.0.1/video.mp4"), /Private/);
  assert.throws(() => validateDirectMediaUrl("https://user:pass@example.com/video.mp4"), /credentials/);
});
