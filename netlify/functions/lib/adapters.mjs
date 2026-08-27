import { getDatabase } from "@netlify/database";

export function videoDatabaseConfigured(env = process.env) {
  return Boolean(env.VIDEO_DATABASE_URL || env.NETLIFY_DB_URL);
}

export function integrationCapabilities(env = process.env) {
  return {
    database: videoDatabaseConfigured(env),
    strapi: Boolean(env.STRAPI_URL && env.STRAPI_API_TOKEN),
    discourse: Boolean(env.DISCOURSE_URL && env.DISCOURSE_API_KEY && env.DISCOURSE_API_USERNAME),
    rendering: Boolean(env.RENDERING_SERVICE_URL && env.RENDERING_SERVICE_TOKEN),
  };
}

export class VideoRepository {
  constructor(env = process.env, database = null) {
    this.env = env;
    this.configured = Boolean(database) || videoDatabaseConfigured(env);
    this.database = database;
  }

  client() {
    if (!this.configured) {
      throw Object.assign(new Error("Video catalogue storage requires Netlify Database or VIDEO_DATABASE_URL."), { status: 503 });
    }
    if (!this.database) {
      const connectionString = this.env.VIDEO_DATABASE_URL || undefined;
      this.database = getDatabase(connectionString ? { connectionString } : undefined);
    }
    return this.database;
  }

  async upsertRecords(records = []) {
    if (!records.length) return { synced: 0 };
    const payload = records.map((record) => ({
      uid: String(record.uid),
      provider: String(record.provider || "cloudflare"),
      provider_id: String(record.providerId || record.uid),
      owner_id: String(record.owner || "unknown"),
      creator: record.creator ? String(record.creator) : null,
      source_url: record.sourceUrl ? String(record.sourceUrl) : null,
      title: String(record.title || "Untitled video").slice(0, 180),
      purpose: String(record.purpose || "general"),
      visibility: String(record.visibility || "expiring"),
      status: String(record.status || "unknown"),
      ready: Boolean(record.ready),
      metadata: record.metadata || {},
      created_at: record.createdAt || new Date().toISOString(),
      updated_at: record.updatedAt || new Date().toISOString(),
    }));
    await this.client().pool.query(`
      INSERT INTO vivad_video_records
        (uid, provider, provider_id, owner_id, creator, source_url, title, purpose, visibility, status, ready, metadata, created_at, updated_at)
      SELECT uid, provider, provider_id, owner_id, creator, source_url, title, purpose, visibility, status, ready, metadata, created_at, updated_at
      FROM jsonb_to_recordset($1::jsonb) AS incoming(
        uid text, provider text, provider_id text, owner_id text, creator text, source_url text,
        title text, purpose text, visibility text, status text, ready boolean, metadata jsonb,
        created_at timestamptz, updated_at timestamptz
      )
      ON CONFLICT (uid) DO UPDATE SET
        owner_id = EXCLUDED.owner_id,
        creator = EXCLUDED.creator,
        source_url = EXCLUDED.source_url,
        title = EXCLUDED.title,
        purpose = EXCLUDED.purpose,
        visibility = EXCLUDED.visibility,
        status = EXCLUDED.status,
        ready = EXCLUDED.ready,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at,
        deleted_at = NULL
    `, [JSON.stringify(payload)]);
    return { synced: payload.length };
  }

  async syncStreamVideos(videos = [], session = {}) {
    const now = new Date().toISOString();
    return this.upsertRecords(videos.map((video) => ({
      uid: video.uid,
      provider: "cloudflare",
      providerId: video.uid,
      owner: session.role !== "admin" && session.sub
        ? session.sub
        : String(video.creator || video.core?.owner || session.sub || "unknown").replace(/^[^:]+:/, ""),
      creator: video.creator,
      title: video.name,
      purpose: video.purpose,
      visibility: video.visibility,
      status: video.readyToStream ? "ready" : String(video.status?.state || "processing").toLowerCase(),
      ready: video.readyToStream,
      metadata: { core: video.core || {}, uploadExpiry: video.uploadExpiry || null, scheduledDeletion: video.scheduledDeletion || null },
      createdAt: video.created || now,
      updatedAt: video.modified || now,
    })));
  }

  async recordUpload({ uid, session, fileName, visibility, purpose, uploadExpiry }) {
    const now = new Date().toISOString();
    await this.upsertRecords([{ uid, provider: "cloudflare", providerId: uid, owner: session.sub, creator: session.creator, title: fileName, purpose, visibility, status: "pendingupload", ready: false, metadata: { uploadExpiry }, createdAt: now, updatedAt: now }]);
    return this.recordEvent({ uid, eventType: "upload.created", session, details: { fileName, visibility, uploadExpiry } });
  }

  async saveExternal(record) {
    const uid = `${record.provider}:${record.providerId}`;
    await this.upsertRecords([{ uid, ...record, title: record.meta?.name, purpose: record.meta?.vivadPurpose, visibility: record.meta?.vivadAccess, status: "external", ready: true, metadata: { meta: record.meta } }]);
    await this.recordEvent({ uid, eventType: "external.created", session: { sub: record.owner, app: "standalone" }, details: { provider: record.provider } });
    return { uid, external: true, provider: record.provider, providerId: record.providerId, sourceUrl: record.sourceUrl, name: record.meta?.name || "External video", purpose: record.meta?.vivadPurpose || "general", visibility: record.meta?.vivadAccess || "link", readyToStream: true };
  }

  async recordEvent({ uid, eventType, session = {}, details = {} }) {
    await this.client().pool.query(
      `INSERT INTO vivad_video_events (video_uid, event_type, actor_id, app, details) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [String(uid), String(eventType), String(session.sub || "system"), String(session.app || "standalone"), JSON.stringify(details)],
    );
  }

  async markDeleted(uid, session, details = {}) {
    await this.client().pool.query(`UPDATE vivad_video_records SET deleted_at = NOW(), status = 'deleted', ready = false, updated_at = NOW() WHERE uid = $1`, [String(uid)]);
    await this.recordEvent({ uid, eventType: "video.deleted", session, details });
  }

  async catalogueStatus(ownerId = null) {
    const parameters = ownerId ? [String(ownerId)] : [];
    const ownerClause = ownerId ? "AND owner_id = $1" : "";
    const { rows: counts } = await this.client().pool.query(`
      SELECT status, COUNT(*)::int AS count
      FROM vivad_video_records
      WHERE deleted_at IS NULL ${ownerClause}
      GROUP BY status ORDER BY status
    `, parameters);
    const { rows: recentEvents } = await this.client().pool.query(`
      SELECT event_type, video_uid, actor_id, app, created_at
      FROM vivad_video_events
      ${ownerId ? "WHERE actor_id = $1" : ""}
      ORDER BY created_at DESC LIMIT 20
    `, parameters);
    return { counts, recentEvents };
  }
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
