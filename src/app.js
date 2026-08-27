import "./styles.css";
import { isAbandonedUpload, patchTusChunk, ticketIsExpired, uploadStorageKey } from "./upload.js";

const app = document.querySelector("#app");
const demoMode = import.meta.env.DEV && new URLSearchParams(location.search).get("demo") === "1";
const demoOriginMismatch = demoMode && new URLSearchParams(location.search).get("origin-test") === "1";
const state = {
  token: sessionStorage.getItem("vivadVideoSession") || "",
  session: null,
  section: "upload",
  videos: [],
  management: null,
  selected: null,
  playback: null,
  playbackRequested: false,
  file: null,
  upload: null,
  createMode: "upload",
  recorder: null,
  recordingStream: null,
  recordingChunks: [],
  recordingStartedAt: 0,
  recordingTimer: null,
  busy: false,
};

const demoVideo = {
  uid: "demo-video-id",
  name: "Customer installation walkthrough.mp4",
  visibility: "expiring",
  access: "expiring",
  purpose: "client",
  description: "A secure customer video.",
  duration: 223,
  created: new Date().toISOString(),
  readyToStream: true,
  status: { state: "ready", pctComplete: "100" },
  thumbnail: null,
  thumbnailTimestampPct: 0.35,
  scheduledDeletion: null,
  allowedOrigins: demoOriginMismatch ? ["old-video-app.example"] : [],
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
  if (path === "/management") return { database: { configured: true }, catalogue: { counts: [{ status: "ready", count: 1 }], recentEvents: [] } };
  if (path.startsWith("/videos/demo-video-id") && (!options.method || options.method === "GET")) return { video: demoVideo, playback: null };
  if (path.startsWith("/videos/demo-video-id") && options.method === "DELETE") return { deleted: true, uid: demoVideo.uid };
  if (path.includes("/clip")) return { video: { ...demoVideo, uid: "demo-edited-video", name: "Customer installation – edit.mp4", status: { state: "queued", pctComplete: "0" }, readyToStream: false } };
  if (path.includes("/settings")) return { video: demoVideo };
  if (path.includes("/origins")) {
    demoVideo.allowedOrigins = [];
    return { video: demoVideo };
  }
  if (path.includes("/captions")) return { caption: { status: "inprogress" } };
  if (path.includes("/share")) return { share: { watchUrl: "https://example.com/video", expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() } };
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
        <p class="muted">Use the same email address and password you use for SAV Builder.</p>
        ${error ? `<div class="status-banner error" role="alert"><span>${escapeHtml(error)}</span></div>` : ""}
        <form id="login-form" style="margin-top:26px">
          <label class="field">
            <span>Email address</span>
            <input type="email" name="email" autocomplete="username" required autofocus>
          </label>
          <label class="field">
            <span>Password</span>
            <input type="password" name="password" autocomplete="current-password" required>
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
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
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
        ${["editor", "admin"].includes(state.session?.role) ? '<button data-section="manage"><span class="step-number">05</span>Manage</button>' : ""}
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
  if (section === "manage") {
    if (!["editor", "admin"].includes(state.session?.role)) return navigate("library");
    renderManagement();
    loadManagement();
  }
}

function visibilityOptions(current = "expiring", prefix = "visibility") {
  const options = [
    ["public", "Public", "Indexable and suitable for website publishing."],
    ["link", "Anyone with the link", "Unlisted and excluded from SEO publishing."],
    ["organisation", "Organisation", "Requires authenticated Vivad access."],
    ["team", "Team or group", "Restricted to an authorised team."],
    ["client", "Named client", "Shared through a Vivad-controlled watch page."],
    ["expiring", "Expiring link", "Protected playback through a time-limited share page."],
    ["temporary", "Temporary", "Protected and automatically deleted after retention."],
  ];
  return `
    <div class="visibility-options" role="radiogroup" aria-label="Video access">
      ${options.map(([value, label, description]) => `
        <div class="visibility-option">
          <input id="${prefix}-${value}" type="radio" name="${prefix}" value="${value}" aria-describedby="${prefix}-${value}-description" ${current === value ? "checked" : ""}>
          <label for="${prefix}-${value}">
            <span class="visibility-radio" aria-hidden="true"></span>
            <span class="visibility-copy"><strong>${label}</strong><small id="${prefix}-${value}-description">${description}</small></span>
            <span class="visibility-selected" aria-hidden="true">Selected</span>
          </label>
        </div>`).join("")}
    </div>`;
}

function purposeOptions(current = "general") {
  return `<label class="field"><span>Purpose</span><select name="purpose">
    ${[["website", "Website content"], ["training", "Training"], ["sop", "SOP"], ["internal", "Internal update"], ["client", "Client message"], ["general", "General video"]]
      .map(([value, label]) => `<option value="${value}" ${current === value ? "selected" : ""}>${label}</option>`).join("")}
  </select></label>`;
}

function creationDetails(title = "Video details") {
  const initialPurpose = state.session?.purpose || "general";
  const initialAccess = { website: "public", training: "organisation", sop: "organisation", internal: "organisation", client: "client", general: "link" }[initialPurpose] || "link";
  return `<div class="creation-details"><h3>${title}</h3>
    <label class="field"><span>Video name</span><input name="name" value="${escapeHtml(state.file?.name || "")}" placeholder="Customer video" required></label>
    ${purposeOptions(initialPurpose)}
    <label class="field"><span>Description</span><textarea name="description" placeholder="What this video covers"></textarea></label>
    <span class="field-label">Access</span>${visibilityOptions(initialAccess, "uploadVisibility")}
    <label class="field hidden" id="upload-retention" style="margin-top:14px"><span>Delete automatically after</span><select name="temporaryDays"><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option><option value="180">180 days</option></select></label>
  </div>`;
}

