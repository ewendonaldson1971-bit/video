import { authenticateStandalone, authenticationProvider } from "./lib/auth.mjs";
import { createSession, requireSession, signToken, verifyToken } from "./lib/security.mjs";
import { sendSmtpMessage } from "./lib/smtp.mjs";
import { integrationCapabilities } from "./lib/adapters.mjs";
import { modelMetadata, validateDirectMediaUrl } from "./lib/model.mjs";
import {
  canAccessVideo,
  clamp,
  configuredAllowedOrigins,
  creatorFor,
  escapeHtml,
  normaliseVideoList,
  normaliseVisibility,
  privacyFields,
  publicVideo,
  toTusMetadata,
} from "./lib/video.mjs";

const API_ROOT = "https://api.cloudflare.com/client/v4";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function required(name) {
  const value = process.env[name];
  if (!value) throw Object.assign(new Error(`${name} is not configured.`), { status: 503 });
  return value;
}

function streamHost() {
  const configured = required("CLOUDFLARE_STREAM_CUSTOMER_CODE").trim();
  if (/^https?:\/\//i.test(configured)) return new URL(configured).host;
  return configured.includes(".") ? configured : `${configured}.cloudflarestream.com`;
}

function allowedOrigins() {
  return configuredAllowedOrigins(process.env.STREAM_ALLOWED_ORIGINS, streamHost());
}

function shareSecret() {
  return process.env.SHARE_SIGNING_SECRET || required("SESSION_SIGNING_SECRET");
}

function applicationOrigin(request) {
  const configured = String(process.env.PUBLIC_APP_URL || "").trim();
  if (configured) return new URL(configured).origin;
  return new URL(request.url).origin;
}

function createShareId(video, input = {}) {
  return signToken({ uid: video.uid, permission: "watch", download: Boolean(input.allowDownload) }, shareSecret(), {
    issuer: "vivad-video",
    audience: "vivad-video-share",
    expiresInSeconds: Math.round(clamp(input.shareDays, 1, 90, 30) * 86400),
  });
}

async function requestBody(request) {
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("A valid JSON body is required."), { status: 400 });
  }
}

async function cloudflare(path, options = {}) {
  const response = await fetch(`${API_ROOT}/accounts/${required("CLOUDFLARE_ACCOUNT_ID")}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${required("CLOUDFLARE_API_TOKEN")}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    const message = payload?.errors?.map((error) => error.message).filter(Boolean).join("; ") || `Cloudflare request failed (${response.status}).`;
    throw Object.assign(new Error(message), { status: response.status >= 500 ? 502 : 400 });
  }
  return payload?.result;
}

async function getVideo(uid) {
  if (!/^[a-zA-Z0-9]{20,64}$/.test(uid)) throw Object.assign(new Error("Invalid video ID."), { status: 400 });
  return cloudflare(`/stream/${uid}`);
}

async function getAuthorisedVideo(session, uid) {
  const video = await getVideo(uid);
  if (!canAccessVideo(session, video)) throw Object.assign(new Error("You do not have access to this video."), { status: 403 });
  return video;
}

async function createPlayback(video, hours = 1) {
  const host = streamHost();
  if (!video.requireSignedURLs) {
    return {
      expiresAt: null,
      playbackId: video.uid,
      watchUrl: `https://${host}/${video.uid}/watch`,
      iframeUrl: `https://${host}/${video.uid}/iframe`,
      thumbnailUrl: `https://${host}/${video.uid}/thumbnails/thumbnail.jpg`,
    };
  }
  const expiresHours = clamp(hours, 0.25, 24, 1);
  const expiresAt = Math.floor(Date.now() / 1000 + expiresHours * 3600);
  const result = await cloudflare(`/stream/${video.uid}/token`, {
    method: "POST",
    body: JSON.stringify({ exp: expiresAt, nbf: Math.floor(Date.now() / 1000) - 30 }),
  });
  const token = result?.token;
  if (!token) throw Object.assign(new Error("Cloudflare did not return a playback token."), { status: 502 });
  return {
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    playbackId: token,
    watchUrl: `https://${host}/${token}/watch`,
    iframeUrl: `https://${host}/${token}/iframe`,
    thumbnailUrl: `https://${host}/${token}/thumbnails/thumbnail.jpg`,
  };
}

function routePath(url) {
  const pathname = new URL(url).pathname;
  const functionPrefix = "/.netlify/functions/api";
  const clean = pathname.startsWith(functionPrefix) ? `/api${pathname.slice(functionPrefix.length)}` : pathname;
  return clean.replace(/\/+$/, "") || "/api";
}

function emailAddress(value) {
  const email = String(value || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw Object.assign(new Error("Enter a valid recipient email address."), { status: 400 });
  }
  return email;
}

