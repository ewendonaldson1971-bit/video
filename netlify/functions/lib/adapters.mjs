export function integrationCapabilities(env = process.env) {
  return {
    database: Boolean(env.VIDEO_DATABASE_URL),
    strapi: Boolean(env.STRAPI_URL && env.STRAPI_API_TOKEN),
    discourse: Boolean(env.DISCOURSE_URL && env.DISCOURSE_API_KEY && env.DISCOURSE_API_USERNAME),
    rendering: Boolean(env.RENDERING_SERVICE_URL && env.RENDERING_SERVICE_TOKEN),
  };
}

export class VideoRepository {
  async saveExternal() { throw Object.assign(new Error("External video storage requires VIDEO_DATABASE_URL."), { status: 503 }); }
}

export class StrapiPublisher {
  constructor(env = process.env, fetchImpl = fetch) { this.env = env; this.fetch = fetchImpl; this.configured = Boolean(env.STRAPI_URL && env.STRAPI_API_TOKEN); }
  async saveDraft(data) {
    if (!this.configured) throw Object.assign(new Error("Strapi publishing is not configured."), { status: 503 });
    const contentType = String(this.env.STRAPI_VIDEO_CONTENT_TYPE || "videos").replace(/[^a-zA-Z0-9_-]/g, "");
    const response = await this.fetch(`${String(this.env.STRAPI_URL).replace(/\/$/, "")}/api/${contentType}?status=draft`, {
      method: "POST", headers: { authorization: `Bearer ${this.env.STRAPI_API_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ data }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload?.error?.message || `Strapi request failed (${response.status}).`), { status: 502 });
    return payload.data;
  }
}

export class DiscoursePublisher {
  constructor(env = process.env) { this.configured = Boolean(env.DISCOURSE_URL && env.DISCOURSE_API_KEY && env.DISCOURSE_API_USERNAME); }
  async createTopic() { if (!this.configured) throw Object.assign(new Error("Discourse publishing is not configured."), { status: 503 }); }
}

export class RenderingService {
  constructor(env = process.env) { this.configured = Boolean(env.RENDERING_SERVICE_URL && env.RENDERING_SERVICE_TOKEN); }
  async render() { if (!this.configured) throw Object.assign(new Error("Advanced rendering is not configured."), { status: 503 }); }
}
