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

Cloudflare Stream remains the media provider. Existing videos continue to use
Stream metadata while the database layer is selected. `VideoRepository` is the
durable-storage boundary; it deliberately fails when no database implementation
exists.

## Production database requirement

Configure and implement `VIDEO_DATABASE_URL` before enabling external YouTube or
Vimeo records, collections, chapters, transcripts, per-user acknowledgements,
comments, named-client activity, or audit history. PostgreSQL is recommended.
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
