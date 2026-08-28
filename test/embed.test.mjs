import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createVivadVideoEmbedToken } from "../integration/create-embed-token.mjs";
import { verifyToken } from "../netlify/functions/lib/security.mjs";

const secret = "embed-secret-long-enough-for-testing";

test("embed token carries the signed reusable host contract", () => {
  const token = createVivadVideoEmbedToken({ secret, userId: "42", userName: "Ewen", app: "spark", origin: "https://spark.example.com", role: "editor", purpose: "client", customerId: "customer-1", projectId: "project-2", returnTo: "/projects/2" });
  const claim = verifyToken(token, secret, { issuer: "vivad-host", audience: "vivad-video" });
  assert.equal(claim.origin, "https://spark.example.com");
  assert.equal(claim.role, "editor");
  assert.equal(claim.purpose, "client");
  assert.equal(claim.context.projectId, "project-2");
});

test("embed token rejects wildcard or path-based origins", () => {
  assert.throws(() => createVivadVideoEmbedToken({ secret, userId: "42", app: "spark", origin: "https://*.example.com" }), /origin/);
  assert.throws(() => createVivadVideoEmbedToken({ secret, userId: "42", app: "spark", origin: "https://spark.example.com/path" }), /origin/);
});

test("production security policy permits every external video player", () => {
  const netlifyConfig = readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
  assert.match(netlifyConfig, /frame-src[^\n]*https:\/\/www\.youtube-nocookie\.com/);
  assert.match(netlifyConfig, /frame-src[^\n]*https:\/\/player\.vimeo\.com/);
});
