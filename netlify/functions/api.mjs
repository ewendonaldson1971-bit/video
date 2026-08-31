import { authenticateStandalone, authenticationProvider } from "./lib/auth.mjs";
import { createSession, requireSession, signToken, verifyToken } from "./lib/security.mjs";
import { sendSmtpMessage } from "./lib/smtp.mjs";
import { integrationCapabilities, RenderingService, StrapiPublisher, VideoRepository } from "./lib/adapters.mjs";
import { normaliseEditRecipe, normaliseHighlights } from "./lib/editing.mjs";
import { modelMetadata, parseExternalVideoUrl, validateDirectMediaUrl } from "./lib/model.mjs";
import { createPublishingBundle, discourseSharePackage } from "./lib/publishing.mjs";
import { enforceRateLimit } from "./lib/rate-limit.mjs";
import {
  canAccessVideo,
  canDiscoverVideo,
  canViewVideo,
  clamp,
  configuredAllowedOrigins,
  creatorFor,
  escapeHtml,
  normaliseVideoList,
  normaliseVisibility,
  originPoliciesMatch,
  privacyFields,
  publicVideo,
  toTusMetadata,
} from "./lib/video.mjs";

const API_ROOT = "https://api.cloudflare.com/client/v4";
const PLAYBACK_POLICY_VERSION = "2026-08-31-open-origin";

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

function allowedOrigins(request) {
  const configured = String(process.env.STREAM_ALLOWED_ORIGINS || "").trim();
  if (!configured) return [];
  const appHostname = new URL(applicationOrigin(request)).hostname;
  return configuredAllowedOrigins(configured, streamHost(), appHostname);
}

function applicationHostname(request) {
  return new URL(applicationOrigin(request)).hostname;
}

function authoritativePlaybackOrigins(request) {
  return allowedOrigins(request);
}

