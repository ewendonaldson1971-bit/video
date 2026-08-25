import test from "node:test";
import assert from "node:assert/strict";
import { safeEqual, signToken, verifyToken } from "../netlify/functions/lib/security.mjs";

const secret = "a-strong-test-secret-that-is-long-enough";

test("signToken and verifyToken preserve valid claims", () => {
  const token = signToken({ sub: "user-1", app: "spark" }, secret, { audience: "vivad-video" });
  const claims = verifyToken(token, secret, { issuer: "vivad-video", audience: "vivad-video" });
  assert.equal(claims.sub, "user-1");
  assert.equal(claims.app, "spark");
});

test("verifyToken rejects a modified token", () => {
  const token = signToken({ sub: "user-1" }, secret);
  const modified = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.throws(() => verifyToken(modified, secret), /signature/);
});

test("safeEqual handles equal and unequal values", () => {
  assert.equal(safeEqual("same", "same"), true);
  assert.equal(safeEqual("same", "different"), false);
});
