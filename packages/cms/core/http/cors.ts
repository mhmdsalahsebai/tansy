import "server-only";
import type { AuthSettings } from "../auth/settings-schema";
import { baseUrl, isTrustedOrigin } from "./request";

const METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE";
/** better-auth's bearer plugin returns a new session token in `set-auth-token`, which a browser hides from another origin unless it's listed. */
const EXPOSED = ["set-auth-token", "content-disposition"];
const PREFLIGHT_MAX_AGE = "600";

/**
 * The origin to answer with, or null. Only another origin the owner listed under trusted
 * origins: this app's own pages need no CORS, and any other origin gets no header, so the
 * browser keeps the response from it. Trusted origins are the same list CSRF and better-auth
 * already trust with cookies, so this grants a listed site nothing it couldn't already send.
 */
export function corsOrigin(headers: Headers, settings: AuthSettings): string | null {
  const origin = headers.get("origin");
  if (!origin || origin === "null" || origin === new URL(baseUrl()).origin) return null;
  return isTrustedOrigin(origin, settings) ? origin : null;
}

/** A copy, because some responses' headers are read-only, such as Response.redirect()'s. Streams pass through untouched. */
function mutable(response: Response) {
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) });
}

function allow(headers: Headers, origin: string) {
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
}

/** Adds CORS headers to an API response for a trusted origin. Any request with an Origin varies by it, so a shared cache never hands one origin's answer to another. */
export function withCors(response: Response, request: Request, settings: AuthSettings): Response {
  if (!request.headers.has("origin")) return response;
  const copy = mutable(response);
  copy.headers.append("Vary", "Origin");
  const origin = corsOrigin(request.headers, settings);
  if (!origin) return copy;
  allow(copy.headers, origin);
  // better-auth's bearer plugin sets its own list, which this keeps.
  const exposed = new Set([...(copy.headers.get("Access-Control-Expose-Headers") ?? "").split(","), ...EXPOSED].map((name) => name.trim().toLowerCase()).filter(Boolean));
  copy.headers.set("Access-Control-Expose-Headers", [...exposed].join(", "));
  return copy;
}

/**
 * The answer to a browser's preflight. A trusted origin may send any request header, since
 * a plugin's sign-in widget may add its own (a CAPTCHA answer, say). Everything it sends is
 * still checked by the route itself.
 */
export function preflight(request: Request, settings: AuthSettings, allowHeader: string): Response {
  const headers = new Headers({ Allow: allowHeader, Vary: "Origin, Access-Control-Request-Headers" });
  const origin = corsOrigin(request.headers, settings);
  if (origin) {
    allow(headers, origin);
    headers.set("Access-Control-Allow-Methods", METHODS);
    const requested = request.headers.get("access-control-request-headers");
    if (requested) headers.set("Access-Control-Allow-Headers", requested.slice(0, 1024));
    headers.set("Access-Control-Max-Age", PREFLIGHT_MAX_AGE);
  }
  return new Response(null, { status: 204, headers });
}
