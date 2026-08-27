# Vivad Video architecture

Vivad Video is the standalone media application. SPARK, Lotus and future apps
integrate through a signed embed session and events; they do not own the video
implementation.

## Provider-independent record

`netlify/functions/lib/model.mjs` defines the current core record and mappings.
It includes provider/provider ID, owner/creator, purpose, access, title, internal
name, description, transcript, thumbnail, duration, chapters, captions, tags,
collections, version/source relationship, review status/dates, publication
destinations, and created/modified dates.

Cloudflare Stream remains the media provider and stores all video bytes.
Netlify Database stores the small provider-independent catalogue and audit log.
Existing Stream videos are progressively synchronised into the catalogue when
the library is refreshed; no video content is copied into PostgreSQL.

The database also stores acknowledgement facts: video ID, user identity, video
version, source application and acknowledgement time. The unique video/user/
version key makes acknowledgement submissions idempotent and requires a fresh
acknowledgement after an editor changes the video's version. Vivad Video does
not currently own audience assignments, so its report contains completed
acknowledgements rather than a list of users who are still outstanding.

`vivad_video_edit_projects` stores non-destructive timeline recipes, aspect
ratio, render status and output references. It never stores video bytes.
Cloudflare-native chapter, caption, clip, thumbnail and watermark operations
remain in the main API. CPU-intensive composition is delegated to the rendering
service described in `docs/rendering-service.md`.

## Production database requirement

Netlify Database supplies `NETLIFY_DB_URL` automatically in deployed functions.
An external PostgreSQL database can be used with `VIDEO_DATABASE_URL` instead.
The schema is versioned in `netlify/database/migrations`. Configure this storage
before enabling external YouTube or Vimeo records, collections, chapters,
transcripts, per-user acknowledgements, comments or named-client activity.
Cloudflare Stream metadata should contain media-management fields, not sensitive
customer data.

## Optional adapters

- Strapi is a publishing destination and receives drafts only.
- Discourse receives stable links or public iframe markup; protected playback
  tokens are never stored in posts.
- Rendering is a disabled boundary for a future FFmpeg/container service.

Unavailable adapters report a configuration message and never simulate success.

The Netlify Function includes a best-effort in-process limiter for login,
imports, playback tokens, public shares and email. Because serverless instances
do not share memory, production should replace this boundary with a distributed
rate limiter before high-volume or untrusted use.
