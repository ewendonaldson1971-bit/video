# Vivad Video

Vivad Video is a standalone and embeddable application for uploading, editing,
securing and emailing video. It uses Cloudflare Stream for media processing and
iRedMail SMTP credentials stored in Netlify environment variables for delivery.

## Current capabilities

- Resumable browser-to-Cloudflare uploads using the tus protocol
- Upload progress and Cloudflare processing status
- Video library and secure preview
- Non-destructive start/end clipping
- Thumbnail-frame selection
- AI caption generation
- Public, private and temporary access modes
- Signed private links with 15-minute to 24-hour expiry
- Automatic deletion for temporary videos (30 to 1,096 days)
- Customer email through iRedMail with an inline thumbnail
- Standalone email/password authentication through the same service used by SAV Builder
- Short-lived signed sessions for SPARK, Lotus and other host apps
- `postMessage` lifecycle events for embedded integrations
- Purpose templates for website, training, SOP, internal, client and general video
- Seven audience policies, including unlisted, organisation, team and client sharing
- Browser camera, screen, screen-plus-camera and audio recording
- Protected direct video-file URL imports through Cloudflare Stream
- Stable customer share pages that generate fresh short-lived playback tokens
- Public SEO watch pages and reusable Strapi/Discourse publishing output
- Viewer-only watch workflow for organisation and public videos
- Version-specific training/SOP acknowledgement records with editor CSV export
- Installable web-app metadata and Vivad Video icons for desktop taskbars

## Access modes

| Mode | Playback | Storage lifetime |
| --- | --- | --- |
| Public | Anyone with the normal Stream link | Until manually deleted |
| Anyone with link | Unlisted public playback; excluded from SEO | Until manually deleted |
| Organisation, team, client or expiring | Signed playback through a Vivad share/watch workflow | Until manually deleted |
| Temporary | Signed link required | Automatically deleted after the selected retention period |

Cloudflare requires scheduled deletion to be at least 30 days after creation.
The signed-token API limits individual playback tokens to 24 hours.
Customer emails no longer contain those playback tokens. They contain a signed
Vivad share ID; the watch page requests a fresh one-hour playback token when it
loads. Set a separate `SHARE_SIGNING_SECRET` before production use. Existing
deployments temporarily fall back to `SESSION_SIGNING_SECRET` for compatibility.

## Local setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and enter the credentials locally.
3. Run `npm install`.
4. Run the site and functions together with `npx netlify dev`.

For interface-only development, run `npm run dev` and open
`http://localhost:5173/?demo=1`. Demo mode is compiled only during Vite
development and never activates in the production build.

## Netlify deployment

Connect the `video` GitHub repository to Netlify. The included `netlify.toml`
sets the build command to `npm run build`, publishes `dist`, and deploys the
server API from `netlify/functions`.

Create the variables from `.env.example` in the Netlify UI. Mark all tokens,
passwords and signing secrets as secret values. If scoped
variables are available, include the Functions scope.

Set `AUTH_PROVIDER=vivad` and configure `VIVAD_AUTH_URL` with the same
`/api/auth/token` endpoint used by SAV Builder. Vivad Video sends the submitted
email address and password from its Netlify Function to that service, never
stores the password or exposes the upstream token to the browser, and creates
its own short-lived session only after the service accepts the credentials.
Authorization is separate from credential validation. Configure
`LOTUS_DIRECTORY_QUERY_URL` with the Google Sheets query endpoint for
Lotus_Directory, plus its email and role column letters. After the Calculator
authentication service accepts the credentials, the Netlify Function asks
Google Sheets for only the matching email and `Vivad Video Role`; it does not
download the other directory columns.
`Admin`, `Editor` and `Viewer` are accepted
case-insensitively; blank, `No Access` and unknown values are denied. Directory
records and upstream credentials are never returned to the browser.
Authentication is isolated in `netlify/functions/lib/auth.mjs` so a future
STRAPI provider can replace the current service without changing the login
interface or application session format.

The Cloudflare API token needs only **Stream Read** and **Stream Write** for the
correct account. Never use the Global API key.

For iRedMail, use authenticated submission on port `587` with STARTTLS. Set
`SMTP_FROM_EMAIL` to the same address as `SMTP_USER` unless iRedMail has been
explicitly configured to permit sender aliases.

## Cloudflare Stream configuration

`CLOUDFLARE_STREAM_CUSTOMER_CODE` accepts either a customer code such as
`customer-abc123` or the full customer hostname. `STREAM_ALLOWED_ORIGINS` is
optional. Leaving it empty allows the player to appear in any host app; signed
URLs still protect private and temporary videos. If origins are restricted,
include every SPARK/Lotus host. Vivad Video's `PUBLIC_APP_URL` hostname and the
customer Stream hostname are added automatically so editor and emailed watch
pages continue to work. When an editor opens an older restricted video, Vivad
automatically merges the application hostname into its existing allowed origins
without removing its other authorised domains. A manual **Repair playback**
action remains available if Cloudflare rejects the automatic update.

## Host-app integration

See [docs/embedding.md](docs/embedding.md) for token generation, iframe setup,
event handling and framing restrictions.

## Architecture and publishing

- [Architecture and persistence](docs/architecture.md)
- [Strapi and video SEO](docs/strapi-seo.md)
- [Discourse sharing](docs/discourse.md)

Cloudflare Stream stores the video files. Netlify Database stores a lightweight
catalogue of provider IDs, ownership references, workflow metadata, upload state
audit events and per-user, per-version acknowledgements. The **Manage** view synchronises existing Stream records and
shows pending, abandoned, processing and failed uploads. `VIDEO_DATABASE_URL`
can point to another PostgreSQL provider; otherwise Netlify supplies
`NETLIFY_DB_URL` automatically. The app does not use `localStorage` as a
multi-user database.

Videos marked **Require acknowledgement** show an acknowledgement action to
viewers. Editors and administrators who can manage the video can load the
current version's acknowledgement report and export it as CSV. The report lists
completed acknowledgements; a complete outstanding-user report will require an
assigned audience or roster supplied by SPARK or another host application.

## Verification

```sh
npm test
npm run build
```

Editors can permanently delete videos attributed to their own Vivad account;
administrators can delete any accessible video. The server rechecks ownership,
requires the exact video ID plus an explicit `DELETE` confirmation, and writes a
structured deletion entry to the Netlify function log. Temporary deletion
continues to be scheduled through Cloudflare.

Interrupted TUS uploads retain their one-time upload ticket in the browser. If
the same local file is selected again before `uploadExpiry`, Vivad verifies the
Cloudflare `Upload-Offset` and resumes from the confirmed byte rather than
creating another library record. Expired `pendingupload` records are labelled
as abandoned and can be removed individually or in a confirmed bulk cleanup.
