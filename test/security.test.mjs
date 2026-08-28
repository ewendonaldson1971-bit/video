import test from "node:test";
import assert from "node:assert/strict";
import { createSession, safeEqual, signToken, verifyToken } from "../netlify/functions/lib/security.mjs";

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

test("createSession replaces stale standard claims when renewing a session", () => {
  const previousSecret = process.env.SESSION_SIGNING_SECRET;
  process.env.SESSION_SIGNING_SECRET = secret;
  try {
    const token = createSession({
      sub: "user-1",
      email: "person@example.com",
      iat: 1,
      exp: 2,
      iss: "old-issuer",
      aud: "old-audience",
    });
    const claims = verifyToken(token, secret, {
      issuer: "vivad-video",
      audience: "vivad-video-session",
    });
    assert.equal(claims.sub, "user-1");
    assert.equal(claims.email, "person@example.com");
    assert.ok(claims.exp > Math.floor(Date.now() / 1000) + (7 * 60 * 60));
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SIGNING_SECRET;
    else process.env.SESSION_SIGNING_SECRET = previousSecret;
  }
});
