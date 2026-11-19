interface Bucket { count: number; opened: number }

const MAX_TRACKED = 100_000;

declare const globalThis: { cmsReadLimits?: Map<string, Bucket> } & typeof global;
const buckets = (globalThis.cmsReadLimits ??= new Map<string, Bucket>());

/**
 * Fixed-window counter for reads, held in memory so that a read never becomes a
 * database write. The server is one process, so the count is exact. Returns true
 * when the request is within the limit.
 */
export function consumeReadLimit(key: string, windowSeconds: number, max: number, now = Date.now()): boolean {
  const windowMs = windowSeconds * 1000;
  if (buckets.size >= MAX_TRACKED) {
    for (const [name, bucket] of buckets) if (now - bucket.opened >= windowMs) buckets.delete(name);
    // Many live callers at once: forget them rather than grow without limit.
    if (buckets.size >= MAX_TRACKED) buckets.clear();
  }
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.opened >= windowMs) {
    buckets.set(key, { count: 1, opened: now });
    return max >= 1;
  }
  bucket.count += 1;
  return bucket.count <= max;
}
