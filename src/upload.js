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
