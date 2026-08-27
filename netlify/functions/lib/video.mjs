import { accessRequiresSignedPlayback, modelMetadata, normaliseAccessPolicy, toCoreVideo } from "./model.mjs";

const VALID_VISIBILITY = new Set(["public", "link", "organisation", "team", "client", "expiring", "temporary"]);

export function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

export function sanitiseCreator(value) {
  return String(value || "standalone")
    .replace(/[^a-zA-Z0-9_.:@-]/g, "-")
    .slice(0, 64);
}

export function creatorFor(session) {
  return sanitiseCreator(`${session.app || "standalone"}:${session.sub || "user"}`);
}

export function normaliseVisibility(value) {
  return normaliseAccessPolicy(value);
}

export function configuredAllowedOrigins(value, streamHostname, applicationHostname = "") {
  const origins = String(value || "")
    .split(",")
    .map((origin) => origin.trim().replace(/^https?:\/\//, "").replace(/\/$/, ""))
    .filter(Boolean);
  if (!origins.length) return [];
  return [...new Set([...origins, applicationHostname, streamHostname].filter(Boolean))];
}

export function originAllowsHostname(origins, hostname) {
  const target = String(hostname || "").trim().toLowerCase();
  if (!Array.isArray(origins) || !origins.length) return true;
  return origins.some((origin) => {
    const allowed = String(origin || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
    if (allowed.startsWith("*.")) {
      const root = allowed.slice(2);
      return target !== root && target.endsWith(`.${root}`);
    }
    return target === allowed;
  });
}

export function privacyFields(visibility, temporaryDays = 30) {
  const mode = normaliseVisibility(visibility);
  const fields = {
    visibility: mode,
    requireSignedURLs: accessRequiresSignedPlayback(mode),
  };
  if (mode === "temporary") {
    const days = Math.round(clamp(temporaryDays, 30, 1096, 30));
    fields.temporaryDays = days;
    // Leave a small buffer so the timestamp remains at least N full days after
    // Cloudflare records the video's created time.
    fields.scheduledDeletion = new Date(Date.now() + days * 86400000 + 5 * 60000).toISOString();
  }
  return fields;
}

export function visibilityFromVideo(video) {
  const explicit = video?.meta?.vivadAccess || video?.meta?.vivadVisibility;
  if (explicit === "private") return "expiring";
  if (VALID_VISIBILITY.has(explicit)) return explicit;
  if (video?.scheduledDeletion) return "temporary";
  return video?.requireSignedURLs ? "expiring" : "public";
}

export function toTusMetadata(entries) {
  return Object.entries(entries)
    .filter(([, value]) => value !== undefined && value !== null && value !== false && value !== "")
    .map(([key, value]) => value === true ? key : `${key} ${Buffer.from(String(value)).toString("base64")}`)
    .join(",");
}

export function publicVideo(video) {
  const core = toCoreVideo(video);
  return {
    uid: video.uid,
    name: video?.meta?.name || "Untitled video",
    visibility: visibilityFromVideo(video),
    duration: Number(video.duration || 0),
    created: video.created,
    modified: video.modified,
    readyToStream: Boolean(video.readyToStream),
    status: video.status || { state: video.readyToStream ? "ready" : "queued", pctComplete: "0" },
    thumbnail: video.thumbnail || null,
    thumbnailTimestampPct: Number(video.thumbnailTimestampPct || 0),
    scheduledDeletion: video.scheduledDeletion || null,
    uploadExpiry: video.uploadExpiry || null,
    creator: video.creator || null,
    clippedFrom: video.clippedFrom || null,
    allowedOrigins: Array.isArray(video.allowedOrigins) ? video.allowedOrigins : [],
    purpose: core.purpose,
    access: core.access,
    description: core.description,
    tags: core.tags,
    reviewStatus: core.reviewStatus,
    core,
  };
}

export { modelMetadata };

export function normaliseVideoList(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.videos)) return result.videos;
  return [];
}

export function canAccessVideo(session, video) {
  return session.role === "admin" || video.creator === creatorFor(session);
}

export function canViewVideo(session, video) {
  if (canAccessVideo(session, video)) return true;
  return ["public", "link", "organisation"].includes(visibilityFromVideo(video));
}

export function canDiscoverVideo(session, video) {
  if (canAccessVideo(session, video)) return true;
  return ["public", "organisation"].includes(visibilityFromVideo(video));
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
