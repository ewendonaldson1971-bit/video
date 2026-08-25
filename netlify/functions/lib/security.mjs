import crypto from "node:crypto";

const encoder = new TextEncoder();

function encode(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

function decode(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function hmac(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

export function safeEqual(left, right) {
  const a = encoder.encode(String(left ?? ""));
  const b = encoder.encode(String(right ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function signToken(payload, secret, options = {}) {
  if (!secret || secret.length < 24) throw new Error("Signing secret must be at least 24 characters.");
  const now = Math.floor(Date.now() / 1000);
  const body = {
    iat: now,
    exp: now + (options.expiresInSeconds ?? 8 * 60 * 60),
    iss: options.issuer ?? "vivad-video",
    aud: options.audience ?? "vivad-video",
    ...payload,
  };
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(body)}`;
  return `${unsigned}.${hmac(unsigned, secret)}`;
}

export function verifyToken(token, secret, options = {}) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) throw new Error("Invalid token.");
  const [headerPart, payloadPart, signature] = parts;
  const header = decode(headerPart);
  if (header.alg !== "HS256") throw new Error("Unsupported token algorithm.");
  const unsigned = `${headerPart}.${payloadPart}`;
  if (!safeEqual(signature, hmac(unsigned, secret))) throw new Error("Invalid token signature.");
  const payload = decode(payloadPart);
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= now) throw new Error("Token expired.");
  if (payload.nbf && payload.nbf > now + 30) throw new Error("Token is not active.");
  if (options.issuer && payload.iss !== options.issuer) throw new Error("Invalid token issuer.");
  if (options.audience && payload.aud !== options.audience) throw new Error("Invalid token audience.");
  return payload;
}

export function getBearer(request) {
  const value = request.headers.get("authorization") || "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

export function requireSession(request) {
  const token = getBearer(request);
  if (!token) throw Object.assign(new Error("Please sign in."), { status: 401 });
  try {
    return verifyToken(token, process.env.SESSION_SIGNING_SECRET, {
      issuer: "vivad-video",
      audience: "vivad-video-session",
    });
  } catch (error) {
    throw Object.assign(new Error(error.message), { status: 401 });
  }
}

export function createSession(payload) {
  return signToken(payload, process.env.SESSION_SIGNING_SECRET, {
    audience: "vivad-video-session",
    expiresInSeconds: 8 * 60 * 60,
  });
}
