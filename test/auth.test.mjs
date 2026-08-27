import test from "node:test";
import assert from "node:assert/strict";
import { authenticateStandalone, authenticationProvider, normaliseVivadVideoRole } from "../netlify/functions/lib/auth.mjs";

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
      return new Response(JSON.stringify({ token: "upstream-token", user: { id: 42, username: "user@vivad.com.au", "Vivad Video Role": "Editor" } }));
    },
  });

  assert.equal(request.url, env.VIVAD_AUTH_URL);
  assert.deepEqual(request.body, { username: "user@vivad.com.au", password: "test-password" });
  assert.equal(identity.provider, "vivad");
  assert.equal(identity.sub, "42");
  assert.equal(identity.email, "user@vivad.com.au");
  assert.equal(identity.role, "editor");
});

test("Vivad Video roles from Lotus Directory are case-insensitive and restricted", () => {
  assert.equal(normaliseVivadVideoRole("Admin"), "admin");
  assert.equal(normaliseVivadVideoRole("editor"), "editor");
  assert.equal(normaliseVivadVideoRole("Read Only"), "viewer");
  assert.equal(normaliseVivadVideoRole("No Access"), null);
  assert.equal(normaliseVivadVideoRole(""), null);
});

test("login is denied when Lotus Directory has not assigned a Vivad Video role", async () => {
  await assert.rejects(
    authenticateStandalone({ email: "user@vivad.com.au", password: "test-password" }, {
      env,
      fetchImpl: async () => new Response(JSON.stringify({ token: "upstream-token", user: { id: 42, username: "user@vivad.com.au" } })),
    }),
    (error) => error.status === 403 && /Lotus Directory/i.test(error.message),
  );
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
