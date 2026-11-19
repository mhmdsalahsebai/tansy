/**
 * Folds repeated `authz.denied` entries. Anyone can cause a denial, so denials are the one part
 * of the audit log an outsider can grow, and they're kept as long as the rest of it. No server
 * imports, so it's easy to test.
 */

export type FoldResult = { write: false } | { write: true; folded: number };

/**
 * The first denial from one source in each window is written; the rest in that window are
 * counted, and the next one written after it carries the count. Past `maxKeys` sources at
 * once, the oldest are forgotten, and their next denial is written whole, so memory stays
 * bounded under a spread-out flood.
 */
export function createDenialFolder(windowMs = 60_000, maxKeys = 10_000) {
  const seen = new Map<string, { since: number; folded: number }>();

  return function fold(key: string, now = Date.now()): FoldResult {
    const entry = seen.get(key);
    if (entry && now - entry.since < windowMs) {
      entry.folded += 1;
      return { write: false };
    }
    const folded = entry?.folded ?? 0;
    seen.delete(key);
    if (seen.size >= maxKeys) {
      // A Map iterates in insertion order, so this drops expired sources first and then the oldest.
      for (const [old, value] of seen) {
        if (seen.size < maxKeys && now - value.since < windowMs) break;
        seen.delete(old);
      }
    }
    seen.set(key, { since: now, folded: 0 });
    return { write: true, folded };
  };
}
