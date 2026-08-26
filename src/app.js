import "./styles.css";

const app = document.querySelector("#app");
const demoMode = import.meta.env.DEV && new URLSearchParams(location.search).get("demo") === "1";
const state = {
  token: sessionStorage.getItem("vivadVideoSession") || "",
  session: null,
  section: "upload",
  videos: [],
  selected: null,
  playback: null,
  playbackRequested: false,
  file: null,
  upload: null,
  busy: false,
};

const demoVideo = {
  uid: "demo-video-id",
  name: "Customer installation walkthrough.mp4",
  visibility: "private",
  duration: 223,
  created: new Date().toISOString(),
  readyToStream: true,
  status: { state: "ready", pctComplete: "100" },
  thumbnail: null,
  thumbnailTimestampPct: 0.35,
  scheduledDeletion: null,
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatTime(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatTimecode(seconds) {
  const value = Math.max(0, Math.round((Number(seconds) || 0) * 10) / 10);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = (value % 60).toFixed(1).padStart(4, "0");
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${remainder}`;
}

function parseTimecode(value) {
  const parts = String(value || "").trim().split(":");
  if (!parts.length || parts.length > 3 || parts.some((part) => part === "" || !Number.isFinite(Number(part)))) return NaN;
  if (parts.some((part) => Number(part) < 0)) return NaN;
  if (parts.length === 1) return Number(parts[0]);
  if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
  return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
}

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium" }).format(new Date(value));
}

function initials(name) {
  return String(name || "V").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function toast(message, type = "success") {
  const region = document.querySelector("#toast-region");
  if (!region) return;
  const item = document.createElement("div");
  item.className = `toast ${type === "error" ? "error" : ""}`;
  item.setAttribute("role", type === "error" ? "alert" : "status");
  item.textContent = message;
  region.append(item);
  setTimeout(() => item.remove(), 4800);
}

function setBusy(value) {
  state.busy = value;
  document.querySelectorAll("button[data-busy]").forEach((button) => { button.disabled = value; });
}

function emitHostEvent(type, detail = {}) {
  if (state.session?.mode !== "embedded" || !state.session.parentOrigin || window.parent === window) return;
  window.parent.postMessage({ source: "vivad-video", type, detail }, state.session.parentOrigin);
}

async function api(path, options = {}) {
  if (demoMode) return demoApi(path, options);
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

async function demoApi(path, options) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (path === "/session") return { session: state.session };
  if (path === "/videos") return { videos: [demoVideo] };
  if (path.startsWith("/videos/demo-video-id") && (!options.method || options.method === "GET")) return { video: demoVideo, playback: null };
  if (path.includes("/clip")) return { video: { ...demoVideo, uid: "demo-edited-video", name: "Customer installation – edit.mp4", status: { state: "queued", pctComplete: "0" }, readyToStream: false } };
  if (path.includes("/settings")) return { video: demoVideo };
  if (path.includes("/captions")) return { caption: { status: "inprogress" } };
  if (path.includes("/share")) return { playback: { watchUrl: "https://example.com/video", expiresAt: new Date(Date.now() + 86400000).toISOString() } };
  if (path.includes("/email")) return { sent: { messageId: "demo-message", accepted: ["customer@example.com"] } };
  return {};
}

function renderLogin(error = "") {
  app.innerHTML = `
    <main class="login-shell">
      <section class="login-card" aria-labelledby="login-title">
        <img class="brand-logo" src="/assets/vivad-logo.png" alt="Vivad">
        <div class="red-rule"></div>
        <p class="eyebrow">Secure video workspace</p>
        <h1 id="login-title">Vivad Video</h1>
        <p class="muted">Sign in with the same Vivad password used by SAV Builder.</p>
        ${error ? `<div class="status-banner error" role="alert"><span>${escapeHtml(error)}</span></div>` : ""}
        <form id="login-form" style="margin-top:26px">
          <label class="field">
            <span>Vivad password</span>
            <input type="password" name="password" autocomplete="current-password" required autofocus>
          </label>
          <button class="button button-primary" type="submit" data-busy>Sign in</button>
        </form>
      </section>
    </main>`;
  document.querySelector("#login-form").addEventListener("submit", login);
}

async function login(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  setBusy(true);
  try {
    const result = await fetch("/api/session/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: form.get("password") }),
    }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Sign in failed.");
      return payload;
    });
    acceptSession(result);
    await startApp();
  } catch (error) {
    renderLogin(error.message);
  } finally {
    setBusy(false);
  }
}

function acceptSession(result) {
  state.token = result.token;
  state.session = result.session;
  sessionStorage.setItem("vivadVideoSession", state.token);
}

function logout() {
  state.token = "";
  state.session = null;
  sessionStorage.removeItem("vivadVideoSession");
  renderLogin();
}

function shell() {
  app.innerHTML = `
    <header class="app-header">
      <div class="header-inner">
        <div class="header-brand">
          <img class="brand-logo" src="/assets/vivad-logo.png" alt="Vivad">
          <span class="app-name">Video</span>
        </div>
        <div class="session-chip">
          <div class="avatar">${escapeHtml(initials(state.session?.name))}</div>
          <div class="session-copy"><strong>${escapeHtml(state.session?.name || "Vivad user")}</strong><br><span>${escapeHtml(state.session?.app || "standalone")}</span></div>
          ${state.session?.mode === "standalone" ? '<button class="button button-quiet button-small" id="logout-button">Sign out</button>' : ""}
        </div>
      </div>
    </header>
    <main class="app-main">
      <section class="hero">
        <div class="hero-copy">
          <div class="red-rule"></div>
          <p class="eyebrow">Vivad media workspace</p>
          <h1>Video, ready to share.</h1>
          <p>Upload, trim, secure and deliver video without leaving your workflow.</p>
        </div>
        <button class="button button-secondary" id="refresh-videos">Refresh library</button>
      </section>
      <nav class="workflow" aria-label="Video workflow">
        <button data-section="upload"><span class="step-number">01</span>Upload</button>
        <button data-section="library"><span class="step-number">02</span>Library</button>
        <button data-section="edit"><span class="step-number">03</span>Edit</button>
        <button data-section="share"><span class="step-number">04</span>Share</button>
      </nav>
      <div id="view"></div>
    </main>
    <div class="toast-region" id="toast-region" aria-live="polite"></div>`;
  document.querySelectorAll("[data-section]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.section)));
  document.querySelector("#refresh-videos").addEventListener("click", async () => {
    if (await loadVideos()) toast("Video library refreshed.");
  });
  document.querySelector("#logout-button")?.addEventListener("click", logout);
}

function navigate(section) {
  if ((section === "edit" || section === "share") && !state.selected) {
    toast("Select a video from the library first.", "error");
    section = "library";
  }
  state.section = section;
  document.querySelectorAll("[data-section]").forEach((button) => button.classList.toggle("active", button.dataset.section === section));
  if (section === "upload") renderUpload();
  if (section === "library") renderLibrary();
  if (section === "edit") renderEditor();
  if (section === "share") renderShare();
}

function visibilityOptions(current = "private", prefix = "visibility") {
  return `
    <div class="visibility-options" role="radiogroup" aria-label="Video access">
      ${[
        ["public", "◎", "Public", "Anyone with the link can watch."],
        ["private", "◉", "Private", "Only an expiring signed link can play."],
        ["temporary", "◷", "Temporary", "Private and automatically deleted after its retention period."],
      ].map(([value, icon, label, description]) => `
        <div class="visibility-option">
          <input id="${prefix}-${value}" type="radio" name="${prefix}" value="${value}" ${current === value ? "checked" : ""}>
          <label for="${prefix}-${value}"><span class="visibility-icon">${icon}</span><span><strong>${label}</strong><small>${description}</small></span></label>
        </div>`).join("")}
    </div>`;
}

function renderUpload() {
  const file = state.file;
  document.querySelector("#view").innerHTML = `
    <section class="panel">
      <div class="panel-header"><div><p class="eyebrow">Step 01</p><h2>Upload a video</h2></div><span class="badge badge-private">Resumable upload</span></div>
      <div class="panel-body grid-two">
        <div>
          <div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="Select a video file">
            <div>
              <div class="upload-icon">↑</div>
              <h3>Drop a video here</h3>
              <p class="muted">or select a file from your computer</p>
              <button class="button button-primary" type="button" id="select-file">Select video</button>
              <input class="sr-only" type="file" id="file-input" accept="video/*,.mov,.mkv,.avi,.webm">
              ${file ? `<div class="selected-file"><strong>${escapeHtml(file.name)}</strong><span class="muted">${formatBytes(file.size)}</span></div>` : ""}
            </div>
          </div>
          <div id="upload-progress"></div>
        </div>
        <form id="upload-form">
          <label class="field"><span>Video name</span><input name="name" value="${escapeHtml(file?.name || "")}" placeholder="Customer video" required></label>
          <label class="field"><span>Maximum expected duration</span><select name="maxDurationSeconds"><option value="600">10 minutes</option><option value="1800">30 minutes</option><option value="3600" selected>1 hour</option><option value="7200">2 hours</option><option value="18000">5 hours</option></select></label>
          <span class="field-label">Access</span>
          ${visibilityOptions("private", "uploadVisibility")}
          <label class="field hidden" id="upload-retention" style="margin-top:14px"><span>Delete automatically after</span><select name="temporaryDays"><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option><option value="180">180 days</option></select></label>
          <p class="expiry-note">Private email links can be set to expire between 15 minutes and 24 hours. Temporary video deletion starts at 30 days.</p>
          <button class="button button-primary" type="submit" data-busy ${file ? "" : "disabled"}>Upload to Cloudflare</button>
        </form>
      </div>
    </section>`;
  bindUpload();
}

function bindUpload() {
  const dropzone = document.querySelector("#dropzone");
  const input = document.querySelector("#file-input");
  const choose = () => input.click();
  document.querySelector("#select-file").addEventListener("click", (event) => { event.stopPropagation(); choose(); });
  dropzone.addEventListener("click", (event) => { if (!event.target.closest("button")) choose(); });
  dropzone.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") choose(); });
  input.addEventListener("change", () => selectFile(input.files[0]));
  ["dragenter", "dragover"].forEach((type) => dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((type) => dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.remove("dragover"); }));
  dropzone.addEventListener("drop", (event) => selectFile(event.dataTransfer.files[0]));
  document.querySelectorAll('input[name="uploadVisibility"]').forEach((radio) => radio.addEventListener("change", () => document.querySelector("#upload-retention").classList.toggle("hidden", radio.value !== "temporary" || !radio.checked)));
  document.querySelector("#upload-form").addEventListener("submit", startUpload);
}

function selectFile(file) {
  if (!file) return;
  if (!file.type.startsWith("video/") && !/\.(mov|mkv|avi|webm|mp4|mpg|mpeg)$/i.test(file.name)) {
    toast("Please select a recognised video file.", "error");
    return;
  }
  if (file.size > 30 * 1024 ** 3) {
    toast("Cloudflare Stream accepts files up to 30 GB.", "error");
    return;
  }
  state.file = file;
  renderUpload();
}

async function startUpload(event) {
  event.preventDefault();
  if (!state.file) return toast("Select a video first.", "error");
  const form = new FormData(event.currentTarget);
  const visibility = form.get("uploadVisibility");
  setBusy(true);
  showUploadProgress(0, "Creating a secure upload…");
  try {
    const ticket = await api("/uploads/tus", {
      method: "POST",
      body: JSON.stringify({
        fileName: form.get("name") || state.file.name,
        fileSize: state.file.size,
        maxDurationSeconds: Number(form.get("maxDurationSeconds")),
        visibility,
        temporaryDays: Number(form.get("temporaryDays") || 30),
      }),
    });
    state.upload = { uid: ticket.uid, visibility, progress: 0 };
    await uploadTus(state.file, ticket, (percentage) => showUploadProgress(percentage, percentage < 100 ? "Uploading directly to Cloudflare…" : "Upload complete. Cloudflare is processing the video…"));
    emitHostEvent("video.uploaded", { uid: ticket.uid, visibility });
    await waitUntilReady(ticket.uid);
  } catch (error) {
    showUploadProgress(state.upload?.progress || 0, error.message, true);
    toast(error.message, "error");
  } finally {
    setBusy(false);
  }
}

function showUploadProgress(percentage, label, error = false) {
  if (state.upload) state.upload.progress = percentage;
  const target = document.querySelector("#upload-progress");
  if (!target) return;
  target.innerHTML = `<div class="progress-card"><div class="progress-row"><span>${escapeHtml(label)}</span><span>${Math.round(percentage)}%</span></div><div class="progress-track"><div class="progress-bar" style="width:${Math.max(0, Math.min(100, percentage))}%;${error ? "background:#e4002b" : ""}"></div></div></div>`;
}

async function uploadTus(file, ticket, onProgress) {
  const chunkSize = 50 * 1024 * 1024;
  const storageKey = `vivad-video-upload:${file.name}:${file.size}:${file.lastModified}`;
  localStorage.setItem(storageKey, JSON.stringify(ticket));
  let offset = 0;
  try {
    const head = await fetch(ticket.uploadURL, { method: "HEAD", headers: { "Tus-Resumable": "1.0.0" } });
    if (head.ok) offset = Number(head.headers.get("Upload-Offset") || 0);
  } catch { /* A new upload starts at offset zero. */ }
  onProgress((offset / file.size) * 100);

  while (offset < file.size) {
    const next = Math.min(file.size, offset + chunkSize);
    const chunk = file.slice(offset, next);
    let response;
    let lastError;
    for (const delay of [0, 1000, 3000, 7000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        response = await fetch(ticket.uploadURL, {
          method: "PATCH",
          headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" },
          body: chunk,
        });
        if (response.ok) break;
        lastError = new Error(`Upload failed (${response.status}).`);
      } catch (error) { lastError = error; }
    }
    if (!response?.ok) throw lastError || new Error("Upload interrupted.");
    offset = Number(response.headers.get("Upload-Offset") || next);
    onProgress((offset / file.size) * 100);
  }
  localStorage.removeItem(storageKey);
}

async function waitUntilReady(uid) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await api(`/videos/${uid}`);
    state.selected = result.video;
    state.playback = result.playback;
    state.playbackRequested = true;
    const status = result.video.status;
    if (status?.state === "error") throw new Error(status.errorReasonText || "Cloudflare could not process this video.");
    if (result.video.readyToStream) {
      showUploadProgress(100, "Ready to edit and share.");
      toast("Video is ready.");
      await loadVideos(false);
      navigate("edit");
      return;
    }
    showUploadProgress(100, `Processing video… ${status?.pctComplete || 0}%`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  toast("The upload is complete. Processing will continue in the library.");
  await loadVideos(false);
  navigate("library");
}

async function loadVideos(render = true) {
  try {
    const result = await api("/videos");
    state.videos = Array.isArray(result.videos) ? result.videos : [];
    if (render && state.section === "library") renderLibrary();
    return true;
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
}

function renderLibrary() {
  const cards = state.videos.map((video) => `
    <article class="video-card ${state.selected?.uid === video.uid ? "selected" : ""}" data-video-id="${escapeHtml(video.uid)}" tabindex="0">
      <div class="video-thumb">
        ${video.thumbnail && video.visibility === "public" ? `<img src="${escapeHtml(video.thumbnail)}" alt="">` : ""}
        <span class="play-dot">▶</span>
      </div>
      <div class="video-card-body">
        <h3>${escapeHtml(video.name)}</h3>
        <div class="meta-row"><span>${formatTime(video.duration)}</span><span class="badge badge-${video.readyToStream ? video.visibility : "processing"}">${video.readyToStream ? video.visibility : video.status?.state || "processing"}</span></div>
      </div>
    </article>`).join("");
  document.querySelector("#view").innerHTML = `
    <section class="panel">
      <div class="panel-header"><div><p class="eyebrow">Step 02</p><h2>Video library</h2></div><span class="muted">${state.videos.length} video${state.videos.length === 1 ? "" : "s"}</span></div>
      <div class="panel-body">${cards ? `<div class="video-grid">${cards}</div>` : `<div class="empty-state"><div><div class="upload-icon">□</div><h3>No videos yet</h3><p>Upload the first video to begin.</p><button class="button button-primary" data-go-upload>Upload video</button></div></div>`}</div>
    </section>`;
  document.querySelector("[data-go-upload]")?.addEventListener("click", () => navigate("upload"));
  document.querySelectorAll("[data-video-id]").forEach((card) => {
    const choose = () => selectVideo(card.dataset.videoId);
    card.addEventListener("click", choose);
    card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") choose(); });
  });
}

async function selectVideo(uid) {
  setBusy(true);
  try {
    const result = await api(`/videos/${uid}`);
    state.selected = result.video;
    state.playback = result.playback;
    state.playbackRequested = true;
    emitHostEvent("video.selected", { uid });
    navigate(result.video.readyToStream ? "edit" : "library");
    if (!result.video.readyToStream) toast("This video is still processing.");
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

function renderEditor() {
  const video = state.selected;
  if (!video) return navigate("library");
  const duration = Math.max(0.1, video.duration || 0.1);
  document.querySelector("#view").innerHTML = `
    <section class="panel">
      <div class="panel-header"><div><p class="eyebrow">Step 03</p><h2>Edit video</h2></div><span class="badge badge-${video.readyToStream ? video.visibility : "processing"}">${video.readyToStream ? video.visibility : "processing"}</span></div>
      <div class="panel-body">
        ${video.readyToStream ? "" : `<div class="status-banner info" style="margin-bottom:20px"><span>Cloudflare is processing this video (${escapeHtml(video.status?.pctComplete || "0")}% complete).</span><button class="button button-secondary button-small" id="check-status">Check status</button></div>`}
        <div class="editor-layout">
          <div>
            ${state.playback?.iframeUrl ? `<iframe class="player-frame" id="stream-player" src="${escapeHtml(state.playback.iframeUrl)}" title="Video preview" allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>` : `<div class="player-placeholder"><div><span class="loading"></span><p>${video.readyToStream ? "Preparing secure preview…" : "Preview appears when processing is complete."}</p></div></div>`}
            <div class="tool-card" style="margin-top:18px">
              <h3>Trim range <span class="trim-duration" id="clip-length">${formatTimecode(duration)}</span></h3>
              <p class="muted">An edited copy is created; the original remains in the library.</p>
              <div class="trim-summary" aria-live="polite">
                <span>Playhead <strong id="playhead-time">${formatTimecode(0)}</strong></span>
                <span>Selected <strong id="selected-time">${formatTimecode(duration)}</strong></span>
              </div>
              <div class="trim-timeline" id="trim-timeline">
                <div class="trim-track"><span class="trim-selection" id="trim-selection"></span><span class="trim-playhead" id="trim-playhead"></span></div>
                <input class="trim-range trim-range-start" id="trim-start-range" type="range" min="0" max="${duration}" step="0.1" value="0" aria-label="Trim start">
                <input class="trim-range trim-range-end" id="trim-end-range" type="range" min="0" max="${duration}" step="0.1" value="${duration}" aria-label="Trim end">
              </div>
              <div class="trim-scale"><span>${formatTimecode(0)}</span><span>${formatTimecode(duration)}</span></div>
              <div class="trim-actions button-row">
                <button class="button button-secondary button-small" id="set-trim-start" type="button">Set start at playhead</button>
                <button class="button button-secondary button-small" id="set-trim-end" type="button">Set end at playhead</button>
                <button class="button button-quiet button-small" id="preview-trim" type="button" ${state.playback?.iframeUrl ? "" : "disabled"}>Preview selection</button>
              </div>
              <div class="time-grid trim-timecodes">
                <label class="field"><span>Start time</span><input id="trim-start" inputmode="decimal" value="${formatTimecode(0)}" aria-describedby="timecode-help"></label>
                <label class="field"><span>End time</span><input id="trim-end" inputmode="decimal" value="${formatTimecode(duration)}" aria-describedby="timecode-help"></label>
              </div>
              <p class="timecode-help" id="timecode-help">Timecode format: HH:MM:SS.s. Use the arrow keys on either timeline handle for fine adjustments.</p>
              <button class="button button-primary" id="create-clip" data-busy ${video.readyToStream ? "" : "disabled"}>Create edited copy</button>
            </div>
          </div>
          <div class="editor-tools">
            <div class="tool-card">
              <h3>Video details</h3>
              <label class="field"><span>Name</span><input id="edit-name" value="${escapeHtml(video.name)}"></label>
              <span class="field-label">Access</span>
              ${visibilityOptions(video.visibility, "editVisibility")}
              <label class="field ${video.visibility === "temporary" ? "" : "hidden"}" id="edit-retention" style="margin-top:14px"><span>Delete automatically after</span><select id="edit-temporary-days"><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option><option value="180">180 days</option></select></label>
            </div>
            <div class="tool-card">
              <h3>Thumbnail</h3>
              <p class="muted">Choose the frame used in the library and customer email.</p>
              <div class="range-row"><span>Start</span><input id="thumbnail-pct" type="range" min="0" max="1" step="0.01" value="${video.thumbnailTimestampPct || 0}"><span id="thumbnail-time">${formatTime(duration * (video.thumbnailTimestampPct || 0))}</span></div>
            </div>
            <div class="button-row">
              <button class="button button-primary" id="save-settings" data-busy ${video.readyToStream ? "" : "disabled"}>Save settings</button>
              <button class="button button-secondary" id="generate-captions" data-busy ${video.readyToStream ? "" : "disabled"}>Generate captions</button>
            </div>
          </div>
        </div>
      </div>
    </section>`;
  bindEditor(duration);
  if (video.readyToStream && !state.playback && !state.playbackRequested) {
    state.playbackRequested = true;
    refreshSelected(false);
  }
}

function editorValues() {
  const visibility = document.querySelector('input[name="editVisibility"]:checked')?.value || "private";
  return {
    name: document.querySelector("#edit-name").value.trim(),
    visibility,
    temporaryDays: Number(document.querySelector("#edit-temporary-days")?.value || 30),
    thumbnailTimestampPct: Number(document.querySelector("#thumbnail-pct").value),
  };
}

function bindEditor(duration) {
  const start = document.querySelector("#trim-start");
  const end = document.querySelector("#trim-end");
  const startRange = document.querySelector("#trim-start-range");
  const endRange = document.querySelector("#trim-end-range");
  const selection = document.querySelector("#trim-selection");
  const playheadMarker = document.querySelector("#trim-playhead");
  const timeline = document.querySelector("#trim-timeline");
  const minimumClip = Math.min(0.1, duration);
  let playhead = 0;
  let player = null;

  const updatePlayhead = (value) => {
    playhead = Math.min(duration, Math.max(0, Number(value) || 0));
    playheadMarker.style.left = `${(playhead / duration) * 100}%`;
    document.querySelector("#playhead-time").textContent = formatTimecode(playhead);
  };

  const updateTrim = (changed = "start") => {
    let startValue = Math.min(duration, Math.max(0, Number(startRange.value)));
    let endValue = Math.min(duration, Math.max(0, Number(endRange.value)));
    if (endValue - startValue < minimumClip) {
      if (changed === "end") startValue = Math.max(0, endValue - minimumClip);
      else endValue = Math.min(duration, startValue + minimumClip);
    }
    startRange.value = startValue;
    endRange.value = endValue;
    start.value = formatTimecode(startValue);
    end.value = formatTimecode(endValue);
    selection.style.left = `${(startValue / duration) * 100}%`;
    selection.style.width = `${((endValue - startValue) / duration) * 100}%`;
    const selected = endValue - startValue;
    document.querySelector("#clip-length").textContent = formatTimecode(selected);
    document.querySelector("#selected-time").textContent = formatTimecode(selected);
  };

  const commitTimecode = (input, range, changed) => {
    const parsed = parseTimecode(input.value);
    if (!Number.isFinite(parsed)) {
      input.value = formatTimecode(Number(range.value));
      return toast("Enter a timecode such as 00:01:23.4.", "error");
    }
    range.value = Math.min(duration, Math.max(0, parsed));
    updateTrim(changed);
  };

  startRange.addEventListener("input", () => updateTrim("start"));
  endRange.addEventListener("input", () => updateTrim("end"));
  start.addEventListener("change", () => commitTimecode(start, startRange, "start"));
  end.addEventListener("change", () => commitTimecode(end, endRange, "end"));
  start.addEventListener("keydown", (event) => {
    if (event.key === "Enter") commitTimecode(start, startRange, "start");
  });
  end.addEventListener("keydown", (event) => {
    if (event.key === "Enter") commitTimecode(end, endRange, "end");
  });
  timeline.addEventListener("click", (event) => {
    if (event.target.matches("input")) return;
    const bounds = timeline.getBoundingClientRect();
    updatePlayhead(((event.clientX - bounds.left) / bounds.width) * duration);
    if (player) player.currentTime = playhead;
  });

  document.querySelector("#set-trim-start").addEventListener("click", () => {
    startRange.value = Math.min(playhead, Number(endRange.value) - minimumClip);
    updateTrim("start");
  });
  document.querySelector("#set-trim-end").addEventListener("click", () => {
    endRange.value = Math.max(playhead, Number(startRange.value) + minimumClip);
    updateTrim("end");
  });

  const iframe = document.querySelector("#stream-player");
  if (iframe && typeof window.Stream === "function") {
    player = window.Stream(iframe);
    player.addEventListener("timeupdate", () => {
      updatePlayhead(player.currentTime);
      if (player.currentTime >= Number(endRange.value)) player.pause();
    });
  }
  document.querySelector("#preview-trim").addEventListener("click", () => {
    if (!player) return;
    player.currentTime = Number(startRange.value);
    player.play();
  });
  updatePlayhead(0);
  updateTrim();
  const thumb = document.querySelector("#thumbnail-pct");
  thumb.addEventListener("input", () => { document.querySelector("#thumbnail-time").textContent = formatTime(duration * Number(thumb.value)); });
  document.querySelectorAll('input[name="editVisibility"]').forEach((radio) => radio.addEventListener("change", () => document.querySelector("#edit-retention").classList.toggle("hidden", radio.value !== "temporary" || !radio.checked)));
  document.querySelector("#check-status")?.addEventListener("click", () => refreshSelected());
  document.querySelector("#save-settings").addEventListener("click", saveSettings);
  document.querySelector("#create-clip").addEventListener("click", createClip);
  document.querySelector("#generate-captions").addEventListener("click", generateCaptions);
}

async function refreshSelected(notify = true) {
  try {
    const result = await api(`/videos/${state.selected.uid}`);
    state.selected = result.video;
    state.playback = result.playback;
    state.playbackRequested = true;
    renderEditor();
    if (notify) toast(result.video.readyToStream ? "Video is ready." : "Processing status updated.");
  } catch (error) { toast(error.message, "error"); }
}

async function saveSettings() {
  setBusy(true);
  try {
    const result = await api(`/videos/${state.selected.uid}/settings`, { method: "POST", body: JSON.stringify(editorValues()) });
    state.selected = result.video;
    state.playback = null;
    state.playbackRequested = false;
    emitHostEvent("video.updated", { video: result.video });
    await loadVideos(false);
    toast("Video settings saved.");
    await refreshSelected(false);
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

async function createClip() {
  const sourceUid = state.selected.uid;
  const values = editorValues();
  values.startTimeSeconds = parseTimecode(document.querySelector("#trim-start").value);
  values.endTimeSeconds = parseTimecode(document.querySelector("#trim-end").value);
  values.name = values.name.endsWith("– edit") ? values.name : `${values.name} – edit`;
  if (values.endTimeSeconds <= values.startTimeSeconds) return toast("The end time must be after the start time.", "error");
  setBusy(true);
  try {
    const result = await api(`/videos/${sourceUid}/clip`, { method: "POST", body: JSON.stringify(values) });
    state.selected = result.video;
    state.playback = null;
    state.playbackRequested = false;
    emitHostEvent("video.created", { video: result.video, sourceUid });
    toast("Edited copy created. Cloudflare is processing it.");
    await loadVideos(false);
    renderEditor();
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

async function generateCaptions() {
  setBusy(true);
  try {
    await api(`/videos/${state.selected.uid}/captions`, { method: "POST", body: JSON.stringify({ language: "en" }) });
    toast("English captions are being generated.");
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

function renderShare() {
  const video = state.selected;
  if (!video) return navigate("library");
  const expiry = video.visibility === "public" ? "Public links do not expire." : "The customer link can remain active for up to 24 hours.";
  document.querySelector("#view").innerHTML = `
    <section class="panel share-card">
      <div class="panel-header"><div><p class="eyebrow">Step 04</p><h2>Share video</h2></div><span class="badge badge-${video.visibility}">${video.visibility}</span></div>
      <div class="panel-body">
        <div class="share-summary">
          <div class="video-thumb">${video.thumbnail && video.visibility === "public" ? `<img src="${escapeHtml(video.thumbnail)}" alt="">` : ""}<span class="play-dot">▶</span></div>
          <div><h3>${escapeHtml(video.name)}</h3><p class="muted">${formatTime(video.duration)} · Created ${formatDate(video.created)}</p><p class="expiry-note">${expiry}</p></div>
        </div>
        <div class="grid-equal">
          <label class="field"><span>Link expiry</span><select id="share-expiry" ${video.visibility === "public" ? "disabled" : ""}><option value="0.25">15 minutes</option><option value="1">1 hour</option><option value="6">6 hours</option><option value="12">12 hours</option><option value="24" selected>24 hours</option></select></label>
          <div class="field"><span>Direct link</span><button class="button button-secondary" id="copy-link" data-busy ${video.readyToStream ? "" : "disabled"}>Create and copy link</button></div>
        </div>
        <div id="share-link-result"></div>
        <div class="form-divider"></div>
        <p class="eyebrow">Email with iRedMail</p>
        <h3>Send to a customer</h3>
        <form id="email-form" style="margin-top:18px">
          <div class="grid-equal">
            <label class="field"><span>Customer name</span><input name="recipientName" placeholder="Customer name" required></label>
            <label class="field"><span>Email address</span><input name="to" type="email" placeholder="customer@example.com" required></label>
          </div>
          <label class="field"><span>Subject</span><input name="subject" value="Your video: ${escapeHtml(video.name)}" required></label>
          <label class="field"><span>Message</span><textarea name="message">Here is the video we discussed. Click the preview image or button below to watch.</textarea></label>
          <button class="button button-primary" type="submit" data-busy ${video.readyToStream ? "" : "disabled"}>Review and send email</button>
        </form>
      </div>
    </section>`;
  document.querySelector("#copy-link").addEventListener("click", copyShareLink);
  document.querySelector("#email-form").addEventListener("submit", sendEmail);
}

async function createShareLink() {
  const expiresHours = Number(document.querySelector("#share-expiry")?.value || 24);
  const result = await api(`/videos/${state.selected.uid}/share`, { method: "POST", body: JSON.stringify({ expiresHours }) });
  return result.playback;
}

async function copyShareLink() {
  setBusy(true);
  try {
    const playback = await createShareLink();
    await navigator.clipboard.writeText(playback.watchUrl);
    document.querySelector("#share-link-result").innerHTML = `<div class="status-banner"><span>Link copied to clipboard${playback.expiresAt ? ` · expires ${new Date(playback.expiresAt).toLocaleString("en-AU")}` : ""}.</span></div>`;
    emitHostEvent("video.shared", { uid: state.selected.uid, watchUrl: playback.watchUrl, expiresAt: playback.expiresAt });
    toast("Video link copied.");
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

async function sendEmail(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const recipient = form.get("to");
  if (!window.confirm(`Send this video email to ${recipient}?`)) return;
  setBusy(true);
  try {
    const result = await api(`/videos/${state.selected.uid}/email`, {
      method: "POST",
      body: JSON.stringify({
        recipientName: form.get("recipientName"),
        to: recipient,
        subject: form.get("subject"),
        message: form.get("message"),
        expiresHours: Number(document.querySelector("#share-expiry")?.value || 24),
      }),
    });
    emitHostEvent("video.emailed", { uid: state.selected.uid, to: recipient, messageId: result.sent.messageId });
    document.querySelector("#share-link-result").innerHTML = `<div class="status-banner"><span>Email sent to ${escapeHtml(recipient)}.</span></div>`;
    event.currentTarget.reset();
    toast("Customer email sent.");
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

async function startApp() {
  shell();
  await loadVideos(false);
  const requestedVideo = new URLSearchParams(location.search).get("videoId");
  if (requestedVideo) {
    try { await selectVideo(requestedVideo); return; } catch { /* Fall back to upload. */ }
  }
  navigate(state.videos.length ? "library" : "upload");
  emitHostEvent("editor.ready", { app: state.session?.app, context: state.session?.context });
}

async function initialise() {
  if (demoMode) {
    state.session = { sub: "demo", name: "Vivad user", app: "standalone", role: "admin", mode: "standalone" };
    state.token = "demo";
    return startApp();
  }
  const params = new URLSearchParams(location.search);
  const embedToken = params.get("embedToken");
  if (embedToken) {
    try {
      const response = await fetch("/api/session/embed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: embedToken }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Embed sign-in failed.");
      acceptSession(result);
      params.delete("embedToken");
      history.replaceState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
    } catch (error) { return renderLogin(error.message); }
  }
  if (state.token) {
    try {
      const result = await api("/session");
      state.session = result.session;
      return startApp();
    } catch { logout(); return; }
  }
  renderLogin();
}

initialise();
