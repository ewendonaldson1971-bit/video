import { safeEqual } from "./security.mjs";

function authenticationError(message, status = 401) {
  return Object.assign(new Error(message), { status });
}

function parsePayload(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw authenticationError("The Vivad authentication service returned an invalid response.", 502);
  }
}

export function authenticationProvider(env = process.env) {
  return String(env.AUTH_PROVIDER || (env.VIVAD_AUTH_URL ? "vivad" : env.APPS_SCRIPT_AUTH_URL ? "apps-script" : "access-key")).trim().toLowerCase();
}

export function normaliseVivadVideoRole(value) {
  const role = String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (["admin", "administrator"].includes(role)) return "admin";
  if (role === "editor") return "editor";
  if (["viewer", "view only", "read only", "readonly"].includes(role)) return "viewer";
  return null;
}

function vivadVideoRole(payload = {}) {
  const seen = new Set();
  const search = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) return null;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      const normalisedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (["vivadvideorole", "vivadvideo"].includes(normalisedKey)) {
        const role = normaliseVivadVideoRole(child);
        if (role) return role;
      }
      const nested = search(child, depth + 1);
      if (nested) return nested;
    }
    return null;
  };
  return search(payload);
}

function normaliseFieldName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function lotusDirectoryRole(values, email) {
  const expectedEmail = String(email || "").trim().toLowerCase();
  if (!expectedEmail || !Array.isArray(values)) return null;

  if (values.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
    const record = values.find((row) => Object.entries(row).some(([key, value]) =>
      ["email", "emailaddress", "useremail", "username", "workemail"].includes(normaliseFieldName(key))
      && String(value || "").trim().toLowerCase() === expectedEmail));
    return record ? vivadVideoRole(record) : null;
  }

  const headerLimit = Math.min(values.length, 20);
  for (let headerIndex = 0; headerIndex < headerLimit; headerIndex += 1) {
    const headers = Array.isArray(values[headerIndex]) ? values[headerIndex].map(normaliseFieldName) : [];
    const emailIndex = headers.findIndex((header) => ["email", "emailaddress", "useremail", "username", "workemail"].includes(header));
    const roleIndex = headers.findIndex((header) => ["vivadvideorole", "vivadvideo"].includes(header));
    if (emailIndex < 0 || roleIndex < 0) continue;
    const record = values.slice(headerIndex + 1).find((row) =>
      Array.isArray(row) && String(row[emailIndex] || "").trim().toLowerCase() === expectedEmail);
    return record ? normaliseVivadVideoRole(record[roleIndex]) : null;
  }
  return null;
}

export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = String(text || "");
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  row.push(field);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

async function fetchLotusDirectoryRole({ email, env, fetchImpl }) {
  if (!env.LOTUS_DIRECTORY_QUERY_URL) {
    throw authenticationError("Lotus Directory authorization is not configured.", 503);
  }
  let url;
  try {
    url = new URL(env.LOTUS_DIRECTORY_QUERY_URL);
    if (url.protocol !== "https:") throw new Error("HTTPS required");
  } catch {
    throw authenticationError("Lotus Directory authorization is not configured.", 503);
  }
  const emailColumn = String(env.LOTUS_DIRECTORY_EMAIL_COLUMN || "A").trim().toUpperCase();
  const roleColumn = String(env.LOTUS_DIRECTORY_ROLE_COLUMN || "J").trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(emailColumn) || !/^[A-Z]{1,3}$/.test(roleColumn)) {
    throw authenticationError("Lotus Directory authorization is not configured.", 503);
  }
  const queryEmail = email.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  url.searchParams.set("tqx", "out:csv");
  url.searchParams.set("tq", `select ${emailColumn},${roleColumn} where ${emailColumn} = '${queryEmail}'`);

  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "text/csv" },
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw authenticationError("The Lotus Directory authorization service is temporarily unavailable.", 502);
  }
  if (!response.ok) throw authenticationError("The Lotus Directory authorization service could not confirm access.", 502);
  return lotusDirectoryRole(parseCsvRows(await response.text()), email);
}

