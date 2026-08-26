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
