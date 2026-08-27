const ASPECT_RATIOS = new Set(["original", "16:9", "1:1", "9:16"]);

function cleanText(value, maximum = 180) {
  return String(value ?? "").trim().slice(0, maximum);
}

function finiteTime(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number * 10) / 10) : fallback;
}

export function normaliseChapters(chapters, duration = Number.POSITIVE_INFINITY) {
  const maximum = Number.isFinite(Number(duration)) ? Math.max(0, Number(duration)) : Number.POSITIVE_INFINITY;
  const seen = new Set();
  return (Array.isArray(chapters) ? chapters : []).slice(0, 25).map((chapter) => ({
    title: cleanText(chapter?.title, 80),
    start: Math.min(maximum, finiteTime(chapter?.start)),
  })).filter((chapter) => chapter.title && !seen.has(chapter.start) && seen.add(chapter.start))
    .sort((left, right) => left.start - right.start);
}

export function parseStoredChapters(value, duration) {
  if (Array.isArray(value)) return normaliseChapters(value, duration);
  try { return normaliseChapters(JSON.parse(String(value || "[]")), duration); } catch { return []; }
}

export function normaliseHighlights(highlights, duration) {
  const maximum = Math.max(0, Number(duration) || 0);
  return (Array.isArray(highlights) ? highlights : []).slice(0, 20).map((highlight, index) => {
    const start = Math.min(maximum, finiteTime(highlight?.start));
    const end = Math.min(maximum, finiteTime(highlight?.end, maximum));
    return { name: cleanText(highlight?.name || `Highlight ${index + 1}`, 180), start, end };
  }).filter((highlight) => highlight.end - highlight.start >= 0.1);
}

export function normaliseEditRecipe(input = {}, source = {}) {
  const aspectRatio = ASPECT_RATIOS.has(input.aspectRatio) ? input.aspectRatio : "original";
  const sourceUid = cleanText(source.uid, 64);
  const sourceDuration = Math.max(0.1, Number(source.duration) || 0.1);
  const segments = (Array.isArray(input.segments) ? input.segments : []).slice(0, 50).map((segment, index) => {
    if (segment?.type === "title") {
      return {
        id: cleanText(segment.id || `title-${index + 1}`, 64),
        type: "title",
        title: cleanText(segment.title || "Title", 180),
        subtitle: cleanText(segment.subtitle, 240),
        duration: Math.min(30, Math.max(1, finiteTime(segment.duration, 3))),
      };
    }
    const uid = cleanText(segment?.sourceUid || sourceUid, 64);
    const start = finiteTime(segment?.start);
    const end = finiteTime(segment?.end, uid === sourceUid ? sourceDuration : start + 1);
    if (!/^[a-zA-Z0-9]{20,64}$/.test(uid) || end - start < 0.1) return null;
    return {
      id: cleanText(segment.id || `clip-${index + 1}`, 64),
      type: "clip",
      sourceUid: uid,
      start,
      end,
      label: cleanText(segment.label || `Clip ${index + 1}`, 180),
      transition: segment.transition === "crossfade" ? "crossfade" : "cut",
    };
  }).filter(Boolean);
  return {
    name: cleanText(input.name || `${source.name || "Video"} edit`, 180),
    aspectRatio,
    captions: ["none", "soft", "burned"].includes(input.captions) ? input.captions : "soft",
    watermark: Boolean(input.watermark),
    background: /^#[0-9a-fA-F]{6}$/.test(input.background) ? input.background : "#000000",
    segments,
  };
}
