import { accessIsIndexable } from "./model.mjs";

export const STRAPI_VIDEO_FIELDS = Object.freeze([
  "title", "seoTitle", "slug", "summary", "description", "transcript", "provider", "providerId",
  "playerUrl", "thumbnailUrl", "duration", "uploadDate", "chapters", "captions", "tags", "categories",
  "relatedProducts", "relatedArticles", "canonicalUrl", "socialTitle", "socialDescription", "socialImage",
  "locale", "indexStatus",
]);

export function slugify(value) {
  return String(value || "video").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 96) || "video";
}

export function isoDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return `PT${hours ? `${hours}H` : ""}${minutes ? `${minutes}M` : ""}${remainder || (!hours && !minutes) ? `${remainder}S` : ""}`;
}

export function createPublishingBundle({ video, watchUrl, iframeUrl, thumbnailUrl, canonicalUrl = watchUrl, chapters = [] }) {
  const indexable = accessIsIndexable(video.access || video.visibility);
  const title = video.title || video.name || "Video";
  const description = video.description || `Watch ${title}.`;
  const safeChapters = chapters.filter((chapter) => Number.isFinite(Number(chapter.start)) && String(chapter.title || "").trim())
    .sort((left, right) => Number(left.start) - Number(right.start));
  const jsonLd = indexable ? {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: title,
    description,
    thumbnailUrl: [thumbnailUrl],
    uploadDate: video.createdAt || video.created,
    duration: isoDuration(video.duration),
    embedUrl: iframeUrl,
    url: canonicalUrl,
    ...(safeChapters.length ? { hasPart: safeChapters.map((chapter, index) => ({
      "@type": "Clip",
      name: String(chapter.title).trim(),
      startOffset: Number(chapter.start),
      ...(safeChapters[index + 1] ? { endOffset: Number(safeChapters[index + 1].start) } : {}),
      url: `${watchUrl}${watchUrl.includes("?") ? "&" : "?"}t=${Number(chapter.start)}`,
    })) } : {}),
  } : null;
  return {
    indexable,
    robots: indexable ? "index,follow" : "noindex,nofollow",
    canonicalUrl,
    jsonLd,
    openGraph: { title, description, image: thumbnailUrl, type: "video.other", url: canonicalUrl },
    twitter: { card: "summary_large_image", title, description, image: thumbnailUrl },
    sitemap: indexable ? { loc: canonicalUrl, thumbnailLoc: thumbnailUrl, title, description, playerLoc: iframeUrl, duration: Math.round(video.duration || 0) } : null,
    strapiDraft: {
      title,
      seoTitle: title,
      slug: slugify(title),
      summary: description.slice(0, 240),
      description,
      transcript: video.transcript || "",
      provider: video.provider || "cloudflare",
      providerId: video.providerId || video.uid || video.id,
      playerUrl: iframeUrl,
      thumbnailUrl,
      duration: Number(video.duration || 0),
      uploadDate: video.createdAt || video.created,
      chapters: safeChapters,
      captions: video.captionLanguages || [],
      tags: video.tags || [],
      categories: [], relatedProducts: [], relatedArticles: [], canonicalUrl,
      socialTitle: title, socialDescription: description.slice(0, 240), socialImage: thumbnailUrl,
      locale: "en", indexStatus: indexable ? "index" : "noindex",
    },
  };
}

export function discourseSharePackage({ title, description = "", watchUrl, iframeUrl, isPublic }) {
  return {
    link: watchUrl,
    markdown: `[${String(title || "Watch video").replace(/[\[\]]/g, "")}](${watchUrl})`,
    iframe: isPublic && iframeUrl
      ? `<div class="vivad-video"><iframe src="${iframeUrl}" title="${String(title || "Video").replaceAll('"', "&quot;")}" loading="lazy" allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>`
      : null,
    onebox: { title, description, url: watchUrl },
  };
}
