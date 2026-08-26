import test from "node:test";
import assert from "node:assert/strict";
import { STRAPI_VIDEO_FIELDS, createPublishingBundle, discourseSharePackage, isoDuration, slugify } from "../netlify/functions/lib/publishing.mjs";

const video = { id: "video1", provider: "cloudflare", providerId: "video1", title: "Knife Safety", description: "Safe handling training.", access: "public", duration: 125, createdAt: "2026-08-26T00:00:00Z", tags: ["safety"] };

test("publishing bundle creates indexable VideoObject, clips and sitemap data for public video", () => {
  const bundle = createPublishingBundle({ video, watchUrl: "https://video.example/?watch=video1", iframeUrl: "https://stream.example/video1/iframe", thumbnailUrl: "https://stream.example/video1/thumb.jpg", chapters: [{ title: "Prepare", start: 0 }, { title: "Cut", start: 30 }] });
  assert.equal(bundle.indexable, true);
  assert.equal(bundle.jsonLd["@type"], "VideoObject");
  assert.equal(bundle.jsonLd.duration, "PT2M5S");
  assert.equal(bundle.jsonLd.hasPart[1].startOffset, 30);
  assert.equal(bundle.strapiDraft.indexStatus, "index");
  assert.ok(STRAPI_VIDEO_FIELDS.every((field) => Object.hasOwn(bundle.strapiDraft, field)));
});

test("protected video publishing output is noindex", () => {
  const bundle = createPublishingBundle({ video: { ...video, access: "client" }, watchUrl: "https://video.example/share", iframeUrl: "https://stream.example/token/iframe", thumbnailUrl: "https://stream.example/token/thumb.jpg" });
  assert.equal(bundle.indexable, false);
  assert.equal(bundle.jsonLd, null);
  assert.equal(bundle.sitemap, null);
  assert.equal(bundle.robots, "noindex,nofollow");
});

test("Discourse output only emits raw iframe markup for public videos", () => {
  assert.match(discourseSharePackage({ title: "Video", watchUrl: "https://video.example", iframeUrl: "https://stream.example/iframe", isPublic: true }).iframe, /<iframe/);
  assert.equal(discourseSharePackage({ title: "Video", watchUrl: "https://video.example/share", iframeUrl: "https://stream.example/token/iframe", isPublic: false }).iframe, null);
});

test("publishing formatting helpers are stable", () => {
  assert.equal(slugify("Café & Knife Safety"), "cafe-knife-safety");
  assert.equal(isoDuration(3605), "PT1H5S");
});
