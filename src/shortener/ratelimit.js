// Fixed-window limiter, keyed by client address.
export function createLimiter({ limit = 60, windowMs = 60_000, now = Date.now } = {}) {
  const hits = new Map();

  return {
    check(key) {
      const t = now();
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      }
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        entry = { count: 0, resetAt: t + windowMs };
        hits.set(key, entry);
      }
      entry.count++;
      if (entry.count > limit) {
        return { allowed: false, retryAfter: Math.ceil((entry.resetAt - t) / 1000) };
      }
      return { allowed: true };
    },
  };
}
