import test from "node:test";
import assert from "node:assert/strict";
import { authenticateStandalone, authenticationPayloadFields, authenticationProvider, lotusDirectoryRole, normaliseVivadVideoRole, parseCsvRows } from "../netlify/functions/lib/auth.mjs";

const env = {
  AUTH_PROVIDER: "vivad",
  VIVAD_AUTH_URL: "https://auth.example.test/api/auth/token",
  LOTUS_DIRECTORY_QUERY_URL: "https://docs.example.test/gviz/tq?gid=0",
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
      fetchImpl: async (url) => String(url).startsWith(env.VIVAD_AUTH_URL)
        ? new Response(JSON.stringify({ token: "upstream-token", user: { id: 42, username: "user@vivad.com.au" } }))
        : new Response("Email Address,Vivad Video Role\r\nother@vivad.com.au,Editor\r\n"),
    }),
    (error) => error.status === 403 && /Lotus Directory/i.test(error.message)
      && error.diagnosticFields.includes("user.username") && !error.diagnosticFields.includes("token.hidden"),
  );
});

test("roles can be returned from a nested Lotus Directory profile", async () => {
  const identity = await authenticateStandalone({ email: "user@vivad.com.au", password: "test-password" }, {
    env,
    fetchImpl: async () => new Response(JSON.stringify({ token: "upstream-token", user: { id: 42, profile: { directory: { "Vivad Video Role": "Viewer" } } } })),
  });
  assert.equal(identity.role, "viewer");
});

test("role authorization is read separately from Lotus_Directory", async () => {
  const requests = [];
  const identity = await authenticateStandalone({ email: "user@vivad.com.au", password: "test-password" }, {
    env,
    fetchImpl: async (url) => {
      requests.push(String(url));
      return String(url).startsWith(env.VIVAD_AUTH_URL)
        ? new Response(JSON.stringify({ token: "upstream-token", user: { username: "user@vivad.com.au" } }))
        : new Response("email,Vivad-Video Role\r\nuser@vivad.com.au,Admin\r\n");
    },
  });
  assert.equal(identity.role, "admin");
  const directoryRequest = new URL(requests[1]);
  assert.equal(directoryRequest.searchParams.get("tqx"), "out:csv");
  assert.equal(directoryRequest.searchParams.get("tq"), "select A,J where A = 'user@vivad.com.au'");
});

test("Lotus Directory lookup supports tabular and record responses", () => {
  assert.equal(lotusDirectoryRole([
    ["Directory"],
    ["Name", "Email Address", "Vivad Video Role"],
    ["User", "USER@vivad.com.au", "Editor"],
  ], "user@vivad.com.au"), "editor");
  assert.equal(lotusDirectoryRole([
    { Email: "user@vivad.com.au", "Vivad Video Role": "Viewer" },
  ], "user@vivad.com.au"), "viewer");
});

test("CSV Lotus Directory lookup handles hyphenated role headers and quoted values", async () => {
  const csvEnv = { ...env, LOTUS_DIRECTORY_QUERY_URL: "https://docs.example.test/gviz/tq?gid=0" };
  const requests = [];
  const identity = await authenticateStandalone({ email: "user@vivad.com.au", password: "test-password" }, {
    env: csvEnv,
    fetchImpl: async (url) => {
      requests.push(String(url));
      return String(url).startsWith(env.VIVAD_AUTH_URL)
        ? new Response(JSON.stringify({ token: "upstream-token", user: { username: "user@vivad.com.au" } }))
        : new Response('email,First Name,Vivad-Video Role\r\nuser@vivad.com.au,"Example, User",Editor\r\n');
    },
  });
  assert.equal(identity.role, "editor");
  assert.match(requests[1], /^https:\/\/docs\.example\.test\/gviz\/tq\?/);
  assert.deepEqual(parseCsvRows('a,b\r\n"one, two","say ""hello"""\r\n'), [["a", "b"], ["one, two", 'say "hello"']]);
});

test("authentication diagnostics report structure without traversing secrets", () => {
  assert.deepEqual(
    authenticationPayloadFields({ token: { hidden: true }, user: { id: 42, profile: { roleName: "Editor" } } }),
    ["token", "user", "user.id", "user.profile", "user.profile.roleName"],
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
