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
    return {
      sub: String(user.id || user.username || user.email || email),
      name: String(user.name || user.displayName || user.username || email),
      email: String(user.email || email),
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
