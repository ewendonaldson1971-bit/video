import { normaliseChapters, parseStoredChapters } from "./editing.mjs";

const PURPOSES = new Set(["website", "training", "sop", "internal", "client", "testing", "general"]);
const ACCESS_POLICIES = new Set(["public", "link", "organisation", "team", "client", "expiring", "temporary"]);

export const PURPOSE_TEMPLATES = Object.freeze({
  website: { label: "Website content", access: "public", reviewStatus: "draft", indexable: true },
  training: { label: "Training", access: "organisation", reviewStatus: "draft", indexable: false },
  sop: { label: "SOP", access: "organisation", reviewStatus: "draft", indexable: false },
  internal: { label: "Internal update", access: "organisation", reviewStatus: "draft", indexable: false },
  client: { label: "Client message", access: "client", reviewStatus: "draft", indexable: false },
  testing: { label: "Testing", access: "organisation", reviewStatus: "draft", indexable: false },
  general: { label: "General video", access: "link", reviewStatus: "draft", indexable: false },
});

export function normalisePurpose(value) {
  return PURPOSES.has(value) ? value : "general";
}

export function normaliseAccessPolicy(value) {
  if (value === "private") return "expiring";
  return ACCESS_POLICIES.has(value) ? value : "expiring";
}

export function accessRequiresSignedPlayback(value) {
  return !["public", "link"].includes(normaliseAccessPolicy(value));
}

export function accessIsIndexable(value) {
  return normaliseAccessPolicy(value) === "public";
}

export function purposeDefaults(value) {
  const purpose = normalisePurpose(value);
  return { purpose, ...PURPOSE_TEMPLATES[purpose] };
}

export function modelMetadata(input = {}, previous = {}) {
  const purpose = normalisePurpose(input.purpose ?? previous.vivadPurpose);
  const access = normaliseAccessPolicy(input.access ?? input.visibility ?? previous.vivadAccess ?? previous.vivadVisibility);
  const text = (value, maximum) => String(value ?? "").trim().slice(0, maximum);
  return {
    ...previous,
    name: text(input.name ?? previous.name ?? "Untitled video", 180),
    vivadPurpose: purpose,
    vivadAccess: access,
    vivadVisibility: access,
    vivadDescription: text(input.description ?? previous.vivadDescription, 1000),
    vivadTags: text(Array.isArray(input.tags) ? input.tags.join(",") : input.tags ?? previous.vivadTags, 500),
    vivadReviewStatus: text(input.reviewStatus ?? previous.vivadReviewStatus ?? "draft", 32),
    vivadDepartment: text(input.department ?? previous.vivadDepartment, 100),
    vivadTopic: text(input.topic ?? previous.vivadTopic, 160),
    vivadCategory: text(input.category ?? previous.vivadCategory, 100),
    vivadOwner: text(input.owner ?? previous.vivadOwner, 120),
    vivadVersion: text(input.version ?? previous.vivadVersion ?? "1", 24),
    vivadReviewDate: text(input.reviewDate ?? previous.vivadReviewDate, 10),
    vivadExpiryDate: text(input.expiryDate ?? previous.vivadExpiryDate, 10),
    vivadRelatedLinks: text(input.relatedLinks ?? previous.vivadRelatedLinks, 1000),
    vivadRequiredAcknowledgement: String(Boolean(input.requiredAcknowledgement ?? (previous.vivadRequiredAcknowledgement === "true"))),
    vivadChapters: text(JSON.stringify(normaliseChapters(input.chapters ?? parseStoredChapters(previous.vivadChapters))), 4000),
  };
}

export function parseExternalVideoUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { throw new Error("Enter a valid YouTube or Vimeo URL."); }
  if (url.protocol !== "https:") throw new Error("External video URLs must use HTTPS.");
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let provider;
  let providerId;
  if (host === "youtu.be") {
    provider = "youtube";
    providerId = url.pathname.split("/").filter(Boolean)[0];
  } else if (["youtube.com", "m.youtube.com"].includes(host)) {
    provider = "youtube";
    providerId = url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/")
      ? url.pathname.split("/")[2]
      : url.searchParams.get("v");
  } else if (host === "vimeo.com" || host === "player.vimeo.com") {
    provider = "vimeo";
    providerId = url.pathname.split("/").filter(Boolean).find((part) => /^\d+$/.test(part));
  }
  if (!provider || !providerId || !/^[a-zA-Z0-9_-]{6,32}$/.test(providerId)) throw new Error("Use an official YouTube or Vimeo video URL.");
  return { provider, providerId, url: url.toString() };
}

function isPrivateIpv4(host) {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

export function validateDirectMediaUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { throw new Error("Enter a valid direct video-file URL."); }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:") throw new Error("Direct imports must use HTTPS.");
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || isPrivateIpv4(host)
    || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) {
    throw new Error("Private or local network addresses cannot be imported.");
  }
  if (url.username || url.password) throw new Error("URLs containing credentials cannot be imported.");
  if (url.port && url.port !== "443") throw new Error("Direct imports may only use the standard HTTPS port.");
  return url.toString();
}

export function toCoreVideo(video = {}) {
  const meta = video.meta || {};
  const access = normaliseAccessPolicy(meta.vivadAccess || meta.vivadVisibility || (video.requireSignedURLs ? "expiring" : "public"));
  return {
    id: video.uid,
    provider: "cloudflare",
    providerId: video.uid,
    owner: video.creator || null,
    creator: video.creator || null,
    purpose: normalisePurpose(meta.vivadPurpose),
    access,
    title: meta.name || "Untitled video",
    internalName: meta.name || "Untitled video",
    description: meta.vivadDescription || "",
    transcript: "",
    thumbnail: video.thumbnail || null,
    duration: Number(video.duration || 0),
    chapters: parseStoredChapters(meta.vivadChapters, Number(video.duration || 0)),
    captionLanguages: [],
    tags: String(meta.vivadTags || "").split(",").map((item) => item.trim()).filter(Boolean),
    collections: [],
    version: meta.vivadVersion || "1",
    sourceVideoId: video.clippedFrom || null,
    reviewStatus: meta.vivadReviewStatus || "draft",
    reviewDate: meta.vivadReviewDate || null,
    expiryDate: meta.vivadExpiryDate || video.scheduledDeletion || null,
    publicationDestinations: [],
    department: meta.vivadDepartment || "",
    topic: meta.vivadTopic || "",
    category: meta.vivadCategory || "",
    contentOwner: meta.vivadOwner || "",
    requiredAcknowledgement: meta.vivadRequiredAcknowledgement === "true",
    relatedLinks: String(meta.vivadRelatedLinks || "").split("\n").map((item) => item.trim()).filter(Boolean),
    createdAt: video.created || null,
    modifiedAt: video.modified || null,
  };
}