function renderUpload() {
  const file = state.file;
  document.querySelector("#view").innerHTML = `
    <section class="panel">
      <div class="panel-header"><div><p class="eyebrow">Step 01</p><h2>Create a video</h2></div><span class="badge badge-expiring">Secure media workspace</span></div>
      <div class="panel-body">
        <div class="creation-tabs" role="tablist" aria-label="Creation source">
          ${[["upload", "Upload a file"], ["record", "Record"], ["import", "Import a link"]].map(([value, label]) => `<button type="button" role="tab" aria-selected="${state.createMode === value}" class="button ${state.createMode === value ? "button-primary" : "button-quiet"}" data-create-mode="${value}">${label}</button>`).join("")}
        </div>
        <div class="grid-two create-workspace">
        <div class="create-source ${state.createMode === "upload" ? "" : "hidden"}" data-create-panel="upload">
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
        <div class="create-source ${state.createMode === "record" ? "" : "hidden"}" data-create-panel="record">
          <div class="record-stage"><video id="record-preview" autoplay muted playsinline></video><div id="record-placeholder"><div class="upload-icon">●</div><h3>Record in your browser</h3><p class="muted">Camera, screen or audio narration. You will preview the result before uploading.</p></div></div>
          <div class="record-controls">
            <label class="field"><span>Recording type</span><select id="record-type"><option value="camera">Camera and microphone</option><option value="screen">Screen and microphone</option><option value="screen-camera">Screen with camera preview</option><option value="audio">Audio-only narration</option></select></label>
            <label class="field"><span>Countdown</span><select id="record-countdown"><option value="3">3 seconds</option><option value="5">5 seconds</option><option value="0">No countdown</option></select></label>
            <div class="button-row"><button class="button button-primary" id="start-recording" type="button">Start recording</button><button class="button button-secondary hidden" id="pause-recording" type="button">Pause</button><button class="button button-danger hidden" id="stop-recording" type="button">Stop</button><span id="record-elapsed" aria-live="polite">00:00</span></div>
          </div>
        </div>
        <div class="create-source ${state.createMode === "import" ? "" : "hidden"}" data-create-panel="import">
          <div class="tool-card"><h3>Import a direct video-file URL</h3><p class="muted">For an HTTPS media file in R2, S3, GCS or another public host. The host must support HEAD and ranged GET requests.</p><label class="field"><span>Direct file URL</span><input id="direct-import-url" type="url" placeholder="https://example.com/video.mp4"></label><button class="button button-secondary" id="import-direct" type="button">Import to Cloudflare</button></div>
          <div class="tool-card" style="margin-top:18px"><h3>Add YouTube or Vimeo</h3><p class="muted">Vivad stores an external reference and uses the official provider player. Editing and Cloudflare privacy require the original file.</p><label class="field"><span>Provider URL</span><input id="external-video-url" type="url" placeholder="https://www.youtube.com/watch?v=..."></label><button class="button button-secondary" id="add-external" type="button">Add external reference</button><p class="expiry-note">Requires a configured production video database; audiovisual content is never downloaded.</p></div>
        </div>
        <form id="upload-form">
          ${creationDetails()}
          <label class="field"><span>Maximum expected duration</span><select name="maxDurationSeconds"><option value="600">10 minutes</option><option value="1800">30 minutes</option><option value="3600" selected>1 hour</option><option value="7200">2 hours</option><option value="18000">5 hours</option></select></label>
          <p class="expiry-note">Temporary deletion starts at 30 days. Protected sharing uses a stable Vivad watch page and fresh playback tokens.</p>
          <button class="button button-primary" type="submit" data-busy ${file ? "" : "disabled"}>Upload to Cloudflare</button>
        </form>
      </div></div>
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
  document.querySelectorAll("[data-create-mode]").forEach((button) => button.addEventListener("click", () => { state.createMode = button.dataset.createMode; renderUpload(); }));
  document.querySelector("#start-recording")?.addEventListener("click", startRecording);
  document.querySelector("#pause-recording")?.addEventListener("click", toggleRecordingPause);
  document.querySelector("#stop-recording")?.addEventListener("click", stopRecording);
  document.querySelector("#import-direct")?.addEventListener("click", importDirectUrl);
  document.querySelector("#add-external")?.addEventListener("click", addExternalVideo);
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

function preferredRecordingMimeType() {
  return ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "audio/webm"]
    .find((type) => window.MediaRecorder?.isTypeSupported(type)) || "";
}

async function countdown(seconds) {
  const target = document.querySelector("#record-placeholder");
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    if (target) target.innerHTML = `<div class="countdown">${remaining}</div><p>Recording starts shortly…</p>`;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function screenWithCameraStream() {
  const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  const camera = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  const canvas = document.createElement("canvas");
  const screenVideo = document.createElement("video");
  const cameraVideo = document.createElement("video");
  screenVideo.srcObject = screen;
  cameraVideo.srcObject = camera;
  screenVideo.muted = cameraVideo.muted = true;
  await Promise.all([screenVideo.play(), cameraVideo.play()]);
  canvas.width = screenVideo.videoWidth || 1280;
  canvas.height = screenVideo.videoHeight || 720;
  const context = canvas.getContext("2d");
  const draw = () => {
    context.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);
    const bubbleWidth = Math.round(canvas.width * 0.22);
    const bubbleHeight = Math.round(bubbleWidth * 0.75);
    const margin = Math.round(canvas.width * 0.025);
    context.save();
    context.beginPath();
    context.roundRect(canvas.width - bubbleWidth - margin, canvas.height - bubbleHeight - margin, bubbleWidth, bubbleHeight, 18);
    context.clip();
    context.drawImage(cameraVideo, canvas.width - bubbleWidth - margin, canvas.height - bubbleHeight - margin, bubbleWidth, bubbleHeight);
    context.restore();
    state.compositionFrame = requestAnimationFrame(draw);
  };
  draw();
  const composed = canvas.captureStream(30);
  const audioTrack = camera.getAudioTracks()[0] || screen.getAudioTracks()[0];
  if (audioTrack) composed.addTrack(audioTrack);
  composed._sourceStreams = [screen, camera];
  return composed;
}

async function startRecording() {
  if (!window.isSecureContext || !navigator.mediaDevices || !window.MediaRecorder) return toast("Recording requires a supported browser over HTTPS.", "error");
  const kind = document.querySelector("#record-type").value;
  const seconds = Number(document.querySelector("#record-countdown").value || 0);
  try {
    await countdown(seconds);
    let stream;
    if (kind === "camera") stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (kind === "audio") stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (kind === "screen") {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream = new MediaStream([...screen.getVideoTracks(), ...(microphone.getAudioTracks().length ? microphone.getAudioTracks() : screen.getAudioTracks())]);
      stream._sourceStreams = [screen, microphone];
    }
    if (kind === "screen-camera") stream = await screenWithCameraStream();
    state.recordingStream = stream;
    state.recordingChunks = [];
    const preview = document.querySelector("#record-preview");
    preview.srcObject = stream;
    preview.classList.remove("hidden");
    document.querySelector("#record-placeholder").classList.add("hidden");
    const mimeType = preferredRecordingMimeType();
    state.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    state.recorder.addEventListener("dataavailable", (event) => { if (event.data.size) state.recordingChunks.push(event.data); });
    state.recorder.addEventListener("stop", finishRecording, { once: true });
    stream.getVideoTracks()[0]?.addEventListener("ended", () => { if (state.recorder?.state !== "inactive") stopRecording(); }, { once: true });
    state.recorder.start(1000);
    state.recordingStartedAt = Date.now();
    state.recordingTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - state.recordingStartedAt) / 1000);
      const target = document.querySelector("#record-elapsed");
      if (target) target.textContent = formatTime(elapsed);
    }, 500);
    document.querySelector("#start-recording").classList.add("hidden");
    document.querySelector("#pause-recording").classList.remove("hidden");
    document.querySelector("#stop-recording").classList.remove("hidden");
  } catch (error) { toast(error.name === "NotAllowedError" ? "Camera, microphone or screen permission was not granted." : error.message, "error"); }
}

function toggleRecordingPause() {
  if (!state.recorder || state.recorder.state === "inactive") return;
  const paused = state.recorder.state === "paused";
  paused ? state.recorder.resume() : state.recorder.pause();
  document.querySelector("#pause-recording").textContent = paused ? "Pause" : "Resume";
}

function stopRecording() {
  if (state.recorder?.state && state.recorder.state !== "inactive") state.recorder.stop();
}

function finishRecording() {
  clearInterval(state.recordingTimer);
  cancelAnimationFrame(state.compositionFrame);
  const mimeType = state.recorder?.mimeType || "video/webm";
  const blob = new Blob(state.recordingChunks, { type: mimeType });
  const extension = mimeType.startsWith("audio/") ? "webm" : "webm";
  state.recordingStream?._sourceStreams?.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
  state.recordingStream?.getTracks().forEach((track) => track.stop());
  state.file = new File([blob], `Vivad recording ${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.${extension}`, { type: mimeType, lastModified: Date.now() });
  state.createMode = "upload";
  state.recorder = null;
  state.recordingStream = null;
  renderUpload();
  toast("Recording is ready. Review its details, then upload it.");
}

async function importDirectUrl() {
  const form = new FormData(document.querySelector("#upload-form"));
  const url = document.querySelector("#direct-import-url").value;
  setBusy(true);
  try {
    const result = await api("/imports/direct", { method: "POST", body: JSON.stringify({
      url, name: form.get("name"), purpose: form.get("purpose"), description: form.get("description"),
      access: form.get("uploadVisibility"), temporaryDays: Number(form.get("temporaryDays") || 30),
    }) });
    state.selected = result.video;
    emitHostEvent("video.created", { uid: result.video.uid, source: "direct-url" });
    await loadVideos(false);
    navigate("library");
    toast("Import started. Cloudflare is processing the video.");
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

async function addExternalVideo() {
  const form = new FormData(document.querySelector("#upload-form"));
  setBusy(true);
  try {
    const result = await api("/videos/external", { method: "POST", body: JSON.stringify({
      url: document.querySelector("#external-video-url").value, name: form.get("name"), purpose: form.get("purpose"),
      description: form.get("description"), access: form.get("uploadVisibility"),
    }) });
    state.selected = result.video;
    emitHostEvent("video.created", { id: result.video.id, provider: result.video.provider });
    toast("External video reference added.");
    navigate("library");
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

async function startUpload(event) {
  event.preventDefault();
  if (!state.file) return toast("Select a video first.", "error");
  const form = new FormData(event.currentTarget);
  const visibility = form.get("uploadVisibility");
  setBusy(true);
  showUploadProgress(0, "Creating a secure upload…");
  try {
    let ticket = await resumableUploadTicket(state.file);
    if (ticket) {
      showUploadProgress(0, "Resuming the interrupted upload…");
      toast("Resuming the previous upload instead of creating a duplicate.");
    } else {
      ticket = await api("/uploads/tus", {
        method: "POST",
        body: JSON.stringify({
          fileName: form.get("name") || state.file.name,
          fileSize: state.file.size,
          maxDurationSeconds: Number(form.get("maxDurationSeconds")),
          access: visibility,
          visibility,
          purpose: form.get("purpose"),
          description: form.get("description"),
          temporaryDays: Number(form.get("temporaryDays") || 30),
        }),
      });
      localStorage.setItem(uploadStorageKey(state.file), JSON.stringify(ticket));
    }
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

async function resumableUploadTicket(file) {
  const storageKey = uploadStorageKey(file);
  const saved = localStorage.getItem(storageKey);
  if (!saved) return null;
  let ticket;
  try { ticket = JSON.parse(saved); }
  catch { localStorage.removeItem(storageKey); return null; }
  if (!ticket?.uid || !ticket?.uploadURL || ticketIsExpired(ticket)) {
    localStorage.removeItem(storageKey);
    return null;
  }
  let response;
  try {
    response = await fetch(ticket.uploadURL, { method: "HEAD", headers: { "Tus-Resumable": "1.0.0" } });
  } catch {
    throw new Error("The previous upload could not be checked. Check your connection and try again; no duplicate upload was created.");
  }
  if (!response.ok) {
    localStorage.removeItem(storageKey);
    return null;
  }
  const offset = Number(response.headers.get("Upload-Offset") || 0);
  if (!Number.isFinite(offset) || offset < 0 || offset > file.size) {
    throw new Error("Cloudflare returned an invalid resume position. No duplicate upload was created.");
  }
  return ticket;
}

function showUploadProgress(percentage, label, error = false) {
  if (state.upload) state.upload.progress = percentage;
  const target = document.querySelector("#upload-progress");
  if (!target) return;
  if (!target.querySelector(".progress-card")) {
    target.innerHTML = `<div class="progress-card"><div class="progress-row"><span data-progress-label></span><span data-progress-value></span></div><div class="progress-track" role="progressbar" aria-label="Video upload progress" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar"></div></div></div>`;
  }
  const value = Math.max(0, Math.min(100, Number(percentage) || 0));
  target.querySelector("[data-progress-label]").textContent = label;
  target.querySelector("[data-progress-value]").textContent = `${Math.round(value)}%`;
  const track = target.querySelector(".progress-track");
  const bar = target.querySelector(".progress-bar");
  track.setAttribute("aria-valuenow", String(Math.round(value)));
  bar.style.width = `${value}%`;
  bar.style.background = error ? "#e4002b" : "";
}