async function sendVideoEmail(request, session, video, input) {
  const to = emailAddress(input.to);
  const recipientName = String(input.recipientName || "there").trim().slice(0, 80);
  const senderName = String(process.env.SMTP_FROM_NAME || "Vivad Video").trim().slice(0, 80);
  const fromEmail = process.env.SMTP_FROM_EMAIL || required("SMTP_USER");
  const subject = String(input.subject || `Your video: ${video?.meta?.name || "Video"}`).trim().slice(0, 160);
  const message = String(input.message || "Here is the video we discussed.").trim().slice(0, 2000);
  const shareId = createShareId(video, input);
  const watchUrl = `${applicationOrigin(request)}/?share=${encodeURIComponent(shareId)}`;
  const playback = await createPlayback(video, 1);
  const thumbnailTime = Math.max(0, Number(video.duration || 0) * Number(video.thumbnailTimestampPct || 0));
  const thumbnailUrl = `${playback.thumbnailUrl}?time=${thumbnailTime.toFixed(2)}s&height=360`;
  const thumbnailResponse = await fetch(thumbnailUrl);
  const attachments = [];
  if (thumbnailResponse.ok) {
    attachments.push({
      filename: "video-preview.jpg",
      content: Buffer.from(await thumbnailResponse.arrayBuffer()),
      contentType: "image/jpeg",
      cid: "vivad-video-preview",
      contentDisposition: "inline",
    });
  }

  const safeName = escapeHtml(recipientName);
  const safeMessage = escapeHtml(message).replaceAll("\n", "<br>");
  const safeWatchUrl = escapeHtml(watchUrl);
  const preview = attachments.length
    ? `<a href="${safeWatchUrl}" style="display:block;text-decoration:none"><img src="cid:vivad-video-preview" width="536" alt="Watch the video" style="display:block;width:100%;max-width:536px;height:auto;border:0;border-radius:8px"></a>`
    : "";

  const info = await sendSmtpMessage({
    host: required("SMTP_HOST"),
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    username: required("SMTP_USER"),
    password: required("SMTP_PASS"),
    from: { name: senderName, address: fromEmail },
    to,
    subject,
    text: `Hi ${recipientName},\n\n${message}\n\nWatch the video: ${watchUrl}\n\nKind regards,\n${senderName}`,
    html: `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Arial,sans-serif;color:#24262a"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#fff;border-radius:8px"><tr><td style="padding:32px"><div style="height:5px;width:62px;background:#e4002b;margin-bottom:24px"></div><h1 style="margin:0 0 18px;color:#53565a;font-size:28px">Your video is ready</h1><p style="font-size:16px;line-height:24px">Hi ${safeName},</p><p style="font-size:16px;line-height:24px">${safeMessage}</p>${preview}<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0"><tr><td bgcolor="#478fe1" style="border-radius:999px"><a href="${safeWatchUrl}" style="display:inline-block;padding:14px 24px;color:#fff;font-weight:700;text-decoration:none">Watch video</a></td></tr></table><p style="font-size:16px;line-height:24px">Kind regards,<br>${escapeHtml(senderName)}</p></td></tr></table></td></tr></table></body></html>`,
    inlineImage: attachments[0] ? { filename: attachments[0].filename, content: attachments[0].content, contentType: attachments[0].contentType, cid: attachments[0].cid } : null,
  });
  return { messageId: info.messageId, accepted: [to], rejected: [], shareExpiresAt: new Date(verifyToken(shareId, shareSecret(), { issuer: "vivad-video", audience: "vivad-video-share" }).exp * 1000).toISOString() };
}

