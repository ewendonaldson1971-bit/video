import test from "node:test";
import assert from "node:assert/strict";
import { DiscoursePublisher, RenderingService, StrapiPublisher, VideoRepository, integrationCapabilities, videoDatabaseConfigured } from "../netlify/functions/lib/adapters.mjs";

test("optional integration capabilities remain disabled without configuration", () => {
  assert.deepEqual(integrationCapabilities({}), { database: false, strapi: false, discourse: false, rendering: false });
});

test("video catalogue recognises Netlify Database and explicit Postgres URLs", () => {
  assert.equal(videoDatabaseConfigured({ NETLIFY_DB_URL: "postgres://netlify" }), true);
  assert.equal(videoDatabaseConfigured({ VIDEO_DATABASE_URL: "postgres://external" }), true);
  assert.equal(videoDatabaseConfigured({}), false);
});

test("video catalogue bulk sync stores workflow metadata without video bytes", async () => {
  const queries = [];
  const database = { pool: { query: async (text, values) => { queries.push({ text, values }); return { rows: [] }; } } };
  const repository = new VideoRepository({}, database);
  const result = await repository.syncStreamVideos([{
    uid: "abc123",
    name: "Safety induction",
    purpose: "training",
    visibility: "organisation",
    readyToStream: false,
    status: { state: "pendingupload" },
    creator: "standalone:user-1",
    core: { owner: "standalone:user-1" },
    created: "2026-08-27T00:00:00.000Z",
  }], { sub: "user-1" });
  assert.deepEqual(result, { synced: 1 });
  const stored = JSON.parse(queries[0].values[0]);
  assert.equal(stored[0].provider_id, "abc123");
  assert.equal(stored[0].owner_id, "user-1");
  assert.equal(stored[0].status, "pendingupload");
  assert.equal(stored[0].metadata.core.owner, "standalone:user-1");
  assert.equal("video" in stored[0], false);
});

test("external video references are returned as playable library records with details", async () => {
  const database = { pool: { query: async () => ({ rows: [{
    uid: "youtube:dQw4w9WgXcQ",
    provider: "youtube",
    provider_id: "dQw4w9WgXcQ",
    owner_id: "user-1",
    source_url: "https://youtu.be/dQw4w9WgXcQ",
    title: "Installation guide",
    purpose: "training",
    visibility: "organisation",
    metadata: { meta: { name: "Installation guide", vivadPurpose: "training", vivadAccess: "organisation", vivadDescription: "How to install it." } },
    created_at: "2026-08-29T00:00:00.000Z",
    updated_at: "2026-08-29T00:00:00.000Z",
  }] }) } };
  const [video] = await new VideoRepository({}, database).listExternal({ sub: "user-1", role: "editor" });
  assert.equal(video.uid, "youtube:dQw4w9WgXcQ");
  assert.equal(video.embedUrl, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  assert.equal(video.thumbnail, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  assert.equal(video.description, "How to install it.");
  assert.equal(video.purpose, "training");
  assert.equal(video.canManage, true);
});

test("acknowledgements are version-specific and idempotent", async () => {
  const queries = [];
  const acknowledgement = { video_uid: "video123", user_id: "user@example.com", video_version: "2", acknowledged_at: "2026-08-27T00:00:00.000Z" };
  const database = { pool: { query: async (text, values) => {
    queries.push({ text, values });
    if (/SELECT video_uid/.test(text)) return { rows: [acknowledgement] };
    return { rows: [], rowCount: /INSERT INTO vivad_video_acknowledgements/.test(text) ? 1 : 0 };
  } } };
  const repository = new VideoRepository({}, database);
  const result = await repository.acknowledgeVideo({ uid: "video123", session: { sub: "user@example.com", email: "user@example.com", name: "User", app: "spark" }, version: "2" });
  assert.deepEqual(result, acknowledgement);
  assert.ok(queries.some(({ text, values }) => /ON CONFLICT/.test(text) && values[4] === "2"));
  assert.ok(queries.some(({ text }) => /INSERT INTO vivad_video_events/.test(text)));
});

test("authenticated video comments retain author attribution and audit events", async () => {
  const queries = [];
  const created = { id: "17", video_uid: "video123", user_id: "user-1", user_name: "Sam Evans", source_app: "standalone", body: "Please update this section.", created_at: "2026-08-31T01:00:00.000Z", updated_at: "2026-08-31T01:00:00.000Z" };
  const database = { pool: { query: async (text, values) => {
    queries.push({ text, values });
    if (/INSERT INTO vivad_video_comments/.test(text)) return { rows: [created], rowCount: 1 };
    if (/SELECT id::text/.test(text)) return { rows: [created] };
    return { rows: [], rowCount: 1 };
  } } };
  const repository = new VideoRepository({}, database);
  const comment = await repository.createComment({ uid: "video123", session: { sub: "user-1", email: "sam@example.com", name: "Sam Evans", app: "standalone" }, body: "Please update this section." });
  const comments = await repository.listComments({ uid: "video123" });
  assert.deepEqual(comment, created);
  assert.deepEqual(comments, [created]);
  assert.ok(queries.some(({ text, values }) => /INSERT INTO vivad_video_comments/.test(text) && values[2] === "sam@example.com" && values[5] === created.body));
  assert.ok(queries.some(({ text, values }) => /INSERT INTO vivad_video_events/.test(text) && values[1] === "video.comment.created"));
});

test("unconfigured adapters fail clearly rather than pretending to persist", async () => {
  await assert.rejects(() => new VideoRepository().saveExternal({}), /VIDEO_DATABASE_URL/);
  await assert.rejects(() => new StrapiPublisher({}).saveDraft({}), /not configured/);
  await assert.rejects(() => new DiscoursePublisher({}).createTopic({}), /not configured/);
  await assert.rejects(() => new RenderingService({}).render({}), /not configured/);
});

test("rendering adapter submits a non-secret edit recipe", async () => {
  let request;
  const service = new RenderingService({ RENDERING_SERVICE_URL: "https://render.example", RENDERING_SERVICE_TOKEN: "secret" }, async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ jobId: "job-1", status: "queued" }), { status: 202, headers: { "content-type": "application/json" } });
  });
  const result = await service.render({ id: "project-1", video_uid: "video-1", recipe: { aspectRatio: "9:16", segments: [] } });
  assert.equal(result.id, "job-1");
  assert.equal(request.url, "https://render.example/jobs");
  assert.equal(JSON.parse(request.options.body).recipe.aspectRatio, "9:16");
  assert.equal(request.options.body.includes("secret"), false);
});

test("Strapi adapter explicitly creates drafts", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ data: { documentId: "draft-1" } }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const publisher = new StrapiPublisher({ STRAPI_URL: "https://cms.example/", STRAPI_API_TOKEN: "secret", STRAPI_VIDEO_CONTENT_TYPE: "videos" }, fetchImpl);
  const result = await publisher.saveDraft({ title: "Example" });
  assert.equal(result.documentId, "draft-1");
  assert.equal(request.url, "https://cms.example/api/videos?status=draft");
  assert.deepEqual(JSON.parse(request.options.body), { data: { title: "Example" } });
});
