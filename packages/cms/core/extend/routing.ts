import type { HttpMethod } from "./define";

export const HTTP_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const SEGMENT = /^(?::[A-Za-z][A-Za-z0-9_]*|[A-Za-z0-9._~-]+)$/;

export function routePathProblem(path: string): string | null {
  if (!path.startsWith("/") || path.length > 200) return "must start with / and be at most 200 characters";
  const segments = path.slice(1).split("/");
  if (segments.some((segment) => !SEGMENT.test(segment) || segment === "." || segment === "..")) return "has an invalid segment";
  return null;
}

/** A literal segment beats a parameter, so /posts/new can sit beside /posts/:id. */
export function matchRoute<T extends { method: string; path: string }>(routes: T[], method: string, segments: string[]) {
  const matches = routes.flatMap((route) => {
    if (route.method !== method) return [];
    const pattern = route.path.slice(1).split("/");
    if (pattern.length !== segments.length) return [];
    const params: Record<string, string> = {};
    let literals = 0;
    for (const [index, part] of pattern.entries()) {
      if (part.startsWith(":")) params[part.slice(1)] = segments[index];
      else if (part === segments[index]) literals += 1;
      else return [];
    }
    return [{ route, params, literals }];
  });
  matches.sort((a, b) => b.literals - a.literals);
  return matches[0] ?? null;
}
