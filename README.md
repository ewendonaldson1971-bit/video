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
pages continue to work. Older videos display an **Allow playback here** repair
action when their stored restriction does not include the current app host.
Saving a video's settings with the variable empty also clears any older
per-video origin restriction.

## Host-app integration

See [docs/embedding.md](docs/embedding.md) for token generation, iframe setup,
event handling and framing restrictions.

## Architecture and publishing

- [Architecture and persistence](docs/architecture.md)
- [Strapi and video SEO](docs/strapi-seo.md)
- [Discourse sharing](docs/discourse.md)

Cloudflare Stream metadata remains the migration store for Vivad-hosted media.
A production database is still required before enabling durable external video
references, collections, transcripts, chapters, acknowledgements, comments,
client activity or review history. The app does not use `localStorage` as a
multi-user database.

## Verification

```sh
npm test
npm run build
```

The app deliberately does not include deletion controls in the initial release.
Temporary deletion is scheduled through Cloudflare, while permanent removal
should be added only with an explicit confirmation and audit trail.
