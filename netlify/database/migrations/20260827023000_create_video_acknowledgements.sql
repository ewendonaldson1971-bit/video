CREATE TABLE IF NOT EXISTS vivad_video_acknowledgements (
  id BIGSERIAL PRIMARY KEY,
  video_uid TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_email TEXT,
  user_name TEXT,
  video_version TEXT NOT NULL,
  source_app TEXT NOT NULL,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (video_uid, user_id, video_version)
);

CREATE INDEX IF NOT EXISTS vivad_video_acknowledgements_video_idx
  ON vivad_video_acknowledgements (video_uid, video_version, acknowledged_at DESC);

CREATE INDEX IF NOT EXISTS vivad_video_acknowledgements_user_idx
  ON vivad_video_acknowledgements (user_id, acknowledged_at DESC);
