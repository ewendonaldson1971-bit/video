CREATE TABLE IF NOT EXISTS vivad_video_comments (
  id BIGSERIAL PRIMARY KEY,
  video_uid TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_email TEXT,
  user_name TEXT NOT NULL,
  source_app TEXT NOT NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vivad_video_comments_video_idx
  ON vivad_video_comments (video_uid, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS vivad_video_comments_user_idx
  ON vivad_video_comments (user_id, created_at DESC);
