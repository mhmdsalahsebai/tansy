/** Next.js's own matching order for file routes: at each position a fixed name beats [param], which beats [...rest]. */
type Part = { kind: "static"; text: string } | { kind: "param"; name: string } | { kind: "rest"; name: string; optional: boolean };

function parse(pattern: string): Part[] {
  return pattern.split("/").filter(Boolean).map((segment) => {
    const optional = /^\[\[\.\.\.(.+)\]\]$/.exec(segment);
    if (optional) return { kind: "rest", name: optional[1], optional: true };
    const rest = /^\[\.\.\.(.+)\]$/.exec(segment);
    if (rest) return { kind: "rest", name: rest[1], optional: false };
    const param = /^\[(.+)\]$/.exec(segment);
    return param ? { kind: "param", name: param[1] } : { kind: "static", text: segment };
  });
}

const RANK = { static: 0, param: 1, rest: 2 };

function compare(a: Part[], b: Part[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (!a[i]) return -1;
    if (!b[i]) return 1;
    if (a[i].kind !== b[i].kind) return RANK[a[i].kind] - RANK[b[i].kind];
  }
  return 0;
}

export type RouteParams = Record<string, string | string[]>;

function matches(parts: Part[], segments: string[]): RouteParams | null {
  const params: RouteParams = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.kind === "rest") {
      const rest = segments.slice(i);
      if (rest.length === 0 && !part.optional) return null;
      if (rest.length > 0) params[part.name] = rest;
      return params;
    }
    if (i >= segments.length) return null;
    if (part.kind === "static") {
      if (part.text !== segments[i]) return null;
    } else {
      params[part.name] = segments[i];
    }
  }
  return parts.length === segments.length ? params : null;
}

/** Builds a matcher over a route table, most specific pattern first. */
export function createMatcher<T extends { pattern: string }>(table: readonly T[]) {
  const sorted = table.map((entry) => ({ entry, parts: parse(entry.pattern) })).sort((a, b) => compare(a.parts, b.parts));
  return (segments: string[]): { entry: T; params: RouteParams } | null => {
    for (const { entry, parts } of sorted) {
      const params = matches(parts, segments);
      if (params) return { entry, params };
    }
    return null;
  };
}
