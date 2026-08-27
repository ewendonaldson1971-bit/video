CREATE TABLE IF NOT EXISTS vivad_video_edit_projects (
  id TEXT PRIMARY KEY,
  video_uid TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  aspect_ratio TEXT NOT NULL DEFAULT 'original',
  recipe JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft',
  render_job_id TEXT,
  output_video_uid TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vivad_video_edit_projects_video_idx
  ON vivad_video_edit_projects (video_uid, owner_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS vivad_video_edit_projects_status_idx
  ON vivad_video_edit_projects (status, updated_at DESC);
