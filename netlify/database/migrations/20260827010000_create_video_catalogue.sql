CREATE TABLE IF NOT EXISTS vivad_video_records (
  uid TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  creator TEXT,
  source_url TEXT,
  title TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'general',
  visibility TEXT NOT NULL DEFAULT 'expiring',
  status TEXT NOT NULL DEFAULT 'unknown',
  ready BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (provider, provider_id)
);

CREATE INDEX IF NOT EXISTS vivad_video_records_owner_idx
  ON vivad_video_records (owner_id, deleted_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS vivad_video_records_status_idx
  ON vivad_video_records (status, deleted_at);

CREATE TABLE IF NOT EXISTS vivad_video_events (
  id BIGSERIAL PRIMARY KEY,
  video_uid TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  app TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vivad_video_events_video_idx
  ON vivad_video_events (video_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS vivad_video_events_actor_idx
  ON vivad_video_events (actor_id, created_at DESC);
