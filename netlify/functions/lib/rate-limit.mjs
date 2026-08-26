const buckets = new Map();

function clientKey(request) {
  return String(request.headers.get("x-nf-client-connection-ip") || request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown")
    .split(",")[0].trim().slice(0, 64);
}

export function enforceRateLimit(request, scope, { limit, windowMs }) {
  const now = Date.now();
  const key = `${scope}:${clientKey(request)}`;
  const current = buckets.get(key);
  const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
  bucket.count += 1;
  buckets.set(key, bucket);
  if (buckets.size > 5000) {
    for (const [candidate, value] of buckets) if (value.resetAt <= now) buckets.delete(candidate);
  }
  if (bucket.count > limit) {
    const error = Object.assign(new Error("Too many requests. Please try again later."), { status: 429, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) });
    throw error;
  }
  return { remaining: Math.max(0, limit - bucket.count), resetAt: bucket.resetAt };
}

export function clearRateLimitsForTests() { buckets.clear(); }
