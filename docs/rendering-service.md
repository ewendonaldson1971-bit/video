# Vivad Video rendering service contract

Vivad Video deliberately does not run FFmpeg inside a Netlify Function. Large
downloads, multi-clip composition and transcoding require a long-running
container or managed rendering service.

Configure:

```text
RENDERING_SERVICE_URL=https://renderer.example
RENDERING_SERVICE_TOKEN=<private bearer token>
```

Vivad Video submits `POST {RENDERING_SERVICE_URL}/jobs` with:

```json
{
  "projectId": "uuid",
  "videoUid": "primary-cloudflare-stream-uid",
  "recipe": {
    "name": "Training social edit",
    "aspectRatio": "9:16",
    "captions": "burned",
    "watermark": true,
    "background": "#000000",
    "segments": [
      {
        "id": "clip-1",
        "type": "clip",
        "sourceUid": "cloudflare-stream-uid",
        "start": 4.2,
        "end": 18.5,
        "label": "Opening",
        "transition": "cut"
      },
      {
        "id": "title-1",
        "type": "title",
        "title": "Safety first",
        "subtitle": "Vivad training",
        "duration": 3
      }
    ]
  }
}
```

The renderer authenticates the request using the bearer token. It should have
its own narrowly scoped Cloudflare Stream credentials, fetch only the listed
source UIDs, render to a temporary workspace, upload the finished file as a new
Stream video, then delete temporary files.

An accepted response is:

```json
{
  "jobId": "render-job-id",
  "status": "queued",
  "outputVideoUid": null
}
```

The current app records job submission. A future webhook endpoint should verify
an independent signing secret before updating completion, failure and output
video fields. Do not reuse the browser session, Cloudflare API token or
`RENDERING_SERVICE_TOKEN` as a webhook secret.
