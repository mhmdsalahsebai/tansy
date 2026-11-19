const CHUNK = 500;

/** Keeps IN lists within SQLite's limit on bound parameters. */
export function chunks<T>(items: T[]) {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) result.push(items.slice(i, i + CHUNK));
  return result;
}
