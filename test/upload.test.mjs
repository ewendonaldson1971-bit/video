import test from "node:test";
import assert from "node:assert/strict";
import { patchTusChunk } from "../src/upload.js";

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
