# Discourse sharing

The Share screen produces:

- a stable Vivad watch link;
- a Markdown link;
- responsive Cloudflare iframe markup for public video only.

Protected videos must use a Vivad share link. A Discourse post must never contain
a short-lived Cloudflare playback token. A future Discourse plugin can validate
the signed-in forum user/group against the Vivad API and obtain fresh playback.

## Forum configuration

For public iframe embeds, add the exact Cloudflare Stream customer hostname and
the Vivad Video hostname to Discourse's `allowed_iframes` site setting. If the
forum uses a custom Content Security Policy, add the same exact player hostname
to `frame-src`. Avoid wildcards when the customer hostname is known.

If embedding the Vivad watch page itself, add the exact Discourse origin to the
`frame-ancestors` directive in `netlify.toml`; it currently permits only self and
`https://*.vivad.com.au`.

`DISCOURSE_URL`, `DISCOURSE_API_KEY`, and `DISCOURSE_API_USERNAME` are reserved
for a future explicitly configured test category/topic adapter. Vivad Video does
not create real posts during tests or merely because credentials exist.
