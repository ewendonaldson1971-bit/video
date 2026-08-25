# Embedding Vivad Video

Vivad Video can run on its own or inside SPARK, Lotus and other trusted apps.
The host app creates a short-lived signed token on its server, then passes that
token to the editor iframe. The Cloudflare and SMTP credentials never enter the
browser or the host app.

## 1. Share the signing secret

Set the same strong `EMBED_SIGNING_SECRET` in Vivad Video and the host app's
server environment. Do not use the standalone access key and do not put the
secret in frontend code.

## 2. Create a short-lived token on the host server

The helper in `integration/create-embed-token.mjs` produces an HS256 JWT with:

- `sub`: the host app's user ID
- `name`: display name
- `app`: stable application ID such as `spark` or `lotus`
- `origin`: exact parent origin that may receive editor events
- `context`: optional job, customer or order identifiers
- `iss`: `vivad-host`
- `aud`: `vivad-video`
- `exp`: no more than ten minutes after issue

```js
import { createVivadVideoEmbedToken } from "./integration/create-embed-token.mjs";

const token = createVivadVideoEmbedToken({
  secret: process.env.VIVAD_VIDEO_EMBED_SECRET,
  userId: currentUser.id,
  userName: currentUser.name,
  app: "spark",
  origin: "https://spark.vivad.com.au",
  context: { jobId: job.id, customerId: job.customerId },
});
```

## 3. Embed the editor

```html
<iframe
  id="vivad-video"
  src="https://video.vivad.com.au/?embedToken=SERVER_GENERATED_TOKEN"
  title="Vivad Video"
  style="width:100%;height:900px;border:0"
  allow="clipboard-write"
></iframe>
```

Vivad Video immediately exchanges the one-use URL token for an eight-hour
session and removes the embed token from the address bar.

## 4. Receive lifecycle events

Always compare `event.origin` with the deployed Vivad Video origin.

```js
window.addEventListener("message", (event) => {
  if (event.origin !== "https://video.vivad.com.au") return;
  if (event.data?.source !== "vivad-video") return;

  switch (event.data.type) {
    case "video.uploaded":
    case "video.created":
    case "video.updated":
    case "video.selected":
    case "video.shared":
    case "video.emailed":
      saveVideoEventToHostApp(event.data);
      break;
  }
});
```

## Security headers

The default Content Security Policy permits framing from `*.vivad.com.au`.
If a host application uses a different domain, explicitly add that trusted
origin to the `frame-ancestors` directive in `netlify.toml`; do not replace it
with a wildcard.