export function authenticationPayloadFields(payload = {}) {
  const fields = [];
  const seen = new Set();
  const sensitive = /password|secret|token|credential|authorization/i;
  const visit = (value, path = "", depth = 0) => {
    if (!value || typeof value !== "object" || depth > 6 || seen.has(value) || fields.length >= 80) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      const fieldPath = path ? `${path}.${key}` : key;
      fields.push(fieldPath);
      if (!sensitive.test(key)) visit(child, fieldPath, depth + 1);
    }
  };
  visit(payload);
  return fields;
}

export async function authenticateStandalone(input, { env = process.env, fetchImpl = fetch } = {}) {
  const provider = authenticationProvider(env);

  if (provider === "vivad") {
    const email = String(input?.email || input?.username || "").trim().toLowerCase();
    const password = String(input?.password || "");
    if (!email || !password) throw authenticationError("Enter your email address and password.");
    if (!/^\S+@\S+\.\S+$/.test(email)) throw authenticationError("Enter a valid email address.", 400);
    if (!env.VIVAD_AUTH_URL) throw authenticationError("Vivad authentication is not configured.", 503);

    let response;
    try {
      response = await fetchImpl(env.VIVAD_AUTH_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ username: email, password }),
        redirect: "follow",
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw authenticationError("The Vivad authentication service is temporarily unavailable.", 502);
    }

    const payload = parsePayload(await response.text());
    if (!response.ok || !payload?.token) {
      const rejected = response.status === 400 || response.status === 401 || response.status === 403;
      throw authenticationError(rejected ? "The email address or password is incorrect." : "The Vivad authentication service is temporarily unavailable.", rejected ? 401 : 502);
    }

    const user = payload.user || {};
    const role = vivadVideoRole(payload) || await fetchLotusDirectoryRole({ email, env, fetchImpl });
    if (!role) {
      const error = authenticationError("Your Lotus Directory record does not grant access to Vivad Video. Ask an administrator to set Vivad Video Role to Viewer, Editor or Admin.", 403);
      error.diagnosticFields = authenticationPayloadFields(payload);
      throw error;
    }
    return {
      sub: String(user.id || user.username || user.email || email),
      name: String(user.name || user.displayName || user.username || email),
      email: String(user.email || email),
      role,
      provider,
    };
  }

  if (provider === "apps-script") {
    const password = String(input?.password || "");
    if (!password) throw authenticationError("Enter your Vivad password.");
    if (!env.APPS_SCRIPT_AUTH_URL) throw authenticationError("Apps Script authentication is not configured.", 503);

    let url;
    try {
      url = new URL(env.APPS_SCRIPT_AUTH_URL);
    } catch {
      throw authenticationError("Apps Script authentication is not configured.", 503);
    }
    url.searchParams.set("action", "opensheet");
    url.searchParams.set("mode", env.APPS_SCRIPT_AUTH_MODE || "live");
    url.searchParams.set("sheet", env.APPS_SCRIPT_AUTH_SHEET || "Selector");
    url.searchParams.set("password", password);

    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "follow",
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw authenticationError("The Vivad authentication service is temporarily unavailable.", 502);
    }

    const payload = parsePayload(await response.text());
    if (!response.ok) throw authenticationError("The Vivad authentication service is temporarily unavailable.", 502);
    if (payload?.ok !== true) {
      const incorrect = /incorrect password/i.test(String(payload?.error || ""));
      throw authenticationError(incorrect ? "The Vivad password is incorrect." : "The Vivad authentication service is temporarily unavailable.", incorrect ? 401 : 502);
    }

    return {
      sub: "standalone",
      name: env.AUTH_DISPLAY_NAME || "Vivad user",
      provider,
    };
  }

  if (provider === "access-key") {
    const supplied = String(input?.password || input?.accessKey || "");
    if (!env.APP_ACCESS_KEY || !safeEqual(supplied, env.APP_ACCESS_KEY)) {
      throw authenticationError("The access key is incorrect.");
    }
    return { sub: "standalone", name: env.AUTH_DISPLAY_NAME || "Vivad user", provider };
  }

  throw authenticationError(`Unsupported authentication provider: ${provider}.`, 503);
}