async function ensureApplicationPlayback(video, request, { force = false } = {}) {
  const current = Array.isArray(video?.allowedOrigins) ? video.allowedOrigins : [];
  const desired = authoritativePlaybackOrigins(request);
  const policyIsCurrent = video?.meta?.vivadPlaybackPolicyVersion === PLAYBACK_POLICY_VERSION;
  if (!force && policyIsCurrent && originPoliciesMatch(current, desired)) return { video, repaired: false, repairError: null };
  try {
    await cloudflare(`/stream/${video.uid}`, {
      method: "POST",
      body: JSON.stringify({
        uid: video.uid,
        allowedOrigins: desired,
        meta: { ...(video.meta || {}), vivadPlaybackPolicyVersion: PLAYBACK_POLICY_VERSION },
      }),
    });
    // Cloudflare can return an accepted update before the playback record used by
    // Stream's edge is current. Re-read the authoritative record and only issue a
    // player URL after the saved policy is visible.
    const verified = await getVideo(video.uid);
    if (!originPoliciesMatch(verified.allowedOrigins, desired) || verified?.meta?.vivadPlaybackPolicyVersion !== PLAYBACK_POLICY_VERSION) {
      throw new Error("Cloudflare did not persist the requested playback policy.");
    }
    return { video: verified, repaired: true, repairError: null };
  } catch (error) {
    console.warn(JSON.stringify({ event: "video.playback-origin-repair-failed", uid: video.uid, message: error.message }));
    return { video, repaired: false, repairError: "Cloudflare could not save the playback policy. An administrator should verify that the API token has Stream Edit permission." };
  }
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
      ...(typeof options.body === "string" ? { "content-type": "application/json" } : {}),
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

async function getViewableVideo(session, uid) {
  const video = await getVideo(uid);
  if (!canViewVideo(session, video)) throw Object.assign(new Error("You do not have access to this video."), { status: 403 });
  return video;
}

async function getCommentableVideo(session, uid) {
  if (/^[a-zA-Z0-9]{20,64}$/.test(uid)) return publicVideo(await getViewableVideo(session, uid));
  if (/^(youtube|vimeo):[a-zA-Z0-9_-]{6,64}$/.test(uid)) {
    const repository = new VideoRepository();
    if (!repository.configured) throw Object.assign(new Error("Video comments require Netlify Database or VIDEO_DATABASE_URL."), { status: 503 });
    const external = await repository.externalByUid({ uid, session });
    if (!external) throw Object.assign(new Error("You do not have access to this video."), { status: 403 });
    return external;
  }
  throw Object.assign(new Error("Invalid video ID."), { status: 400 });
}

function videoVersion(video) {
  return String(video?.meta?.vivadVersion || "1").trim().slice(0, 24) || "1";
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

async function catalogueBestEffort(event, operation) {
  const repository = new VideoRepository();
  if (!repository.configured) return null;
  try {
    return await operation(repository);
  } catch (error) {
    console.warn(JSON.stringify({ event: `video.catalogue.${event}.failed`, message: error.message }));
    return null;
  }
}

async function createPlayback(video, hours = 1, tokenOptions = {}) {
  const host = streamHost();
  const iframeVersion = video.modified || video.created;
  const iframeQuery = iframeVersion ? `?v=${encodeURIComponent(iframeVersion)}` : "";
  if (!video.requireSignedURLs) {
    return {
      expiresAt: null,
      playbackId: video.uid,
      watchUrl: `https://${host}/${video.uid}/watch`,
      iframeUrl: `https://${host}/${video.uid}/iframe${iframeQuery}`,
      thumbnailUrl: `https://${host}/${video.uid}/thumbnails/thumbnail.jpg`,
    };
  }
  const expiresHours = clamp(hours, 0.25, 24, 1);
  const expiresAt = Math.floor(Date.now() / 1000 + expiresHours * 3600);
  const result = await cloudflare(`/stream/${video.uid}/token`, {
    method: "POST",
    body: JSON.stringify({ exp: expiresAt, nbf: Math.floor(Date.now() / 1000) - 30, ...tokenOptions }),
  });
  const token = result?.token;
  if (!token) throw Object.assign(new Error("Cloudflare did not return a playback token."), { status: 502 });
  return {
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    playbackId: token,
    watchUrl: `https://${host}/${token}/watch`,
    iframeUrl: `https://${host}/${token}/iframe${iframeQuery}`,
    thumbnailUrl: `https://${host}/${token}/thumbnails/thumbnail.jpg`,
  };
}

async function libraryVideo(video) {
  const safe = publicVideo(video);
  if (!video.readyToStream || !video.requireSignedURLs) return safe;
  try {
    const playback = await createPlayback(video, 1);
    safe.thumbnail = playback.thumbnailUrl;
    safe.thumbnailExpiresAt = playback.expiresAt;
  } catch (error) {
    console.warn(JSON.stringify({ event: "video.library-thumbnail.failed", uid: video.uid, message: error.message }));
    safe.thumbnail = null;
  }
  return safe;
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

function requireEditorRole(session) {
  if (!['editor', 'admin'].includes(session.role)) throw Object.assign(new Error("Your role does not permit changes."), { status: 403 });
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
    enforceRateLimit(request, "public-share", { limit: 120, windowMs: 60 * 60 * 1000 });
    let claim;
    try { claim = verifyToken(decodeURIComponent(publicShareMatch[1]), shareSecret(), { issuer: "vivad-video", audience: "vivad-video-share" }); }
    catch (error) { throw Object.assign(new Error(error.message), { status: 401 }); }
    if (claim.permission !== "watch" || !claim.uid) throw Object.assign(new Error("Invalid video share."), { status: 401 });
    let video = await getVideo(String(claim.uid));
    if (!video.readyToStream) throw Object.assign(new Error("This video is not ready yet."), { status: 409 });
    const originResult = await ensureApplicationPlayback(video, request);
    if (originResult.repairError) throw Object.assign(new Error(originResult.repairError), { status: 502 });
    video = originResult.video;
    return json({ video: publicVideo(video), playback: await createPlayback(video, 1), share: { expiresAt: new Date(claim.exp * 1000).toISOString(), allowDownload: Boolean(claim.download) } });
  }

  const publicVideoMatch = path.match(/^\/api\/public\/videos\/([a-zA-Z0-9]{20,64})$/);
  if (publicVideoMatch && request.method === "GET") {
    let video = await getVideo(publicVideoMatch[1]);
    let safe = publicVideo(video);
    if (video.requireSignedURLs || safe.visibility !== "public") throw Object.assign(new Error("This video is not public."), { status: 404 });
    if (!video.readyToStream) throw Object.assign(new Error("This video is not ready yet."), { status: 409 });
    const originResult = await ensureApplicationPlayback(video, request);
    if (originResult.repairError) throw Object.assign(new Error(originResult.repairError), { status: 502 });
    video = originResult.video;
    safe = publicVideo(video);
    const playback = await createPlayback(video, 1);
    const watchUrl = `${applicationOrigin(request)}/?watch=${encodeURIComponent(video.uid)}`;
    return json({ video: safe, playback, publishing: createPublishingBundle({ video: safe.core, watchUrl, iframeUrl: playback.iframeUrl, thumbnailUrl: playback.thumbnailUrl, canonicalUrl: watchUrl }) });
  }

  if (path === "/api/session/login" && request.method === "POST") {
    enforceRateLimit(request, "login", { limit: 10, windowMs: 15 * 60 * 1000 });
    const input = await requestBody(request);
    const identity = await authenticateStandalone(input);
    const session = { sub: identity.sub, name: identity.name, email: identity.email || null, app: "standalone", role: identity.role, mode: "standalone", authProvider: identity.provider };
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
    let parentOrigin = null;
    try {
      const parsed = new URL(String(claim.origin || ""));
      if (parsed.origin !== claim.origin || parsed.hostname.includes("*") || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname)))) throw new Error();
      parentOrigin = parsed.origin;
    } catch { throw Object.assign(new Error("Embed token requires an exact HTTPS parent origin."), { status: 401 }); }
    const role = ["viewer", "editor", "admin"].includes(claim.role) ? claim.role : "editor";
    const session = { sub: String(claim.sub), name: String(claim.name || "User"), app: String(claim.app), role, purpose: String(claim.purpose || "general"), mode: "embedded", parentOrigin, context: claim.context || null };
    return json({ token: createSession(session), session });
  }

  const session = requireSession(request);

  if (path === "/api/session" && request.method === "GET") return json({ session, token: createSession(session) });

  if (path === "/api/videos" && request.method === "GET") {
    const url = new URL(request.url);
    const query = new URLSearchParams({ limit: "100", include_counts: "true" });
    if (url.searchParams.get("search")) query.set("search", url.searchParams.get("search").slice(0, 100));
    const videos = normaliseVideoList(await cloudflare(`/stream?${query}`));
    const visibleVideos = videos.filter((video) => canDiscoverVideo(session, video));
    const safeVideos = await Promise.all(visibleVideos.map(async (video) => ({
      ...(await libraryVideo(video)),
      canManage: canAccessVideo(session, video),
    })));
    await catalogueBestEffort("sync", (repository) => repository.syncStreamVideos(safeVideos, session));
    const externalVideos = await catalogueBestEffort("external-list", (repository) => repository.listExternal(session)) || [];
    return json({ videos: [...safeVideos, ...externalVideos].sort((left, right) => Date.parse(right.created || 0) - Date.parse(left.created || 0)) });
  }

  if (path === "/api/management" && request.method === "GET") {
    requireEditorRole(session);
    const repository = new VideoRepository();
    if (!repository.configured) return json({ database: { configured: false }, catalogue: null });
    try {
      const ownerId = session.role === "admin" ? null : session.sub;
      return json({ database: { configured: true }, catalogue: await repository.catalogueStatus(ownerId) });
    } catch (error) {
      console.warn(JSON.stringify({ event: "video.catalogue.status.failed", message: error.message }));
      return json({ database: { configured: true, available: false, error: "The video catalogue is temporarily unavailable." }, catalogue: null }, 503);
    }
  }

  if (path === "/api/comments" && ["GET", "POST"].includes(request.method)) {
    const repository = new VideoRepository();
    if (!repository.configured) throw Object.assign(new Error("Video comments require Netlify Database or VIDEO_DATABASE_URL."), { status: 503 });
    const input = request.method === "POST" ? await requestBody(request) : null;
    const uid = String(input?.videoUid || new URL(request.url).searchParams.get("videoUid") || "").trim();
    await getCommentableVideo(session, uid);
    if (request.method === "GET") return json({ comments: await repository.listComments({ uid }) });
    enforceRateLimit(request, "video-comment", { limit: 60, windowMs: 60 * 60 * 1000 });
    const body = String(input.body || "").trim();
    if (!body) throw Object.assign(new Error("Enter a comment."), { status: 400 });
    if (body.length > 2000) throw Object.assign(new Error("Comments can contain up to 2,000 characters."), { status: 400 });
    return json({ comment: await repository.createComment({ uid, session, body }) }, 201);
  }

  if (path === "/api/videos/external" && request.method === "POST") {
    requireEditorRole(session);
    const input = await requestBody(request);
    const name = String(input.name || "").trim();
    if (!name) throw Object.assign(new Error("Enter a video name before adding the external link."), { status: 400 });
    const external = parseExternalVideoUrl(input.url);
    const record = {
      provider: external.provider,
      providerId: external.providerId,
      sourceUrl: external.url,
      owner: session.sub,
      creator: creatorFor(session),
      meta: modelMetadata({ ...input, name, access: input.access || "link" }),
      createdAt: new Date().toISOString(),
    };
    return json({ video: await new VideoRepository().saveExternal(record) }, 201);
  }

  if (path === "/api/imports/direct" && request.method === "POST") {
    requireEditorRole(session);
    enforceRateLimit(request, "direct-import", { limit: 20, windowMs: 60 * 60 * 1000 });
    const input = await requestBody(request);
    const mediaUrl = validateDirectMediaUrl(input.url);
    const privacy = privacyFields(input.access || input.visibility, input.temporaryDays);
    const body = {
      input: mediaUrl,
      name: String(input.name || "Imported video").trim().slice(0, 180),
      creator: creatorFor(session),
      requireSignedURLs: privacy.requireSignedURLs,
      allowedOrigins: allowedOrigins(request),
      thumbnailTimestampPct: clamp(input.thumbnailTimestampPct, 0, 1, 0.25),
      meta: modelMetadata(input),
    };
    if (privacy.scheduledDeletion) body.scheduledDeletion = privacy.scheduledDeletion;
    const imported = await cloudflare("/stream/copy", { method: "POST", body: JSON.stringify(body) });
    return json({ video: publicVideo(imported) }, 202);
  }

  const captionLanguageMatch = path.match(/^\/api\/videos\/([a-zA-Z0-9]{20,64})\/captions\/([a-zA-Z0-9-]{2,20})(?:\/(vtt))?$/);
  if (captionLanguageMatch) {
    const [, captionUid, languageRaw, captionFormat] = captionLanguageMatch;
    await getAuthorisedVideo(session, captionUid);
    const language = languageRaw.toLowerCase();
    if (captionFormat === "vtt" && request.method === "GET") {
      const response = await fetch(`${API_ROOT}/accounts/${required("CLOUDFLARE_ACCOUNT_ID")}/stream/${captionUid}/captions/${language}/vtt`, { headers: { authorization: `Bearer ${required("CLOUDFLARE_API_TOKEN")}` } });
      if (!response.ok) throw Object.assign(new Error(`Unable to download captions (${response.status}).`), { status: 502 });
      return new Response(await response.text(), { headers: { "content-type": "text/vtt; charset=utf-8", "content-disposition": `attachment; filename="captions-${language}.vtt"`, "cache-control": "no-store" } });
    }
    if (request.method === "PUT") {
      requireEditorRole(session);
      const input = await requestBody(request);
      const vtt = String(input.vtt || "");
      if (!vtt.startsWith("WEBVTT") || vtt.length > 2_000_000) throw Object.assign(new Error("Upload a valid WebVTT file smaller than 2 MB."), { status: 400 });
      const form = new FormData();
      form.append("file", new Blob([vtt], { type: "text/vtt" }), `captions-${language}.vtt`);
      return json({ caption: await cloudflare(`/stream/${captionUid}/captions/${language}`, { method: "PUT", body: form }) });
    }
    if (request.method === "DELETE") { requireEditorRole(session); return json({ deleted: await cloudflare(`/stream/${captionUid}/captions/${language}`, { method: "DELETE" }) }); }
  }

  const downloadsMatch = path.match(/^\/api\/videos\/([a-zA-Z0-9]{20,64})\/downloads(?:\/(default|audio))?$/);
  if (downloadsMatch) {
    const [, downloadUid, downloadType] = downloadsMatch;
    const video = await getAuthorisedVideo(session, downloadUid);
    if (request.method === "POST") {
      requireEditorRole(session);
      const type = downloadType || "default";
      return json({ downloads: await cloudflare(`/stream/${downloadUid}/downloads/${type}`, { method: "POST", body: JSON.stringify({}) }) }, 202);
    }
    if (request.method === "GET") {
      const downloads = await cloudflare(`/stream/${downloadUid}/downloads`);
      if (video.requireSignedURLs) {
        const token = await createPlayback(video, 1, { downloadable: true });
        for (const value of Object.values(downloads || {})) {
          if (value?.url) value.url = value.url.replace(`/${downloadUid}/downloads/`, `/${token.playbackId}/downloads/`);
        }
      }
      return json({ downloads });
    }
  }

  if (path === "/api/uploads/tus" && request.method === "POST") {
    requireEditorRole(session);
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
    const origins = allowedOrigins(request);
    if (origins.length) metadata.allowedorigins = JSON.stringify(origins);

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
    try {
      await cloudflare(`/stream/${uid}`, { method: "POST", body: JSON.stringify({ uid, allowedOrigins: origins }) });
    } catch (error) {
      console.warn(JSON.stringify({ event: "video.upload-origin-update-failed", uid, message: error.message }));
    }
    await catalogueBestEffort("upload", (repository) => repository.recordUpload({
      uid,
      session: { ...session, creator: creatorFor(session) },
      fileName,
      visibility: privacy.visibility,
      purpose: coreMeta.vivadPurpose,
      uploadExpiry: metadata.expiry,
    }));
    return json({ uploadURL, uid, uploadExpiry: metadata.expiry, visibility: privacy.visibility, scheduledDeletion: privacy.scheduledDeletion || null });
  }

  const projectMatch = path.match(/^\/api\/videos\/([a-zA-Z0-9]{20,64})\/projects(?:\/([a-zA-Z0-9-]{8,64})(?:\/(render))?)?$/);
  if (projectMatch) {
    requireEditorRole(session);
    const [, projectVideoUid, projectId, projectAction] = projectMatch;
    const source = await getAuthorisedVideo(session, projectVideoUid);
    const repository = new VideoRepository();
    if (!repository.configured) throw Object.assign(new Error("Edit projects require Netlify Database or VIDEO_DATABASE_URL."), { status: 503 });
    if (!projectId && request.method === "GET") return json({ projects: await repository.listEditProjects({ uid: projectVideoUid, session }), capabilities: integrationCapabilities() });
    if (!projectId && request.method === "POST") {
      const input = await requestBody(request);
      const recipe = normaliseEditRecipe(input.recipe || input, { uid: source.uid, duration: source.duration, name: source.meta?.name });
      if (!recipe.segments.length) throw Object.assign(new Error("Add at least one clip or title card to the timeline."), { status: 400 });
      const sourceUids = [...new Set(recipe.segments.filter((segment) => segment.type === "clip").map((segment) => segment.sourceUid))];
      if (sourceUids.length > 20) throw Object.assign(new Error("A timeline can use up to 20 source videos."), { status: 400 });
      for (const sourceUid of sourceUids) {
        const timelineSource = await getAuthorisedVideo(session, sourceUid);
        if (recipe.segments.some((segment) => segment.type === "clip" && segment.sourceUid === sourceUid && segment.end > Number(timelineSource.duration || 0))) {
          throw Object.assign(new Error(`A timeline range exceeds the duration of ${timelineSource.meta?.name || sourceUid}.`), { status: 400 });
        }
      }
      const id = /^[a-zA-Z0-9-]{8,64}$/.test(input.id || "") ? input.id : crypto.randomUUID();
      return json({ project: await repository.saveEditProject({ id, uid: projectVideoUid, session, recipe }), capabilities: integrationCapabilities() }, 201);
    }
    if (projectId && !projectAction && request.method === "GET") return json({ project: await repository.editProject({ id: projectId, uid: projectVideoUid, session }), capabilities: integrationCapabilities() });
    if (projectId && projectAction === "render" && request.method === "POST") {
      enforceRateLimit(request, "render", { limit: 20, windowMs: 60 * 60 * 1000 });
      const project = await repository.editProject({ id: projectId, uid: projectVideoUid, session });
      const job = await new RenderingService().render(project);
      return json({ project: await repository.markRenderSubmitted({ id: projectId, uid: projectVideoUid, session, job }), job }, 202);
    }
    throw Object.assign(new Error("Method not allowed."), { status: 405 });
  }

  const videoMatch = path.match(/^\/api\/videos\/([a-zA-Z0-9]+)(?:\/(playback|clip|highlights|branded|settings|origins|captions|share|email|publishing|strapi|acknowledgement|acknowledgements))?$/);
  if (!videoMatch) throw Object.assign(new Error("Not found."), { status: 404 });
  const [, uid, action] = videoMatch;

  if (!action && request.method === "GET") {
    let video = await getViewableVideo(session, uid);
    const mayManage = ["editor", "admin"].includes(session.role) && canAccessVideo(session, video);
    let playbackOrigin = { repaired: false, repairError: null };
    const originResult = await ensureApplicationPlayback(video, request);
    video = originResult.video;
    playbackOrigin = { repaired: originResult.repaired, repairError: originResult.repairError };
    const playback = video.readyToStream && !originResult.repairError ? await createPlayback(video, 1) : null;
    const safe = publicVideo(video);
    const repository = new VideoRepository();
    const acknowledgement = repository.configured
      ? await repository.acknowledgementStatus({ uid, session, version: videoVersion(video) })
      : null;
    return json({ video: safe, playback, permissions: { manage: mayManage }, playbackOrigin, acknowledgement: { available: repository.configured, required: safe.core.requiredAcknowledgement, version: safe.core.version, record: acknowledgement }, editorCapabilities: { ...integrationCapabilities(), watermark: Boolean(process.env.CLOUDFLARE_STREAM_WATERMARK_UID) } });
  }

  if (!action && request.method === "DELETE") {
    requireEditorRole(session);
    enforceRateLimit(request, "delete-video", { limit: 50, windowMs: 60 * 60 * 1000 });
    const video = await getAuthorisedVideo(session, uid);
    const input = await requestBody(request);
    if (input.confirmation !== "DELETE" || input.confirmUid !== uid) {
      throw Object.assign(new Error("Deletion confirmation did not match this video."), { status: 400 });
    }
    await cloudflare(`/stream/${uid}`, { method: "DELETE" });
    await catalogueBestEffort("delete", (repository) => repository.markDeleted(uid, session, { name: String(video?.meta?.name || "Untitled video").slice(0, 180) }));
    console.info(JSON.stringify({
      event: "video.deleted",
      uid,
      name: String(video?.meta?.name || "Untitled video").slice(0, 180),
      actor: String(session.sub),
      app: String(session.app || "standalone"),
      role: String(session.role),
      deletedAt: new Date().toISOString(),
    }));
    return json({ deleted: true, uid });
  }

  if (action === "playback" && request.method === "POST") {
    enforceRateLimit(request, "playback-token", { limit: 120, windowMs: 60 * 60 * 1000 });
    const video = await getViewableVideo(session, uid);
    const input = await requestBody(request);
    return json({ playback: await createPlayback(video, input.expiresHours || 1) });
  }

  if (action === "acknowledgement" && ["GET", "POST"].includes(request.method)) {
    const video = await getViewableVideo(session, uid);
    const safe = publicVideo(video);
    const repository = new VideoRepository();
    if (!repository.configured) throw Object.assign(new Error("Acknowledgement tracking is not configured."), { status: 503 });
    const version = videoVersion(video);
    if (request.method === "POST") {
      if (!safe.core.requiredAcknowledgement) throw Object.assign(new Error("This video does not require acknowledgement."), { status: 400 });
      enforceRateLimit(request, "acknowledgement", { limit: 60, windowMs: 60 * 60 * 1000 });
      const record = await repository.acknowledgeVideo({ uid, session, version });
      return json({ acknowledgement: { available: true, required: true, version, record } }, 201);
    }
    const record = await repository.acknowledgementStatus({ uid, session, version });
    return json({ acknowledgement: { available: true, required: safe.core.requiredAcknowledgement, version, record } });
  }

  if (action === "acknowledgements" && request.method === "GET") {
    requireEditorRole(session);
    const video = await getAuthorisedVideo(session, uid);
    const repository = new VideoRepository();
    if (!repository.configured) throw Object.assign(new Error("Acknowledgement tracking is not configured."), { status: 503 });
    const version = videoVersion(video);
    const records = await repository.acknowledgementReport({ uid, version });
    if (new URL(request.url).searchParams.get("format") === "csv") {
      const lines = [
        ["Name", "Email", "User ID", "Video version", "Source app", "Acknowledged at"],
        ...records.map((record) => [record.user_name, record.user_email, record.user_id, record.video_version, record.source_app, record.acknowledged_at]),
      ].map((row) => row.map(csvCell).join(","));
      return new Response(`\uFEFF${lines.join("\r\n")}\r\n`, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="acknowledgements-${uid}-v${version}.csv"`, "cache-control": "no-store" } });
    }
    return json({ report: { uid, version, count: records.length, records } });
  }

  if (action === "clip" && request.method === "POST") {
    requireEditorRole(session);
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
    const origins = authoritativePlaybackOrigins(request);
    body.allowedOrigins = origins;
    const clip = await cloudflare("/stream/clip", { method: "POST", body: JSON.stringify(body) });
    const safeClip = publicVideo(clip);
    await catalogueBestEffort("clip", (repository) => repository.syncStreamVideos([safeClip], session));
    return json({ video: safeClip }, 201);
  }

  if (action === "highlights" && request.method === "POST") {
    requireEditorRole(session);
    enforceRateLimit(request, "highlights", { limit: 10, windowMs: 60 * 60 * 1000 });
    const source = await getAuthorisedVideo(session, uid);
    if (!source.readyToStream) throw Object.assign(new Error("The source video is still processing."), { status: 409 });
    const input = await requestBody(request);
    const highlights = normaliseHighlights(input.highlights, source.duration);
    if (!highlights.length) throw Object.assign(new Error("Add at least one valid highlight range."), { status: 400 });
    const sourceVisibility = publicVideo(source).visibility;
    const privacy = privacyFields(input.visibility || sourceVisibility, input.temporaryDays);
    const origins = authoritativePlaybackOrigins(request);
    const clips = [];
    for (const highlight of highlights) {
      const body = {
        clippedFromVideoUID: uid,
        startTimeSeconds: highlight.start,
        endTimeSeconds: highlight.end,
        creator: creatorFor(session),
        requireSignedURLs: privacy.requireSignedURLs,
        allowedOrigins: origins,
        thumbnailTimestampPct: 0.5,
        meta: modelMetadata({ name: highlight.name, access: privacy.visibility, purpose: input.purpose || source.meta?.vivadPurpose }, source.meta),
      };
      if (privacy.scheduledDeletion) body.scheduledDeletion = privacy.scheduledDeletion;
      clips.push(publicVideo(await cloudflare("/stream/clip", { method: "POST", body: JSON.stringify(body) })));
    }
    await catalogueBestEffort("highlights", (repository) => repository.syncStreamVideos(clips, session));
    return json({ videos: clips }, 201);
  }

  if (action === "branded" && request.method === "POST") {
    requireEditorRole(session);
    enforceRateLimit(request, "branded-copy", { limit: 10, windowMs: 60 * 60 * 1000 });
    const source = await getAuthorisedVideo(session, uid);
    if (!source.readyToStream) throw Object.assign(new Error("The source video is still processing."), { status: 409 });
    const watermarkUid = required("CLOUDFLARE_STREAM_WATERMARK_UID");
    if (!/^[a-zA-Z0-9]{20,64}$/.test(watermarkUid)) throw Object.assign(new Error("CLOUDFLARE_STREAM_WATERMARK_UID is invalid."), { status: 503 });
    const input = await requestBody(request);
    const sourceVisibility = publicVideo(source).visibility;
    const privacy = privacyFields(input.visibility || sourceVisibility, input.temporaryDays);
    const body = {
      clippedFromVideoUID: uid,
      startTimeSeconds: 0,
      endTimeSeconds: source.duration,
      creator: creatorFor(session),
      requireSignedURLs: privacy.requireSignedURLs,
      allowedOrigins: authoritativePlaybackOrigins(request),
      thumbnailTimestampPct: source.thumbnailTimestampPct || 0,
      watermark: { uid: watermarkUid },
      meta: modelMetadata({ name: input.name || `${source.meta?.name || "Video"} – branded`, access: privacy.visibility }, source.meta),
    };
    if (privacy.scheduledDeletion) body.scheduledDeletion = privacy.scheduledDeletion;
    const branded = publicVideo(await cloudflare("/stream/clip", { method: "POST", body: JSON.stringify(body) }));
    await catalogueBestEffort("branded", (repository) => repository.syncStreamVideos([branded], session));
    return json({ video: branded }, 201);
  }

  if (action === "settings" && request.method === "POST") {
    requireEditorRole(session);
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
    const origins = authoritativePlaybackOrigins(request);
    body.allowedOrigins = origins;
    const updated = await cloudflare(`/stream/${uid}`, { method: "POST", body: JSON.stringify(body) });
    const safeUpdated = publicVideo(updated);
    await catalogueBestEffort("settings", (repository) => repository.syncStreamVideos([safeUpdated], session));
    return json({ video: safeUpdated });
  }

  if (action === "origins" && request.method === "POST") {
    requireEditorRole(session);
    const video = await getAuthorisedVideo(session, uid);
    const originResult = await ensureApplicationPlayback(video, request, { force: true });
    if (originResult.repairError) throw Object.assign(new Error(originResult.repairError), { status: 502 });
    return json({ video: publicVideo(originResult.video), playbackOrigin: { repaired: true, repairError: null } });
  }

  if (action === "captions" && request.method === "POST") {
    requireEditorRole(session);
    await getAuthorisedVideo(session, uid);
    const input = await requestBody(request);
    const language = String(input.language || "en").toLowerCase();
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(language)) throw Object.assign(new Error("Invalid caption language."), { status: 400 });
    const caption = await cloudflare(`/stream/${uid}/captions/${language}/generate`, { method: "POST", body: JSON.stringify({}) });
    return json({ caption }, 202);
  }

  if (action === "captions" && request.method === "GET") {
    await getAuthorisedVideo(session, uid);
    return json({ captions: await cloudflare(`/stream/${uid}/captions`) });
  }

  if (action === "share" && request.method === "POST") {
    requireEditorRole(session);
    const video = await getAuthorisedVideo(session, uid);
    const input = await requestBody(request);
    const shareId = createShareId(video, input);
    const claim = verifyToken(shareId, shareSecret(), { issuer: "vivad-video", audience: "vivad-video-share" });
    return json({ share: { id: shareId, watchUrl: `${applicationOrigin(request)}/?share=${encodeURIComponent(shareId)}`, expiresAt: new Date(claim.exp * 1000).toISOString() } });
  }

  if ((action === "publishing" && request.method === "GET") || (action === "strapi" && request.method === "POST")) {
    if (action === "strapi") requireEditorRole(session);
    const video = await getAuthorisedVideo(session, uid);
    const safe = publicVideo(video);
    const playback = await createPlayback(video, 1);
    const publicWatchUrl = `${applicationOrigin(request)}/?watch=${encodeURIComponent(video.uid)}`;
    const input = request.method === "POST" ? await requestBody(request) : {};
    const stableWatchUrl = safe.visibility === "public" ? publicWatchUrl : input.watchUrl;
    if (!stableWatchUrl) throw Object.assign(new Error("Create a protected share link before generating private publishing output."), { status: 400 });
    const bundle = createPublishingBundle({ video: safe.core, watchUrl: stableWatchUrl, iframeUrl: playback.iframeUrl, thumbnailUrl: playback.thumbnailUrl, canonicalUrl: stableWatchUrl, chapters: safe.core.chapters || [] });
    const discourse = discourseSharePackage({ title: safe.name, description: safe.description, watchUrl: stableWatchUrl, iframeUrl: playback.iframeUrl, isPublic: safe.visibility === "public" });
    if (action === "strapi") {
      if (safe.visibility !== "public") throw Object.assign(new Error("Only public videos can be saved to Strapi."), { status: 400 });
      return json({ draft: await new StrapiPublisher().saveDraft(bundle.strapiDraft) }, 201);
    }
    return json({ publishing: bundle, discourse });
  }

  if (action === "email" && request.method === "POST") {
    requireEditorRole(session);
    enforceRateLimit(request, "email", { limit: 30, windowMs: 60 * 60 * 1000 });
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
    console.error(JSON.stringify({ event: "api.request.failed", status: error.status || 500, message: error.message || "Unexpected server error." }));
    return json({ error: error.message || "Unexpected server error." }, error.status || 500, error.retryAfter ? { "retry-after": String(error.retryAfter) } : {});
  }
}

export const config = { path: "/api/*" };