async function uploadTus(file, ticket, onProgress) {
  const chunkSize = 50 * 1024 * 1024;
  const storageKey = uploadStorageKey(file);
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
        response = await patchTusChunk(ticket.uploadURL, chunk, offset, file.size, onProgress);
        if (response.ok) break;
        lastError = new Error(`Upload failed (${response.status}).`);
      } catch (error) { lastError = error; }
    }
    if (!response?.ok) throw lastError || new Error("Upload interrupted.");
    offset = Number(response.uploadOffset || next);
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
  const canManageVideos = ["editor", "admin"].includes(state.session?.role);
  const abandonedUploads = state.videos.filter(isAbandonedUpload);
  const cards = state.videos.map((video) => {
    const pendingUpload = String(video.status?.state || "").toLowerCase() === "pendingupload";
    const statusLabel = video.readyToStream ? video.visibility : isAbandonedUpload(video) ? "Abandoned upload" : pendingUpload ? "Pending upload" : video.status?.state || "processing";
    return `
    <article class="video-card ${state.selected?.uid === video.uid ? "selected" : ""}" data-video-id="${escapeHtml(video.uid)}" tabindex="0">
      <div class="video-thumb">
        ${video.thumbnail && video.visibility === "public" ? `<img src="${escapeHtml(video.thumbnail)}" alt="">` : ""}
        <span class="play-dot">▶</span>
      </div>
      <div class="video-card-body">
        <h3>${escapeHtml(video.name)}</h3>
        <div class="meta-row"><span>${formatTime(video.duration)}</span><span class="badge badge-${video.readyToStream ? video.visibility : "processing"}">${escapeHtml(statusLabel)}</span></div>
        ${pendingUpload && canManageVideos ? `<button class="button button-danger button-small pending-delete" type="button" data-delete-video-id="${escapeHtml(video.uid)}" data-busy>Delete incomplete upload</button>` : ""}
      </div>
    </article>`;
  }).join("");
  document.querySelector("#view").innerHTML = `
    <section class="panel">
      <div class="panel-header"><div><p class="eyebrow">Step 02</p><h2>Video library</h2></div><div class="library-summary"><span class="muted">${state.videos.length} video${state.videos.length === 1 ? "" : "s"}</span>${abandonedUploads.length && canManageVideos ? `<button class="button button-danger button-small" type="button" id="cleanup-abandoned" data-busy>Remove ${abandonedUploads.length} abandoned upload${abandonedUploads.length === 1 ? "" : "s"}</button>` : ""}</div></div>
      <div class="panel-body">${cards ? `<div class="video-grid">${cards}</div>` : `<div class="empty-state"><div><div class="upload-icon">□</div><h3>No videos yet</h3><p>Upload the first video to begin.</p><button class="button button-primary" data-go-upload>Upload video</button></div></div>`}</div>
    </section>`;
  document.querySelector("[data-go-upload]")?.addEventListener("click", () => navigate("upload"));
  document.querySelector("#cleanup-abandoned")?.addEventListener("click", () => cleanupAbandonedUploads(abandonedUploads));
  document.querySelectorAll("[data-delete-video-id]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteVideo(state.videos.find((video) => video.uid === button.dataset.deleteVideoId));
  }));
  document.querySelectorAll("[data-video-id]").forEach((card) => {
    const choose = (event) => { if (!event?.target?.closest?.("[data-delete-video-id]")) selectVideo(card.dataset.videoId); };
    card.addEventListener("click", choose);
    card.addEventListener("keydown", (event) => { if (event.target === card && (event.key === "Enter" || event.key === " ")) choose(); });
  });
}

