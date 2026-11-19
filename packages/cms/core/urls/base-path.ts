/**
 * No imports at all: a scope value's path prefix is read on the server, carried into a page's
 * words, and put back on addresses in a client component, so this has to load anywhere.
 *
 * A scope value whose site has no address of its own is served under a prefix on the
 * instance's, such as /acme/blog/hello for the tenant "acme" (MULTI_TENANT_PLAN.md). The site
 * layer strips it before an address is matched and puts it back on every address it builds.
 * It sits outside the language prefix: /acme/ar/blog/hello.
 */

/** One path segment, as the provider gives it: "/acme". Checked wherever one enters. */
export const BASE_PATH = /^\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const isBasePath = (value: unknown): value is string => typeof value === "string" && BASE_PATH.test(value);

/** Whether `path` is the base path itself or an address under it. */
export function insideBasePath(path: string, base: string): boolean {
  return Boolean(base) && (path === base || path.startsWith(`${base}/`));
}

/** `path` without the prefix in front: "/acme/blog" is "/blog" under "/acme". Unchanged when it isn't inside one. */
export function stripBasePath(path: string, base: string | null | undefined): string {
  if (!base || !insideBasePath(path, base)) return path;
  return path.slice(base.length) || "/";
}

/**
 * A site address with the prefix in front. Left alone without one, and for anything that
 * isn't a path on this site, such as the absolute address of a language's own domain.
 */
export function withBasePath(base: string | null | undefined, href: string): string {
  if (!base || !href.startsWith("/") || href.startsWith("//")) return href;
  return href === "/" ? base : `${base}${href}`;
}

/** As deep as a stream of blocks can nest. */
const MAX_DEPTH = 32;

/**
 * A menu's blocks with each hand-typed site path under the prefix. `<Menu>` renders stored
 * URLs through core/urls/path.ts, which has no imports so it can run in the browser, and so
 * can't read the request's prefix: the paths arrive already prefixed instead. A path that
 * already names the prefix is left alone, since whoever typed it meant that address.
 */
export function menuWithBasePath(blocks: unknown, base: string, depth = 0): unknown {
  if (!base || !Array.isArray(blocks) || depth > MAX_DEPTH) return blocks;
  return blocks.map((block) => {
    if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "menu_item") return block;
    const value = (block as { value?: unknown }).value;
    if (!value || typeof value !== "object") return block;
    const { url, children } = value as { url?: unknown; children?: unknown };
    const prefixed = typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !insideBasePath(url, base) ? { url: withBasePath(base, url) } : {};
    const nested = Array.isArray(children) ? { children: menuWithBasePath(children, base, depth + 1) } : {};
    return { ...block, value: { ...value, ...prefixed, ...nested } };
  });
}
