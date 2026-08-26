import test from "node:test";
import assert from "node:assert/strict";
import { DiscoursePublisher, RenderingService, StrapiPublisher, VideoRepository, integrationCapabilities } from "../netlify/functions/lib/adapters.mjs";

test("optional integration capabilities remain disabled without configuration", () => {
  assert.deepEqual(integrationCapabilities({}), { database: false, strapi: false, discourse: false, rendering: false });
});

test("unconfigured adapters fail clearly rather than pretending to persist", async () => {
  await assert.rejects(() => new VideoRepository().saveExternal({}), /VIDEO_DATABASE_URL/);
  await assert.rejects(() => new StrapiPublisher({}).saveDraft({}), /not configured/);
  await assert.rejects(() => new DiscoursePublisher({}).createTopic({}), /not configured/);
  await assert.rejects(() => new RenderingService({}).render({}), /not configured/);
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