function uploadState(video) {
  if (isAbandonedUpload(video)) return "abandoned";
  if (video.readyToStream) return "ready";
  const status = String(video.status?.state || "processing").toLowerCase();
  if (status === "pendingupload") return "pending";
  if (status === "error") return "error";
  return "processing";
}

function managementTotals() {
  return state.videos.reduce((totals, video) => {
    const status = uploadState(video);
    totals.total += 1;
    totals[status] += 1;
    return totals;
  }, { total: 0, ready: 0, processing: 0, pending: 0, abandoned: 0, error: 0 });
}

async function loadManagement() {
  try {
    state.management = await api("/management");
  } catch (error) {
    state.management = { database: { configured: true, available: false, error: error.message }, catalogue: null };
  }
  if (state.section === "manage") renderManagement();
}

function renderManagement() {
  const totals = managementTotals();
  const actionable = state.videos.filter((video) => uploadState(video) !== "ready");
  const abandoned = state.videos.filter(isAbandonedUpload);
  const database = state.management?.database;
  const databaseCopy = !database
    ? "Checking catalogue…"
    : database.configured === false
      ? "Database not configured"
      : database.available === false
        ? database.error || "Catalogue unavailable"
        : "PostgreSQL catalogue connected";
  const rows = actionable.map((video) => {
    const status = uploadState(video);
    const canResume = status === "pending" || status === "abandoned";
    return `<tr>
      <td><strong>${escapeHtml(video.name)}</strong><small>${escapeHtml(video.uid)}</small></td>
      <td><span class="badge badge-processing">${escapeHtml(status)}</span></td>
      <td>${escapeHtml(video.status?.pctComplete || "0")}%</td>
      <td>${escapeHtml(formatDate(video.created))}</td>
      <td><div class="button-row">${canResume ? `<button class="button button-secondary button-small" type="button" data-resume-upload="${escapeHtml(video.uid)}">Resume</button>` : ""}<button class="button button-danger button-small" type="button" data-manage-delete="${escapeHtml(video.uid)}" data-busy>Delete</button></div></td>
    </tr>`;
  }).join("");
  document.querySelector("#view").innerHTML = `
    <section class="panel">
      <div class="panel-header"><div><p class="eyebrow">Operations</p><h2>Upload management</h2></div><div class="library-summary"><span class="database-status ${database?.configured && database?.available !== false ? "connected" : ""}">${escapeHtml(databaseCopy)}</span><button class="button button-secondary button-small" id="refresh-management" type="button" data-busy>Refresh</button></div></div>
      <div class="panel-body">
        <div class="management-stats">
          ${[["Total", totals.total], ["Ready", totals.ready], ["Processing", totals.processing], ["Pending", totals.pending], ["Abandoned", totals.abandoned], ["Failed", totals.error]].map(([label, value]) => `<div class="management-stat"><span>${label}</span><strong>${value}</strong></div>`).join("")}
        </div>
        ${abandoned.length ? `<div class="status-banner error management-alert"><span>${abandoned.length} upload${abandoned.length === 1 ? " has" : "s have"} expired without completing.</span><button class="button button-danger button-small" id="manage-cleanup-abandoned" type="button" data-busy>Remove abandoned</button></div>` : ""}
        <div class="management-table-wrap">
          ${rows ? `<table class="management-table"><thead><tr><th>Video</th><th>Status</th><th>Progress</th><th>Created</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty-state compact"><div><h3>All uploads are healthy</h3><p>No pending, abandoned or failed uploads need attention.</p></div></div>`}
        </div>
        <p class="expiry-note">Cloudflare Stream stores the video files. PostgreSQL stores catalogue status and audit events only.</p>
      </div>
    </section>`;
  document.querySelector("#refresh-management")?.addEventListener("click", async () => {
    setBusy(true);
    const refreshed = await loadVideos(false);
    if (refreshed) await loadManagement();
    setBusy(false);
    if (refreshed) toast("Upload statuses refreshed.");
  });
  document.querySelector("#manage-cleanup-abandoned")?.addEventListener("click", () => cleanupAbandonedUploads(abandoned));
  document.querySelectorAll("[data-resume-upload]").forEach((button) => button.addEventListener("click", () => {
    navigate("upload");
    toast("Reselect the same original file. Vivad will resume from Cloudflare's confirmed upload position.");
  }));
  document.querySelectorAll("[data-manage-delete]").forEach((button) => button.addEventListener("click", () => deleteVideo(state.videos.find((video) => video.uid === button.dataset.manageDelete))));
}

function playbackAllowedOnCurrentHost(video) {
  const origins = Array.isArray(video?.allowedOrigins) ? video.allowedOrigins : [];
  if (!origins.length) return true;
  const hostname = window.location.hostname.toLowerCase();
  return origins.some((origin) => {
    const allowed = String(origin || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
    if (allowed.startsWith("*.")) {
      const root = allowed.slice(2);
      return hostname !== root && hostname.endsWith(`.${root}`);
    }
    return hostname === allowed;
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
    if (!result.video.readyToStream) {
      const pending = String(result.video.status?.state || "").toLowerCase() === "pendingupload";
      toast(pending ? "This upload is incomplete. Reselect the original file to resume it, or delete the incomplete upload." : "This video is still processing.", pending ? "error" : "success");
    }
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

function renderEditor() {
  const video = state.selected;
  if (!video) return navigate("library");
  const duration = Math.max(0.1, video.duration || 0.1);
  const playbackOriginBlocked = video.readyToStream && !playbackAllowedOnCurrentHost(video);
  document.querySelector("#view").innerHTML = `
    <section class="panel">
      <div class="panel-header"><div><p class="eyebrow">Step 03</p><h2>Edit video</h2></div><span class="badge badge-${video.readyToStream ? video.visibility : "processing"}">${video.readyToStream ? video.visibility : "processing"}</span></div>
      <div class="panel-body">
        ${video.readyToStream ? "" : `<div class="status-banner info" style="margin-bottom:20px"><span>Cloudflare is processing this video (${escapeHtml(video.status?.pctComplete || "0")}% complete).</span><button class="button button-secondary button-small" id="check-status">Check status</button></div>`}
        ${playbackOriginBlocked ? `<div class="status-banner error" style="margin-bottom:20px" role="alert"><span>This video's playback settings still exclude ${escapeHtml(window.location.hostname)}.</span>${["editor", "admin"].includes(state.session?.role) ? `<button class="button button-secondary button-small" id="repair-playback-origin" type="button">Repair playback</button>` : `<span>Ask an editor to repair it.</span>`}</div>` : ""}
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
                <button class="button button-quiet button-small" id="nudge-start-back" type="button" aria-label="Move start back one tenth of a second">Start −0.1s</button>
                <button class="button button-quiet button-small" id="nudge-start-forward" type="button" aria-label="Move start forward one tenth of a second">Start +0.1s</button>
                <button class="button button-quiet button-small" id="nudge-end-back" type="button" aria-label="Move end back one tenth of a second">End −0.1s</button>
                <button class="button button-quiet button-small" id="nudge-end-forward" type="button" aria-label="Move end forward one tenth of a second">End +0.1s</button>
                <button class="button button-quiet button-small" id="reset-trim" type="button">Reset trim</button>
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
              ${purposeOptions(video.purpose || "general").replace('name="purpose"', 'id="edit-purpose" name="purpose"')}
              <label class="field"><span>Description</span><textarea id="edit-description">${escapeHtml(video.description || "")}</textarea></label>
              <span class="field-label">Access</span>
              ${visibilityOptions(video.visibility, "editVisibility")}
              <p class="access-change-status hidden" id="access-change-status" role="status">Access changed. Save changes to apply it.</p>
              <label class="field ${video.visibility === "temporary" ? "" : "hidden"}" id="edit-retention" style="margin-top:14px"><span>Delete automatically after</span><select id="edit-temporary-days"><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option><option value="180">180 days</option></select></label>
            </div>
            <div class="tool-card">
              <h3>Thumbnail</h3>
              <p class="muted">Choose the frame used in the library and customer email.</p>
              <div class="range-row"><span>Start</span><input id="thumbnail-pct" type="range" min="0" max="1" step="0.01" value="${video.thumbnailTimestampPct || 0}"><span id="thumbnail-time">${formatTime(duration * (video.thumbnailTimestampPct || 0))}</span></div>
            </div>
            <div class="tool-card">
              <h3>Workflow metadata</h3>
              <p class="muted">Used for training, SOP and internal organisation. A database is required for reliable per-user acknowledgement tracking.</p>
              <label class="field"><span>Department or team</span><input id="edit-department" value="${escapeHtml(video.core?.department || "")}"></label>
              <label class="field"><span>Training topic</span><input id="edit-topic" value="${escapeHtml(video.core?.topic || "")}"></label>
              <label class="field"><span>SOP category</span><input id="edit-category" value="${escapeHtml(video.core?.category || "")}"></label>
              <div class="grid-equal"><label class="field"><span>Content owner</span><input id="edit-owner" value="${escapeHtml(video.core?.contentOwner || "")}"></label><label class="field"><span>Version</span><input id="edit-version" value="${escapeHtml(video.core?.version || "1")}"></label></div>
              <div class="grid-equal"><label class="field"><span>Review date</span><input id="edit-review-date" type="date" value="${escapeHtml(video.core?.reviewDate || "")}"></label><label class="field"><span>Content expiry</span><input id="edit-expiry-date" type="date" value="${escapeHtml(video.core?.expiryDate?.slice?.(0, 10) || "")}"></label></div>
              <label class="field"><span>Related document links (one per line)</span><textarea id="edit-related-links">${escapeHtml((video.core?.relatedLinks || []).join("\n"))}</textarea></label>
              <label class="check-field"><input id="edit-acknowledgement" type="checkbox" ${video.core?.requiredAcknowledgement ? "checked" : ""}><span>Require acknowledgement when server-side tracking is configured</span></label>
            </div>
            <div class="tool-card">
              <h3>Captions and downloads</h3>
              <p class="muted">Generate English captions, manage WebVTT files, or request MP4/M4A derivatives from Cloudflare.</p>
              <div class="grid-equal"><label class="field"><span>Caption language</span><input id="caption-language" value="en" maxlength="20"></label><label class="field"><span>Upload WebVTT</span><input id="caption-file" type="file" accept=".vtt,text/vtt"></label></div>
              <div class="button-row"><button class="button button-secondary button-small" id="refresh-media" type="button">Refresh status</button><button class="button button-secondary button-small" id="generate-mp4" type="button">Generate MP4</button><button class="button button-secondary button-small" id="generate-audio" type="button">Generate audio</button></div>
              <div id="media-assets" class="media-assets"><p class="muted">Select Refresh status to list captions and downloads.</p></div>
            </div>
            <div class="button-row">
              <button class="button button-primary" id="save-settings" data-busy ${video.readyToStream ? "" : "disabled"}>Save settings</button>
              <button class="button button-quiet" id="undo-settings" type="button">Undo unsaved changes</button>
              <button class="button button-secondary" id="generate-captions" data-busy ${video.readyToStream ? "" : "disabled"}>Generate captions</button>
            </div>
            ${["editor", "admin"].includes(state.session?.role) ? `<div class="tool-card danger-zone"><h3>Delete video</h3><p class="muted">Permanently removes this video and its stored Stream copies. This cannot be undone.</p><button class="button button-danger" id="delete-video" type="button" data-busy>Delete video</button></div>` : ""}
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
  const visibility = document.querySelector('input[name="editVisibility"]:checked')?.value || "expiring";
  return {
    name: document.querySelector("#edit-name").value.trim(),
    purpose: document.querySelector("#edit-purpose").value,
    description: document.querySelector("#edit-description").value.trim(),
    visibility,
    temporaryDays: Number(document.querySelector("#edit-temporary-days")?.value || 30),
    thumbnailTimestampPct: Number(document.querySelector("#thumbnail-pct").value),
    department: document.querySelector("#edit-department").value.trim(),
    topic: document.querySelector("#edit-topic").value.trim(),
    category: document.querySelector("#edit-category").value.trim(),
    owner: document.querySelector("#edit-owner").value.trim(),
    version: document.querySelector("#edit-version").value.trim(),
    reviewDate: document.querySelector("#edit-review-date").value,
    expiryDate: document.querySelector("#edit-expiry-date").value,
    relatedLinks: document.querySelector("#edit-related-links").value.trim(),
    requiredAcknowledgement: document.querySelector("#edit-acknowledgement").checked,
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
  const nudge = (range, delta, changed) => {
    range.value = Math.min(duration, Math.max(0, Number(range.value) + delta));
    updateTrim(changed);
  };
  document.querySelector("#nudge-start-back").addEventListener("click", () => nudge(startRange, -0.1, "start"));
  document.querySelector("#nudge-start-forward").addEventListener("click", () => nudge(startRange, 0.1, "start"));
  document.querySelector("#nudge-end-back").addEventListener("click", () => nudge(endRange, -0.1, "end"));
  document.querySelector("#nudge-end-forward").addEventListener("click", () => nudge(endRange, 0.1, "end"));
  document.querySelector("#reset-trim").addEventListener("click", () => {
    startRange.value = 0;
    endRange.value = duration;
    updatePlayhead(0);
    updateTrim();
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
  const markSettingsDirty = (message = "Settings changed. Save changes to apply them.") => {
    const saveButton = document.querySelector("#save-settings");
    const status = document.querySelector("#access-change-status");
    saveButton.textContent = "Save changes";
    saveButton.classList.add("button-dirty");
    status.textContent = message;
    status.classList.remove("hidden");
  };
  thumb.addEventListener("input", () => {
    document.querySelector("#thumbnail-time").textContent = formatTime(duration * Number(thumb.value));
    markSettingsDirty("Thumbnail changed. Save changes to apply it.");
  });
  document.querySelector("#edit-name").addEventListener("input", () => markSettingsDirty("Name changed. Save changes to apply it."));
  document.querySelector("#edit-purpose").addEventListener("change", () => markSettingsDirty("Purpose changed. Save changes to apply it."));
  document.querySelector("#edit-description").addEventListener("input", () => markSettingsDirty("Description changed. Save changes to apply it."));
  ["edit-department", "edit-topic", "edit-category", "edit-owner", "edit-version", "edit-review-date", "edit-expiry-date", "edit-related-links", "edit-acknowledgement"].forEach((id) => {
    document.querySelector(`#${id}`).addEventListener(id === "edit-acknowledgement" || id.includes("date") ? "change" : "input", () => markSettingsDirty("Workflow metadata changed. Save changes to apply it."));
  });
  document.querySelector("#edit-temporary-days").addEventListener("change", () => markSettingsDirty("Retention changed. Save changes to apply it."));
  document.querySelectorAll('input[name="editVisibility"]').forEach((radio) => radio.addEventListener("change", () => {
    document.querySelector("#edit-retention").classList.toggle("hidden", radio.value !== "temporary" || !radio.checked);
    markSettingsDirty("Access changed. Save changes to apply it.");
  }));
  document.querySelector("#check-status")?.addEventListener("click", () => refreshSelected());
  document.querySelector("#repair-playback-origin")?.addEventListener("click", repairPlaybackOrigin);
  document.querySelector("#save-settings").addEventListener("click", saveSettings);
  document.querySelector("#undo-settings").addEventListener("click", renderEditor);
  document.querySelector("#create-clip").addEventListener("click", createClip);
  document.querySelector("#generate-captions").addEventListener("click", generateCaptions);
  document.querySelector("#refresh-media").addEventListener("click", loadMediaAssets);
  document.querySelector("#caption-file").addEventListener("change", uploadCaptionFile);
  document.querySelector("#generate-mp4").addEventListener("click", () => generateDownload("default"));
  document.querySelector("#generate-audio").addEventListener("click", () => generateDownload("audio"));
  document.querySelector("#delete-video")?.addEventListener("click", () => deleteVideo());
}

async function requestVideoDeletion(video) {
  return api(`/videos/${video.uid}`, { method: "DELETE", body: JSON.stringify({ confirmation: "DELETE", confirmUid: video.uid }) });
}

async function deleteVideo(video = state.selected) {
  if (!video) return;
  const confirmation = window.prompt(`Permanently delete “${video.name}” from Cloudflare Stream?\n\nThis cannot be undone. Type DELETE to continue.`);
  if (confirmation === null) return;
  if (confirmation.trim() !== "DELETE") return toast("Video was not deleted. Type DELETE exactly to confirm.", "error");
  const returnSection = state.section === "manage" ? "manage" : "library";
  setBusy(true);
  try {
    await requestVideoDeletion(video);
    state.videos = state.videos.filter((item) => item.uid !== video.uid);
    if (state.selected?.uid === video.uid) {
      state.selected = null;
      state.playback = null;
      state.playbackRequested = false;
    }
    emitHostEvent("video.deleted", { uid: video.uid });
    navigate(returnSection);
    toast(`“${video.name}” was permanently deleted.`);
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

async function cleanupAbandonedUploads(videos) {
  if (!videos.length) return;
  const confirmation = window.prompt(`Permanently remove ${videos.length} expired, incomplete upload${videos.length === 1 ? "" : "s"}?\n\nThis cannot be undone. Type DELETE to continue.`);
  if (confirmation === null) return;
  if (confirmation.trim() !== "DELETE") return toast("No uploads were deleted. Type DELETE exactly to confirm.", "error");
  setBusy(true);
  const deleted = [];
  const failed = [];
  for (const video of videos) {
    try { await requestVideoDeletion(video); deleted.push(video.uid); }
    catch { failed.push(video.uid); }
  }
  state.videos = state.videos.filter((video) => !deleted.includes(video.uid));
  if (deleted.includes(state.selected?.uid)) {
    state.selected = null;
    state.playback = null;
    state.playbackRequested = false;
  }
  deleted.forEach((uid) => emitHostEvent("video.deleted", { uid }));
  if (state.section === "manage") await loadManagement();
  else renderLibrary();
  if (deleted.length) toast(`${deleted.length} abandoned upload${deleted.length === 1 ? "" : "s"} removed.`);
  if (failed.length) toast(`${failed.length} upload${failed.length === 1 ? "" : "s"} could not be removed. Refresh and try again.`, "error");
  setBusy(false);
}

async function repairPlaybackOrigin() {
  setBusy(true);
  try {
    const result = await api(`/videos/${state.selected.uid}/origins`, { method: "POST" });
    state.selected = result.video;
    state.playback = null;
    state.playbackRequested = false;
    toast("Playback is now allowed. Reloading the preview…");
    await new Promise((resolve) => setTimeout(resolve, 750));
    await refreshSelected(false, true);
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

async function refreshSelected(notify = true, bustPlaybackCache = false) {
  try {
    const result = await api(`/videos/${state.selected.uid}`);
    state.selected = result.video;
    state.playback = result.playback;
    if (bustPlaybackCache && state.playback?.iframeUrl) {
      const iframeUrl = new URL(state.playback.iframeUrl);
      iframeUrl.searchParams.set("vivadRefresh", String(Date.now()));
      state.playback.iframeUrl = iframeUrl.toString();
    }
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
    const language = captionLanguage();
    await api(`/videos/${state.selected.uid}/captions`, { method: "POST", body: JSON.stringify({ language }) });
    toast(`${language} captions are being generated.`);
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

function captionLanguage() {
  const language = String(document.querySelector("#caption-language")?.value || "en").trim().toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(language)) throw new Error("Enter a valid caption language such as en or en-AU.");
  return language;
}

async function loadMediaAssets() {
  setBusy(true);
  try {
    const [captionResult, downloadResult] = await Promise.all([api(`/videos/${state.selected.uid}/captions`), api(`/videos/${state.selected.uid}/downloads`)]);
    const captions = Array.isArray(captionResult.captions) ? captionResult.captions : [];
    const captionRows = captions.map((caption) => `<li><span><strong>${escapeHtml(caption.label || caption.language)}</strong> · ${escapeHtml(caption.status || "unknown")}${caption.generated ? " · AI generated" : ""}</span><span class="button-row">${caption.status === "ready" ? `<a class="button button-quiet button-small" href="/api/videos/${state.selected.uid}/captions/${encodeURIComponent(caption.language)}/vtt" target="_blank">Download</a>` : ""}<button class="button button-quiet button-small" type="button" data-delete-caption="${escapeHtml(caption.language)}">Delete</button></span></li>`).join("");
    const downloads = downloadResult.downloads || {};
    const downloadRows = [["default", "MP4 video"], ["audio", "M4A audio"]].map(([type, label]) => {
      const item = downloads[type];
      return `<li><span><strong>${label}</strong> · ${escapeHtml(item?.status || "not generated")}${item?.percentComplete != null ? ` · ${Math.round(item.percentComplete)}%` : ""}</span>${item?.status === "ready" && item.url ? `<a class="button button-quiet button-small" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">Download</a>` : ""}</li>`;
    }).join("");
    document.querySelector("#media-assets").innerHTML = `<h4>Captions</h4><ul class="asset-list">${captionRows || "<li>No captions yet.</li>"}</ul><h4>Downloads</h4><ul class="asset-list">${downloadRows}</ul>`;
    document.querySelectorAll("[data-delete-caption]").forEach((button) => button.addEventListener("click", () => deleteCaption(button.dataset.deleteCaption)));
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

async function uploadCaptionFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  setBusy(true);
  try {
    const language = captionLanguage();
    const vtt = await file.text();
    await api(`/videos/${state.selected.uid}/captions/${language}`, { method: "PUT", body: JSON.stringify({ vtt }) });
    toast(`${language} captions uploaded.`);
    await loadMediaAssets();
  } catch (error) { toast(error.message, "error"); }
  finally { event.target.value = ""; setBusy(false); }
}

async function deleteCaption(language) {
  if (!window.confirm(`Delete the ${language} caption file?`)) return;
  setBusy(true);
  try { await api(`/videos/${state.selected.uid}/captions/${language}`, { method: "DELETE" }); toast("Caption deleted."); await loadMediaAssets(); }
  catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

async function generateDownload(type) {
  const label = type === "audio" ? "audio-only M4A" : "MP4";
  if (!window.confirm(`Ask Cloudflare to generate an ${label} download? This creates a stored derivative.`)) return;
  setBusy(true);
  try { await api(`/videos/${state.selected.uid}/downloads/${type}`, { method: "POST", body: JSON.stringify({}) }); toast(`${label} generation started.`); await loadMediaAssets(); }
  catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

function renderShare() {
  const video = state.selected;
  if (!video) return navigate("library");
  const expiry = video.visibility === "public" ? "Public playback is available through this stable watch page." : "The Vivad share page remains stable while each protected playback token is short-lived.";
  document.querySelector("#view").innerHTML = `
    <section class="panel share-card">
      <div class="panel-header"><div><p class="eyebrow">Step 04</p><h2>Share video</h2></div><span class="badge badge-${video.visibility}">${video.visibility}</span></div>
      <div class="panel-body">
        <div class="share-summary">
          <div class="video-thumb">${video.thumbnail && video.visibility === "public" ? `<img src="${escapeHtml(video.thumbnail)}" alt="">` : ""}<span class="play-dot">▶</span></div>
          <div><h3>${escapeHtml(video.name)}</h3><p class="muted">${formatTime(video.duration)} · Created ${formatDate(video.created)}</p><p class="expiry-note">${expiry}</p></div>
        </div>
        <div class="grid-equal">
          <label class="field"><span>Share-page expiry</span><select id="share-expiry"><option value="1">1 day</option><option value="7">7 days</option><option value="30" selected>30 days</option><option value="60">60 days</option><option value="90">90 days</option></select></label>
          <div class="field"><span>Direct link</span><button class="button button-secondary" id="copy-link" data-busy ${video.readyToStream ? "" : "disabled"}>Create and copy link</button></div>
        </div>
        <div id="share-link-result"></div>
        <div class="form-divider"></div>
        <p class="eyebrow">Publishing destinations</p>
        <h3>Website and Discourse</h3>
        <p class="muted">Public videos can produce indexable website metadata and responsive embeds. Protected videos use a stable Vivad share link.</p>
        <div class="button-row">
          <button class="button button-secondary" id="copy-discourse-link" type="button">Copy Discourse link</button>
          <button class="button button-secondary" id="copy-discourse-markdown" type="button">Copy Markdown</button>
          <button class="button button-secondary" id="copy-discourse-iframe" type="button" ${video.visibility === "public" ? "" : "disabled"}>Copy public iframe</button>
          <button class="button button-secondary" id="save-strapi-draft" type="button" ${video.visibility === "public" ? "" : "disabled"}>Save draft to Strapi</button>
        </div>
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
  document.querySelector("#copy-discourse-link").addEventListener("click", () => copyPublishingValue("link"));
  document.querySelector("#copy-discourse-markdown").addEventListener("click", () => copyPublishingValue("markdown"));
  document.querySelector("#copy-discourse-iframe").addEventListener("click", () => copyPublishingValue("iframe"));
  document.querySelector("#save-strapi-draft").addEventListener("click", saveStrapiDraft);
  document.querySelector("#email-form").addEventListener("submit", sendEmail);
}

async function publishingPackage() {
  if (state.selected.visibility === "public") return api(`/videos/${state.selected.uid}/publishing`);
  const share = await createShareLink();
  return { discourse: { link: share.watchUrl, markdown: `[${state.selected.name.replace(/[\[\]]/g, "")}](${share.watchUrl})`, iframe: null } };
}

async function copyPublishingValue(kind) {
  setBusy(true);
  try {
    const result = await publishingPackage();
    const value = result.discourse?.[kind];
    if (!value) throw new Error("That embed format is available only for public videos.");
    await navigator.clipboard.writeText(value);
    toast(`${kind === "iframe" ? "Iframe" : kind === "markdown" ? "Markdown" : "Link"} copied for Discourse.`);
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

async function saveStrapiDraft() {
  if (!window.confirm("Save this public video as a draft in the configured Strapi website?")) return;
  setBusy(true);
  try {
    const result = await api(`/videos/${state.selected.uid}/strapi`, { method: "POST", body: JSON.stringify({}) });
    toast(`Strapi draft saved${result.draft?.documentId ? ` (${result.draft.documentId})` : ""}.`);
    emitHostEvent("video.published", { uid: state.selected.uid, destination: "strapi", status: "draft" });
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

async function createShareLink() {
  const shareDays = Number(document.querySelector("#share-expiry")?.value || 30);
  const result = await api(`/videos/${state.selected.uid}/share`, { method: "POST", body: JSON.stringify({ shareDays }) });
  return result.share;
}

async function copyShareLink() {
  setBusy(true);
  try {
    const share = await createShareLink();
    await navigator.clipboard.writeText(share.watchUrl);
    document.querySelector("#share-link-result").innerHTML = `<div class="status-banner"><span>Link copied to clipboard · expires ${new Date(share.expiresAt).toLocaleString("en-AU")}.</span></div>`;
    emitHostEvent("video.shared", { uid: state.selected.uid, watchUrl: share.watchUrl, expiresAt: share.expiresAt });
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
        shareDays: Number(document.querySelector("#share-expiry")?.value || 30),
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

async function renderPublicShare(shareId) {
  app.innerHTML = `<main class="public-watch"><section class="watch-card"><img class="brand-logo" src="/assets/vivad-logo.png" alt="Vivad"><div class="player-placeholder"><div><span class="loading"></span><p>Preparing secure video…</p></div></div></section></main>`;
  try {
    const response = await fetch(`/api/public/shares/${encodeURIComponent(shareId)}`);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "This video share is unavailable.");
    document.title = `${result.video.name} · Vivad Video`;
    app.innerHTML = `<main class="public-watch"><section class="watch-card">
      <div class="watch-header"><img class="brand-logo" src="/assets/vivad-logo.png" alt="Vivad"><span class="badge badge-${escapeHtml(result.video.visibility)}">${escapeHtml(result.video.visibility)}</span></div>
      <iframe class="player-frame" src="${escapeHtml(result.playback.iframeUrl)}" title="${escapeHtml(result.video.name)}" allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>
      <div class="watch-copy"><h1>${escapeHtml(result.video.name)}</h1>${result.video.description ? `<p>${escapeHtml(result.video.description)}</p>` : ""}<p class="muted">Shared securely with Vivad Video · expires ${new Date(result.share.expiresAt).toLocaleString("en-AU")}</p></div>
    </section></main>`;
  } catch (error) {
    app.innerHTML = `<main class="public-watch"><section class="watch-card"><img class="brand-logo" src="/assets/vivad-logo.png" alt="Vivad"><div class="status-banner error" role="alert"><span>${escapeHtml(error.message)}</span></div></section></main>`;
  }
}

function applyPublishingMetadata(publishing) {
  if (!publishing) return;
  document.querySelector('meta[name="robots"]')?.remove();
  const robots = document.createElement("meta");
  robots.name = "robots";
  robots.content = publishing.robots;
  document.head.append(robots);
  if (publishing.jsonLd) {
    const script = document.createElement("script");
    script.type = "application/ld+json";
    script.textContent = JSON.stringify(publishing.jsonLd).replace(/</g, "\\u003c");
    document.head.append(script);
  }
}

async function renderPublicVideo(uid) {
  app.innerHTML = `<main class="public-watch"><section class="watch-card"><img class="brand-logo" src="/assets/vivad-logo.png" alt="Vivad"><div class="player-placeholder"><div><span class="loading"></span><p>Loading public video…</p></div></div></section></main>`;
  try {
    const response = await fetch(`/api/public/videos/${encodeURIComponent(uid)}`);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "This public video is unavailable.");
    document.title = `${result.video.name} · Vivad Video`;
    applyPublishingMetadata(result.publishing);
    app.innerHTML = `<main class="public-watch"><section class="watch-card"><div class="watch-header"><img class="brand-logo" src="/assets/vivad-logo.png" alt="Vivad"><span class="badge badge-public">Public</span></div><iframe class="player-frame" src="${escapeHtml(result.playback.iframeUrl)}" title="${escapeHtml(result.video.name)}" allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe><div class="watch-copy"><h1>${escapeHtml(result.video.name)}</h1><p>${escapeHtml(result.video.description || "")}</p></div></section></main>`;
  } catch (error) { app.innerHTML = `<main class="public-watch"><section class="watch-card"><img class="brand-logo" src="/assets/vivad-logo.png" alt="Vivad"><div class="status-banner error" role="alert"><span>${escapeHtml(error.message)}</span></div></section></main>`; }
}

async function initialise() {
  if (demoMode) {
    state.session = { sub: "demo", name: "Vivad user", app: "standalone", role: "admin", mode: "standalone" };
    state.token = "demo";
    return startApp();
  }
  const params = new URLSearchParams(location.search);
  const publicVideoId = params.get("watch");
  if (publicVideoId) return renderPublicVideo(publicVideoId);
  const shareId = params.get("share");
  if (shareId) return renderPublicShare(shareId);
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
