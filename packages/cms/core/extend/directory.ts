import { z } from "zod";

/**
 * The read-only list of community packages, built from npm keywords. It only tells people
 * what exists: installing stays npm plus a line in tansy.config.ts (decision 13).
 */
const SEARCH_URL = "https://registry.npmjs.org/-/v1/search";
const PAGE_SIZE = 250;
const TIMEOUT_MS = 5000;
const CACHE_MS = 60 * 60 * 1000;
const MAX_DESCRIPTION = 300;
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export const DIRECTORY_KEYWORDS = { plugins: "tansy-plugin", themes: "tansy-theme" } as const;

export interface DirectoryEntry {
  name: string;
  version: string;
  description: string;
  /** Always on npmjs.com. Links an author supplies are never shown, so a listing can't choose where a click goes. */
  url: string;
}

export interface Directory {
  plugins: DirectoryEntry[];
  themes: DirectoryEntry[];
}

const response = z.object({
  objects: z.array(z.object({ package: z.object({ name: z.string(), version: z.string(), description: z.string().optional() }) })),
});

async function search(keyword: string, fetcher: typeof fetch): Promise<DirectoryEntry[]> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("text", `keywords:${keyword}`);
  url.searchParams.set("size", String(PAGE_SIZE));
  const result = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error", cache: "no-store" });
  if (!result.ok) throw new Error(`npm answered ${result.status}.`);
  return response.parse(await result.json()).objects
    .map(({ package: item }) => item)
    .filter((item) => PACKAGE_NAME.test(item.name))
    .map((item) => ({ name: item.name, version: item.version, description: (item.description ?? "").slice(0, MAX_DESCRIPTION), url: `https://www.npmjs.com/package/${item.name}` }))
    // By name, so the order can't read as a ranking.
    .sort((a, b) => a.name.localeCompare(b.name));
}

let cached: { at: number; value: Directory } | null = null;

/** Null when npm can't be reached. Called only when someone opens the page, so a server that never does makes no outside request. */
export async function loadDirectory(fetcher: typeof fetch = fetch, now = Date.now()): Promise<Directory | null> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  try {
    const [plugins, themes] = await Promise.all([search(DIRECTORY_KEYWORDS.plugins, fetcher), search(DIRECTORY_KEYWORDS.themes, fetcher)]);
    cached = { at: now, value: { plugins, themes } };
    return cached.value;
  } catch {
    return null;
  }
}

export const clearDirectoryCache = () => { cached = null; };
