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

  async acknowledgementStatus({ uid, session, version }) {
    const { rows } = await this.client().pool.query(`
      SELECT video_uid, user_id, video_version, source_app, acknowledged_at
      FROM vivad_video_acknowledgements
      WHERE video_uid = $1 AND user_id = $2 AND video_version = $3
      LIMIT 1
    `, [String(uid), String(session.sub), String(version)]);
    return rows[0] || null;
  }

  async acknowledgeVideo({ uid, session, version }) {
    const insertion = await this.client().pool.query(`
      INSERT INTO vivad_video_acknowledgements
        (video_uid, user_id, user_email, user_name, video_version, source_app)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (video_uid, user_id, video_version) DO NOTHING
    `, [String(uid), String(session.sub), session.email ? String(session.email) : null, session.name ? String(session.name) : null, String(version), String(session.app || "standalone")]);
    const acknowledgement = await this.acknowledgementStatus({ uid, session, version });
    if (insertion.rowCount) await this.recordEvent({ uid, eventType: "video.acknowledged", session, details: { version: String(version) } });
    return acknowledgement;
  }

  async acknowledgementReport({ uid, version }) {
    const { rows } = await this.client().pool.query(`
      SELECT user_id, user_email, user_name, video_version, source_app, acknowledged_at
      FROM vivad_video_acknowledgements
      WHERE video_uid = $1 AND video_version = $2
      ORDER BY acknowledged_at DESC, user_name ASC
    `, [String(uid), String(version)]);
    return rows;
  }

  async saveEditProject({ id, uid, session, recipe }) {
    const { rows } = await this.client().pool.query(`
      INSERT INTO vivad_video_edit_projects (id, video_uid, owner_id, name, aspect_ratio, recipe)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        aspect_ratio = EXCLUDED.aspect_ratio,
        recipe = EXCLUDED.recipe,
        status = 'draft',
        render_job_id = NULL,
        output_video_uid = NULL,
        error_message = NULL,
        updated_at = NOW()
      WHERE vivad_video_edit_projects.owner_id = EXCLUDED.owner_id
        AND vivad_video_edit_projects.video_uid = EXCLUDED.video_uid
      RETURNING *
    `, [String(id), String(uid), String(session.sub), String(recipe.name), String(recipe.aspectRatio), JSON.stringify(recipe)]);
    if (!rows[0]) throw Object.assign(new Error("You do not have access to this edit project."), { status: 403 });
    await this.recordEvent({ uid, eventType: "edit.project.saved", session, details: { projectId: String(id), aspectRatio: recipe.aspectRatio } });
    return rows[0];
  }

  async listEditProjects({ uid, session }) {
    const parameters = session.role === "admin" ? [String(uid)] : [String(uid), String(session.sub)];
    const { rows } = await this.client().pool.query(`
      SELECT id, video_uid, owner_id, name, aspect_ratio, recipe, status, render_job_id, output_video_uid, error_message, created_at, updated_at
      FROM vivad_video_edit_projects
      WHERE video_uid = $1 ${session.role === "admin" ? "" : "AND owner_id = $2"}
      ORDER BY updated_at DESC
      LIMIT 50
    `, parameters);
    return rows;
  }

  async editProject({ id, uid, session }) {
    const parameters = session.role === "admin" ? [String(id), String(uid)] : [String(id), String(uid), String(session.sub)];
    const { rows } = await this.client().pool.query(`
      SELECT * FROM vivad_video_edit_projects
      WHERE id = $1 AND video_uid = $2 ${session.role === "admin" ? "" : "AND owner_id = $3"}
      LIMIT 1
    `, parameters);
    if (!rows[0]) throw Object.assign(new Error("Edit project not found."), { status: 404 });
    return rows[0];
  }

  async markRenderSubmitted({ id, uid, session, job }) {
    const { rows } = await this.client().pool.query(`
      UPDATE vivad_video_edit_projects
      SET status = $1, render_job_id = $2, output_video_uid = $3, error_message = NULL, updated_at = NOW()
      WHERE id = $4 AND video_uid = $5
      RETURNING *
    `, [String(job.status || "queued"), job.id ? String(job.id) : null, job.outputVideoUid ? String(job.outputVideoUid) : null, String(id), String(uid)]);
    await this.recordEvent({ uid, eventType: "edit.render.submitted", session, details: { projectId: String(id), jobId: job.id || null } });
    return rows[0];
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
  constructor(env = process.env, fetchImpl = fetch) { this.env = env; this.fetch = fetchImpl; this.configured = Boolean(env.RENDERING_SERVICE_URL && env.RENDERING_SERVICE_TOKEN); }
  async render(project) {
    if (!this.configured) throw Object.assign(new Error("Advanced rendering is not configured. Set RENDERING_SERVICE_URL and RENDERING_SERVICE_TOKEN."), { status: 503 });
    const response = await this.fetch(`${String(this.env.RENDERING_SERVICE_URL).replace(/\/$/, "")}/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.env.RENDERING_SERVICE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, videoUid: project.video_uid, recipe: project.recipe }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || `Rendering service request failed (${response.status}).`), { status: 502 });
    return { id: payload.id || payload.jobId || null, status: payload.status || "queued", outputVideoUid: payload.outputVideoUid || null };
  }
}