async function handler(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  const path = routePath(request.url);

  if (path === "/api/health" && request.method === "GET") {
    const provider = authenticationProvider();
    const authenticationConfigured = provider === "vivad" ? Boolean(process.env.VIVAD_AUTH_URL) : provider === "apps-script" ? Boolean(process.env.APPS_SCRIPT_AUTH_URL) : Boolean(process.env.APP_ACCESS_KEY);
    return json({ ok: true, service: "Vivad Video", cloudflareConfigured: Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN), emailConfigured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS), authenticationConfigured, authenticationProvider: provider, integrations: integrationCapabilities() });
  }

  const publicShareMatch = path.match(/^\/api\/public\/shares\/(.+)$/);
  if (publicShareMatch && request.method === "GET") {
    let claim;
    try { claim = verifyToken(decodeURIComponent(publicShareMatch[1]), shareSecret(), { issuer: "vivad-video", audience: "vivad-video-share" }); }
    catch (error) { throw Object.assign(new Error(error.message), { status: 401 }); }
    if (claim.permission !== "watch" || !claim.uid) throw Object.assign(new Error("Invalid video share."), { status: 401 });
    const video = await getVideo(String(claim.uid));
    if (!video.readyToStream) throw Object.assign(new Error("This video is not ready yet."), { status: 409 });
    return json({ video: publicVideo(video), playback: await createPlayback(video, 1), share: { expiresAt: new Date(claim.exp * 1000).toISOString(), allowDownload: Boolean(claim.download) } });
  }

  if (path === "/api/session/login" && request.method === "POST") {
    const input = await requestBody(request);
    const identity = await authenticateStandalone(input);
    const session = { sub: identity.sub, name: identity.name, email: identity.email || null, app: "standalone", role: "admin", mode: "standalone", authProvider: identity.provider };
    return json({ token: createSession(session), session });
  }

  if (path === "/api/session/embed" && request.method === "POST") {
    const input = await requestBody(request);
    let claim;
    try {
      claim = verifyToken(input.token, required("EMBED_SIGNING_SECRET"), { issuer: "vivad-host", audience: "vivad-video" });
    } catch (error) {
      throw Object.assign(new Error(error.message), { status: 401 });
    }
    if (!claim.sub || !claim.app) throw Object.assign(new Error("Embed token requires sub and app claims."), { status: 401 });
    const session = { sub: String(claim.sub), name: String(claim.name || "User"), app: String(claim.app), role: "editor", mode: "embedded", parentOrigin: claim.origin || null, context: claim.context || null };
    return json({ token: createSession(session), session });
  }

  const session = requireSession(request);

  if (path === "/api/session" && request.method === "GET") return json({ session });

  if (path === "/api/videos" && request.method === "GET") {
    const url = new URL(request.url);
    const query = new URLSearchParams({ limit: "100", include_counts: "true" });
    if (session.role !== "admin") query.set("creator", creatorFor(session));
    if (url.searchParams.get("search")) query.set("search", url.searchParams.get("search").slice(0, 100));
    const videos = normaliseVideoList(await cloudflare(`/stream?${query}`));
    return json({ videos: videos.map(publicVideo) });
  }

  if (path === "/api/imports/direct" && request.method === "POST") {
    const input = await requestBody(request);
    const mediaUrl = validateDirectMediaUrl(input.url);
    const privacy = privacyFields(input.access || input.visibility, input.temporaryDays);
    const body = {
      input: mediaUrl,
      name: String(input.name || "Imported video").trim().slice(0, 180),
      creator: creatorFor(session),
      requireSignedURLs: privacy.requireSignedURLs,
      allowedOrigins: allowedOrigins(),
      thumbnailTimestampPct: clamp(input.thumbnailTimestampPct, 0, 1, 0.25),
      meta: modelMetadata(input),
    };
    if (privacy.scheduledDeletion) body.scheduledDeletion = privacy.scheduledDeletion;
    const imported = await cloudflare("/stream/copy", { method: "POST", body: JSON.stringify(body) });
    return json({ video: publicVideo(imported) }, 202);
  }

  if (path === "/api/uploads/tus" && request.method === "POST") {
    const input = await requestBody(request);
    const fileSize = Math.round(clamp(input.fileSize, 1, 30 * 1024 * 1024 * 1024, 0));
    if (!fileSize) throw Object.assign(new Error("A valid file size is required."), { status: 400 });
    const fileName = String(input.fileName || "video").slice(0, 180);
    const maxDurationSeconds = Math.round(clamp(input.maxDurationSeconds, 1, 36000, 3600));
    const privacy = privacyFields(input.access || input.visibility, input.temporaryDays);
    const coreMeta = modelMetadata(input, { name: fileName });
    const metadata = {
      ...coreMeta,
      maxDurationSeconds,
      expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      requiresignedurls: privacy.requireSignedURLs,
      scheduleddeletion: privacy.scheduledDeletion,
    };
    const origins = allowedOrigins();
    metadata.allowedorigins = JSON.stringify(origins);

    const response = await fetch(`${API_ROOT}/accounts/${required("CLOUDFLARE_ACCOUNT_ID")}/stream?direct_user=true`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${required("CLOUDFLARE_API_TOKEN")}`,
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(fileSize),
        "Upload-Creator": creatorFor(session),
        "Upload-Metadata": toTusMetadata(metadata),
      },
    });
    if (!response.ok) {
      const message = await response.text();
      throw Object.assign(new Error(message || `Unable to create upload (${response.status}).`), { status: 502 });
    }
    const uploadURL = response.headers.get("location");
    const uid = response.headers.get("stream-media-id");
    if (!uploadURL || !uid) throw Object.assign(new Error("Cloudflare did not return the upload URL and video ID."), { status: 502 });
    return json({ uploadURL, uid, visibility: privacy.visibility, scheduledDeletion: privacy.scheduledDeletion || null });
  }

  const videoMatch = path.match(/^\/api\/videos\/([a-zA-Z0-9]+)(?:\/(playback|clip|settings|captions|share|email))?$/);
  if (!videoMatch) throw Object.assign(new Error("Not found."), { status: 404 });
  const [, uid, action] = videoMatch;

  if (!action && request.method === "GET") {
    const video = await getAuthorisedVideo(session, uid);
    const playback = video.readyToStream ? await createPlayback(video, 1) : null;
    return json({ video: publicVideo(video), playback });
  }

  if (action === "playback" && request.method === "POST") {
    const video = await getAuthorisedVideo(session, uid);
    const input = await requestBody(request);
    return json({ playback: await createPlayback(video, input.expiresHours || 1) });
  }

  if (action === "clip" && request.method === "POST") {
    const source = await getAuthorisedVideo(session, uid);
    if (!source.readyToStream) throw Object.assign(new Error("The source video is still processing."), { status: 409 });
    const input = await requestBody(request);
    const start = clamp(input.startTimeSeconds, 0, Math.max(0, source.duration - 0.1), 0);
    const end = clamp(input.endTimeSeconds, start + 0.1, source.duration, source.duration);
    const privacy = privacyFields(input.visibility || (source.requireSignedURLs ? "private" : "public"), input.temporaryDays);
    const body = {
      clippedFromVideoUID: uid,
      startTimeSeconds: start,
      endTimeSeconds: end,
      creator: creatorFor(session),
      requireSignedURLs: privacy.requireSignedURLs,
      meta: modelMetadata({ ...input, name: input.name || `${source?.meta?.name || "Video"} – edit`, access: privacy.visibility }, source.meta),
      thumbnailTimestampPct: clamp(input.thumbnailTimestampPct, 0, 1, 0.5),
    };
    if (privacy.scheduledDeletion) body.scheduledDeletion = privacy.scheduledDeletion;
    const origins = allowedOrigins();
    body.allowedOrigins = origins;
    const clip = await cloudflare("/stream/clip", { method: "POST", body: JSON.stringify(body) });
    return json({ video: publicVideo(clip) }, 201);
  }

  if (action === "settings" && request.method === "POST") {
    const video = await getAuthorisedVideo(session, uid);
    const input = await requestBody(request);
    const privacy = privacyFields(input.visibility, input.temporaryDays);
    const body = {
      uid,
      requireSignedURLs: privacy.requireSignedURLs,
      scheduledDeletion: privacy.scheduledDeletion || null,
      thumbnailTimestampPct: clamp(input.thumbnailTimestampPct, 0, 1, video.thumbnailTimestampPct || 0),
      meta: modelMetadata({ ...input, access: privacy.visibility }, video.meta),
    };
    const origins = allowedOrigins();
    body.allowedOrigins = origins;
    const updated = await cloudflare(`/stream/${uid}`, { method: "POST", body: JSON.stringify(body) });
    return json({ video: publicVideo(updated) });
  }

  if (action === "captions" && request.method === "POST") {
    await getAuthorisedVideo(session, uid);
    const input = await requestBody(request);
    const language = String(input.language || "en").toLowerCase();
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(language)) throw Object.assign(new Error("Invalid caption language."), { status: 400 });
    const caption = await cloudflare(`/stream/${uid}/captions/${language}/generate`, { method: "POST", body: JSON.stringify({}) });
    return json({ caption }, 202);
  }

  if (action === "share" && request.method === "POST") {
    const video = await getAuthorisedVideo(session, uid);
    const input = await requestBody(request);
    const shareId = createShareId(video, input);
    const claim = verifyToken(shareId, shareSecret(), { issuer: "vivad-video", audience: "vivad-video-share" });
    return json({ share: { id: shareId, watchUrl: `${applicationOrigin(request)}/?share=${encodeURIComponent(shareId)}`, expiresAt: new Date(claim.exp * 1000).toISOString() } });
  }

  if (action === "email" && request.method === "POST") {
    const video = await getAuthorisedVideo(session, uid);
    if (!video.readyToStream) throw Object.assign(new Error("The video is not ready to send."), { status: 409 });
    return json({ sent: await sendVideoEmail(request, session, video, await requestBody(request)) });
  }

  throw Object.assign(new Error("Method not allowed."), { status: 405 });
}

export default async function api(request) {
  try {
    return await handler(request);
  } catch (error) {
    console.error("Vivad Video API error", { message: error.message, stack: error.stack });
    return json({ error: error.message || "Unexpected server error." }, error.status || 500);
  }
}

export const config = { path: "/api/*" };
