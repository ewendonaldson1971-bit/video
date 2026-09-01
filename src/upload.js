export function patchTusChunk(uploadURL, chunk, offset, totalSize, onProgress, XMLHttpRequestImpl = globalThis.XMLHttpRequest) {
  return new Promise((resolve, reject) => {
    if (!XMLHttpRequestImpl) return reject(new Error("This browser cannot report upload progress."));
    const request = new XMLHttpRequestImpl();
    request.open("PATCH", uploadURL);
    request.setRequestHeader("Tus-Resumable", "1.0.0");
    request.setRequestHeader("Upload-Offset", String(offset));
    request.setRequestHeader("Content-Type", "application/offset+octet-stream");
    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const percentage = ((offset + event.loaded) / totalSize) * 100;
      onProgress(Math.min(99.9, percentage));
    });
    request.addEventListener("load", () => resolve({
      ok: request.status >= 200 && request.status < 300,
      status: request.status,
      uploadOffset: Number(request.getResponseHeader("Upload-Offset")),
    }));
    request.addEventListener("error", () => reject(new Error("The upload connection was interrupted.")));
    request.addEventListener("abort", () => reject(new Error("The upload was cancelled.")));
    request.send(chunk);
  });
}

export function uploadStorageKey(file) {
  return `vivad-video-upload:${file.name}:${file.size}:${file.lastModified}`;
}

export function ticketIsExpired(ticket, now = Date.now()) {
  const expiry = Date.parse(ticket?.uploadExpiry || "");
  return Number.isFinite(expiry) && expiry <= now;
}

export function isAbandonedUpload(video, now = Date.now()) {
  if (String(video?.status?.state || "").toLowerCase() !== "pendingupload") return false;
  const expiry = Date.parse(video.uploadExpiry || "");
  if (Number.isFinite(expiry)) return expiry <= now;
  const created = Date.parse(video.created || "");
  return Number.isFinite(created) && created <= now - 2 * 60 * 60 * 1000;
}

export function estimateAverageBitrateMbps(sizeBytes, durationSeconds) {
  const size = Number(sizeBytes);
  const duration = Number(durationSeconds);
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(duration) || duration <= 0) return null;
  return (size * 8) / duration / 1_000_000;
}

export function declaredMaxBitrateMbps(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let maximum = null;
  for (let index = 4; index + 16 <= data.length; index += 1) {
    if (data[index] !== 0x62 || data[index + 1] !== 0x74 || data[index + 2] !== 0x72 || data[index + 3] !== 0x74) continue;
    const boxSize = view.getUint32(index - 4);
    if (boxSize < 20 || index - 4 + boxSize > data.length) continue;
    const bitrate = view.getUint32(index + 8) / 1_000_000;
    if (bitrate > 0 && (maximum === null || bitrate > maximum)) maximum = bitrate;
  }
  return maximum;
}

export function assessUploadBitrate(sizeBytes, durationSeconds, declaredMaximumMbps = null) {
  const averageBitrateMbps = estimateAverageBitrateMbps(sizeBytes, durationSeconds);
  if (averageBitrateMbps === null) return { status: "unavailable", bitrateMbps: null, averageBitrateMbps: null, declaredMaximumMbps: null };
  const declared = Number(declaredMaximumMbps);
  const hasDeclaredMaximum = Number.isFinite(declared) && declared > 0;
  const bitrateMbps = hasDeclaredMaximum ? Math.max(averageBitrateMbps, declared) : averageBitrateMbps;
  const result = { bitrateMbps, averageBitrateMbps, declaredMaximumMbps: hasDeclaredMaximum ? declared : null };
  // Average bitrate does not expose short variable-bitrate peaks, so reserve a
  // safety margin below Stream's 200 Mbps ingestion ceiling.
  if (bitrateMbps >= 180) return { status: "blocked", ...result };
  if (bitrateMbps >= 50) return { status: "warning", ...result };
  return { status: "ready", ...result };
}

export function isBitrateLimitError(message) {
  const value = String(message || "").toLowerCase();
  return value.includes("bitrate") && (value.includes("200 mbps") || value.includes("maximum acceptable"));
}

export function friendlyUploadError(message) {
  if (!isBitrateLimitError(message)) return String(message || "Cloudflare could not process this video.");
  return "Cloudflare rejected this file because its encoded video bitrate exceeds 200 Mbps. Re-export it as an MP4 using H.264 video and AAC audio; for 1080p, use about 8 Mbps, then select the converted file.";
}
