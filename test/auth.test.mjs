import test from "node:test";
import assert from "node:assert/strict";
import { authenticateStandalone, authenticationProvider } from "../netlify/functions/lib/auth.mjs";

const env = {
  AUTH_PROVIDER: "apps-script",
  APPS_SCRIPT_AUTH_URL: "https://script.google.com/macros/s/example/exec",
  APPS_SCRIPT_AUTH_MODE: "live",
  APPS_SCRIPT_AUTH_SHEET: "Selector",
};

test("Apps Script authentication validates through the SAV Builder action", async () => {
  let requestedUrl;
  const identity = await authenticateStandalone({ password: "test-password" }, {
    env,
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return new Response(JSON.stringify({ ok: true, url: "https://docs.google.com/spreadsheets/example" }));
    },
  });

  assert.equal(requestedUrl.searchParams.get("action"), "opensheet");
  assert.equal(requestedUrl.searchParams.get("password"), "test-password");
  assert.equal(requestedUrl.searchParams.get("sheet"), "Selector");
  assert.equal(identity.provider, "apps-script");
  assert.equal(identity.sub, "standalone");
});

test("Apps Script authentication rejects an incorrect password", async () => {
  await assert.rejects(
    authenticateStandalone({ password: "wrong" }, {
      env,
      fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: "Incorrect password." })),
    }),
    (error) => error.status === 401 && /incorrect/i.test(error.message),
  );
});

test("authentication provider defaults to Apps Script when its URL exists", () => {
  assert.equal(authenticationProvider({ APPS_SCRIPT_AUTH_URL: env.APPS_SCRIPT_AUTH_URL }), "apps-script");
});

