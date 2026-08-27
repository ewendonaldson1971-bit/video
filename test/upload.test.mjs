import test from "node:test";
import assert from "node:assert/strict";
import { isAbandonedUpload, patchTusChunk, ticketIsExpired, uploadStorageKey } from "../src/upload.js";

class FakeUploadTarget {
  addEventListener(type, handler) { this[type] = handler; }
}

class SuccessfulRequest {
  constructor() {
    this.upload = new FakeUploadTarget();
    this.listeners = {};
    SuccessfulRequest.instance = this;
  }

  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(name, value) { (this.headers ||= {})[name] = value; }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  getResponseHeader(name) { return name === "Upload-Offset" ? "60" : null; }
  send(chunk) {
    this.chunk = chunk;
    this.upload.progress({ lengthComputable: true, loaded: 25 });
    this.status = 204;
    this.listeners.load();
  }
}

test("TUS chunk uploads report byte-level progress before completion", async () => {
  const progress = [];
  const chunk = new Blob(["video"]);
  const result = await patchTusChunk("https://upload.example/video", chunk, 10, 100, (value) => progress.push(value), SuccessfulRequest);
  assert.deepEqual(progress, [35]);
  assert.deepEqual(result, { ok: true, status: 204, uploadOffset: 60 });
  assert.equal(SuccessfulRequest.instance.method, "PATCH");
  assert.equal(SuccessfulRequest.instance.headers["Tus-Resumable"], "1.0.0");
  assert.equal(SuccessfulRequest.instance.headers["Upload-Offset"], "10");
  assert.equal(SuccessfulRequest.instance.chunk, chunk);
});

test("resumable upload tickets use a stable file identity and honour expiry", () => {
  const file = { name: "training.mov", size: 1234, lastModified: 5678 };
  assert.equal(uploadStorageKey(file), "vivad-video-upload:training.mov:1234:5678");
  assert.equal(ticketIsExpired({ uploadExpiry: "2026-01-01T00:00:00Z" }, Date.parse("2026-01-02T00:00:00Z")), true);
  assert.equal(ticketIsExpired({ uploadExpiry: "2026-01-03T00:00:00Z" }, Date.parse("2026-01-02T00:00:00Z")), false);
  assert.equal(ticketIsExpired({}, Date.parse("2026-01-02T00:00:00Z")), false);
});

test("only expired pending uploads are marked abandoned", () => {
  const now = Date.parse("2026-08-27T12:00:00Z");
  assert.equal(isAbandonedUpload({ status: { state: "pendingupload" }, uploadExpiry: "2026-08-27T11:00:00Z" }, now), true);
  assert.equal(isAbandonedUpload({ status: { state: "pendingupload" }, uploadExpiry: "2026-08-27T13:00:00Z" }, now), false);
  assert.equal(isAbandonedUpload({ status: { state: "inprogress" }, uploadExpiry: "2026-08-27T11:00:00Z" }, now), false);
  assert.equal(isAbandonedUpload({ status: { state: "pendingupload" }, created: "2026-08-27T09:00:00Z" }, now), true);
});
