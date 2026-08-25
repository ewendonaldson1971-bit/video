import test from "node:test";
import assert from "node:assert/strict";
import { normaliseVisibility, privacyFields, toTusMetadata, visibilityFromVideo } from "../netlify/functions/lib/video.mjs";

test("visibility defaults to private", () => {
  assert.equal(normaliseVisibility("unknown"), "private");
  assert.equal(privacyFields("private").requireSignedURLs, true);
  assert.equal(privacyFields("public").requireSignedURLs, false);
});

test("temporary videos are private and scheduled at least 30 days away", () => {
  const result = privacyFields("temporary", 1);
  assert.equal(result.visibility, "temporary");
  assert.equal(result.requireSignedURLs, true);
  assert.equal(result.temporaryDays, 30);
  assert.ok(new Date(result.scheduledDeletion).getTime() > Date.now() + 30 * 86400000);
});

test("visibility can be inferred from Cloudflare video data", () => {
  assert.equal(visibilityFromVideo({ requireSignedURLs: false }), "public");
  assert.equal(visibilityFromVideo({ requireSignedURLs: true }), "private");
  assert.equal(visibilityFromVideo({ scheduledDeletion: "2030-01-01T00:00:00Z" }), "temporary");
});

test("tus metadata encodes values and flag keys", () => {
  const metadata = toTusMetadata({ name: "example.mov", requiresignedurls: true });
  assert.match(metadata, /^name [A-Za-z0-9+/=]+,requiresignedurls$/);
});
