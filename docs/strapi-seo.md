# Strapi and video SEO

Set `STRAPI_URL`, `STRAPI_API_TOKEN`, and optionally
`STRAPI_VIDEO_CONTENT_TYPE` (default `videos`). The token stays in the Netlify
Function. Vivad Video calls Strapi 5 `POST /api/videos?status=draft`; it never
publishes automatically.

Create a Strapi collection type with these API field names:

`title`, `seoTitle`, `slug`, `summary`, `description`, `transcript`, `provider`,
`providerId`, `playerUrl`, `thumbnailUrl`, `duration`, `uploadDate`, `chapters`,
`captions`, `tags`, `categories`, `relatedProducts`, `relatedArticles`,
`canonicalUrl`, `socialTitle`, `socialDescription`, `socialImage`, `locale`, and
`indexStatus`.

Public videos receive stable watch pages and output for VideoObject JSON-LD,
Clip key moments, Open Graph/Twitter, canonical URLs and video sitemaps. Only the
Public access policy is indexable. Link, organisation, team, client, expiring,
temporary and expired videos must remain `noindex`.

Google requires the video to be visible on an indexable watch page with a stable,
crawlable thumbnail. Validate deployed markup with Rich Results Test and submit
the generated sitemap through Search Console.

References:

- https://docs.strapi.io/cms/api/rest
- https://developers.google.com/search/docs/appearance/structured-data/video
- https://developers.google.com/search/docs/appearance/video
- https://developers.google.com/search/docs/crawling-indexing/sitemaps/video-sitemaps
