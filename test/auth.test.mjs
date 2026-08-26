import test from "node:test";
import assert from "node:assert/strict";
import { authenticateStandalone, authenticationProvider } from "../netlify/functions/lib/auth.mjs";

const env = {
  AUTH_PROVIDER: "vivad",
  VIVAD_AUTH_URL: "https://auth.example.test/api/auth/token",
};

test("Vivad authentication uses SAV Builder's email and password contract", async () => {
  let request;
  const identity = await authenticateStandalone({ email: "user@vivad.com.au", password: "test-password" }, {
    env,
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ token: "upstream-token", user: { id: 42, username: "user@vivad.com.au" } }));
    },
  });

  assert.equal(request.url, env.VIVAD_AUTH_URL);
  assert.deepEqual(request.body, { username: "user@vivad.com.au", password: "test-password" });
  assert.equal(identity.provider, "vivad");
  assert.equal(identity.sub, "42");
  assert.equal(identity.email, "user@vivad.com.au");
});

test("Vivad authentication rejects incorrect credentials", async () => {
  await assert.rejects(
    authenticateStandalone({ email: "user@vivad.com.au", password: "wrong" }, {
      env,
      fetchImpl: async () => new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 401 }),
    }),
    (error) => error.status === 401 && /email address or password/i.test(error.message),
  );
});

test("authentication provider defaults to Vivad when its URL exists", () => {
  assert.equal(authenticationProvider({ VIVAD_AUTH_URL: env.VIVAD_AUTH_URL }), "vivad");
});
