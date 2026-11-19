/** No imports at all: <Menu> uses this from `tansy/react`, which has to load on any site, in any bundler. */

export const MAX_PATH = 2048;
export const MAX_SEGMENTS = 32;

const code = (character: string) => character.charCodeAt(0);
const isControl = (character: string) => code(character) < 0x20 || code(character) === 0x7f;
const hasControl = (text: string) => [...text].some(isControl);
/** Characters a browser may treat as ending or restarting a path, which must never reach a Location header. */
const unsafeInPath = (text: string) => [...text].some((character) => isControl(character) || character === " " || character === "\\");

/**
 * One spelling for each path, so "/caf%C3%A9/", "/café" and a stored redirect all
 * compare equal. Null for anything that isn't a plain path on this site.
 */
export function normalizePath(raw: string): string | null {
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.length > MAX_PATH || unsafeInPath(raw) || /[?#]/.test(raw)) return null;
  const parts = raw.split("/").slice(1);
  if (parts.at(-1) === "") parts.pop();
  if (parts.length > MAX_SEGMENTS) return null;
  const encoded: string[] = [];
  for (const part of parts) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (!decoded || decoded === "." || decoded === ".." || hasControl(decoded)) return null;
    encoded.push(encodeURIComponent(decoded));
  }
  const path = `/${encoded.join("/")}`;
  return path.length > MAX_PATH ? null : path;
}

/** A local path with an optional query string or fragment. Never another site. */
export function redirectTarget(raw: string): string | null {
  const end = raw.search(/[?#]/);
  const path = normalizePath(end === -1 ? raw : raw.slice(0, end));
  const suffix = end === -1 ? "" : raw.slice(end);
  if (path === null || unsafeInPath(suffix) || path.length + suffix.length > MAX_PATH) return null;
  return path + suffix;
}

/** The path part of a stored redirect target. */
export const targetPath = (target: string) => target.slice(0, target.search(/[?#]|$/));
