import crypto from "node:crypto";

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * Create a short-lived token that allows a host app to open Vivad Video.
 * Run this only on the host app's server. Never expose the signing secret to
 * browser code.
 */
export function createVivadVideoEmbedToken({ secret, userId, userName, app, origin, context, expiresInSeconds = 300 }) {
  if (!secret || secret.length < 24) throw new Error("A strong EMBED_SIGNING_SECRET is required.");
  if (!userId || !app || !origin) throw new Error("userId, app and origin are required.");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    sub: String(userId),
    name: String(userName || "User"),
    app: String(app),
    origin: String(origin),
    context: context || null,
    iat: now,
    nbf: now - 5,
    exp: now + Math.min(600, Math.max(30, expiresInSeconds)),
    iss: "vivad-host",
    aud: "vivad-video",
  });
  const unsigned = `${header}.${payload}`;
  const signature = crypto.createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}
