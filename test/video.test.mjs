import test from "node:test";
import assert from "node:assert/strict";
import { canAccessVideo, configuredAllowedOrigins, creatorFor, normaliseVideoList, normaliseVisibility, originAllowsHostname, privacyFields, toTusMetadata, visibilityFromVideo } from "../netlify/functions/lib/video.mjs";

test("visibility defaults to expiring protected playback", () => {
  assert.equal(normaliseVisibility("unknown"), "expiring");
  assert.equal(privacyFields("private").requireSignedURLs, true);
  assert.equal(privacyFields("public").requireSignedURLs, false);
});

test("empty origin configuration explicitly allows playback on any domain", () => {
  assert.deepEqual(configuredAllowedOrigins("", "customer-example.cloudflarestream.com"), []);
});

test("configured origins are normalised and include the Stream player host", () => {
  assert.deepEqual(
    configuredAllowedOrigins("https://vivad-video.netlify.app/, vivadspark.netlify.app", "customer-example.cloudflarestream.com"),
    ["vivad-video.netlify.app", "vivadspark.netlify.app", "customer-example.cloudflarestream.com"],
  );
});

test("restricted origins always include the Vivad Video application host", () => {
  assert.deepEqual(
    configuredAllowedOrigins("videos.vivad.com.au", "customer-example.cloudflarestream.com", "vivad-video.netlify.app"),
    ["videos.vivad.com.au", "vivad-video.netlify.app", "customer-example.cloudflarestream.com"],
  );
});

test("origin restrictions recognise exact hosts and Cloudflare wildcard semantics", () => {
  assert.equal(originAllowsHostname([], "vivad-video.netlify.app"), true);
  assert.equal(originAllowsHostname(["vivad-video.netlify.app"], "vivad-video.netlify.app"), true);
  assert.equal(originAllowsHostname(["*.vivad.com.au"], "spark.vivad.com.au"), true);
  assert.equal(originAllowsHostname(["*.vivad.com.au"], "vivad.com.au"), false);
  assert.equal(originAllowsHostname(["old.example"], "vivad-video.netlify.app"), false);
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
  assert.equal(visibilityFromVideo({ requireSignedURLs: true }), "expiring");
  assert.equal(visibilityFromVideo({ scheduledDeletion: "2030-01-01T00:00:00Z" }), "temporary");
});

test("tus metadata encodes values and flag keys", () => {
  const metadata = toTusMetadata({ name: "example.mov", requiresignedurls: true });
  assert.match(metadata, /^name [A-Za-z0-9+/=]+,requiresignedurls$/);
});

test("video lists accept both Cloudflare response shapes", () => {
  const videos = [{ uid: "video-1" }];
  assert.deepEqual(normaliseVideoList(videos), videos);
  assert.deepEqual(normaliseVideoList({ videos }), videos);
  assert.deepEqual(normaliseVideoList(null), []);
});

test("video ownership prevents ordinary users managing another user's upload", () => {
  const owner = { sub: "owner@example.com", app: "standalone", role: "editor" };
  const otherUser = { sub: "other@example.com", app: "standalone", role: "editor" };
  const video = { creator: creatorFor(owner) };
  assert.equal(canAccessVideo(owner, video), true);
  assert.equal(canAccessVideo(otherUser, video), false);
  assert.equal(canAccessVideo({ ...otherUser, role: "admin" }, video), true);
});
