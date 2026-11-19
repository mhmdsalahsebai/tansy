/** Matching plugin page paths such as "lms/courses/:id", and checking section icons. Pure, so the browser and tests can use it too. */
import type { AdminIcon } from "./admin";

const ICON_NAME = /^[a-z][a-z0-9-]{0,39}$/;
/** Commands and numbers only, so a path can describe a shape and nothing else. */
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]{1,8000}$/;
const VIEW_BOX = /^-?\d+(?:\.\d+)?(?: -?\d+(?:\.\d+)?){3}$/;

/** A section's icon as the navigation may draw it, or undefined for the default. */
export function navIcon(icon: unknown): string | AdminIcon | undefined {
  if (typeof icon === "string") return ICON_NAME.test(icon) ? icon : undefined;
  if (!icon || typeof icon !== "object") return undefined;
  const { paths, viewBox, fillRule } = icon as Partial<AdminIcon>;
  if (!Array.isArray(paths) || !paths.length || paths.length > 8 || !paths.every((d) => typeof d === "string" && PATH_DATA.test(d))) return undefined;
  if (viewBox !== undefined && !(typeof viewBox === "string" && VIEW_BOX.test(viewBox))) return undefined;
  return { paths: [...paths], viewBox: viewBox ?? "0 0 16 16", fillRule: fillRule === "evenodd" ? "evenodd" : "nonzero" };
}

const segments = (path: string) => path.split("/").filter(Boolean);

/** Whether a page's path has `:name` segments, which only match a full address. */
export const hasParams = (path: string) => segments(path).some((part) => part.startsWith(":"));

/** The params of `address` under `pattern`, or null when it doesn't match. */
export function matchPagePath(pattern: string, address: string): Record<string, string> | null {
  const want = segments(pattern);
  const got = segments(address);
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (const [index, part] of want.entries()) {
    if (part.startsWith(":")) params[part.slice(1)] = got[index];
    else if (part !== got[index]) return null;
  }
  return params;
}
