import test from "node:test";
import assert from "node:assert/strict";
import { clearRateLimitsForTests, enforceRateLimit } from "../netlify/functions/lib/rate-limit.mjs";

test("rate limiter separates scopes and rejects excess requests", () => {
  clearRateLimitsForTests();
  const request = new Request("https://video.example/api", { headers: { "x-nf-client-connection-ip": "203.0.113.7" } });
  assert.equal(enforceRateLimit(request, "login", { limit: 2, windowMs: 60_000 }).remaining, 1);
  assert.equal(enforceRateLimit(request, "login", { limit: 2, windowMs: 60_000 }).remaining, 0);
  assert.throws(() => enforceRateLimit(request, "login", { limit: 2, windowMs: 60_000 }), (error) => error.status === 429 && error.retryAfter > 0);
  assert.equal(enforceRateLimit(request, "email", { limit: 1, windowMs: 60_000 }).remaining, 0);
});
