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
  constructor(env = process.env) { this.configured = Boolean(env.STRAPI_URL && env.STRAPI_API_TOKEN); }
  async saveDraft() { if (!this.configured) throw Object.assign(new Error("Strapi publishing is not configured."), { status: 503 }); }
}

export class DiscoursePublisher {
  constructor(env = process.env) { this.configured = Boolean(env.DISCOURSE_URL && env.DISCOURSE_API_KEY && env.DISCOURSE_API_USERNAME); }
  async createTopic() { if (!this.configured) throw Object.assign(new Error("Discourse publishing is not configured."), { status: 503 }); }
}

export class RenderingService {
  constructor(env = process.env) { this.configured = Boolean(env.RENDERING_SERVICE_URL && env.RENDERING_SERVICE_TOKEN); }
  async render() { if (!this.configured) throw Object.assign(new Error("Advanced rendering is not configured."), { status: 503 }); }
}
