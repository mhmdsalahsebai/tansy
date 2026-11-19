import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { contentSecurityPolicy, type CspAdditions } from "../core/extend/csp";
import { adminPath, apiPath, authPath, needsSession } from "../lib/paths";

/** Merges generated CSP entries, for an app that switches a plugin on at run time and wants its origins to follow. */
export function mergeCsp(...parts: CspAdditions[]): CspAdditions {
  const merged: CspAdditions = {};
  for (const part of parts) {
    for (const kind of ["frame", "connect", "img"] as const) {
      if (part[kind]) merged[kind] = [...new Set([...(merged[kind] ?? []), ...part[kind]])];
    }
  }
  return merged;
}

/** A host app's own proxy. Return nothing to carry on, or a response such as a redirect or rewrite. */
export type HostProxy = (request: NextRequest, event: NextFetchEvent) => Response | null | undefined | void | Promise<Response | null | undefined | void>;

export interface CmsProxyOptions {
  /** Runs only outside the CMS's own paths, so it can't change what reaches the admin or API. */
  proxy?: HostProxy;
}

// Next.js has no public way to add request headers to a response someone else made.
// tests/unit/proxy.test.ts fails if these names stop working with the installed version.
const OVERRIDE_HEADERS = "x-middleware-override-headers";
const REQUEST_HEADER = "x-middleware-request-";
const OWN_REQUEST_HEADERS = ["x-nonce", "x-pathname", "content-security-policy"];

/** A next() or rewrite from the host has to carry the nonce too, or the page's scripts are blocked. */
function forwardRequestHeaders(response: NextResponse, requestHeaders: Headers) {
  if (!response.headers.has("x-middleware-next") && !response.headers.has("x-middleware-rewrite")) return;
  const hostList = response.headers.get(OVERRIDE_HEADERS);
  // The list is the request's whole header set, so with no list of the host's, ours has to be complete.
  const names = hostList ? OWN_REQUEST_HEADERS : [...requestHeaders.keys()];
  for (const name of names) response.headers.set(`${REQUEST_HEADER}${name}`, requestHeaders.get(name) ?? "");
  response.headers.set(OVERRIDE_HEADERS, [...new Set([...(hostList?.split(",") ?? []), ...names])].join(","));
}

/**
 * Whether this is a page load, rather than a script, an image, or the payload Next.js fetches
 * for a client-side navigation. Those have their own cache policies and carry no nonce.
 */
const isDocument = (request: NextRequest) =>
  request.headers.get("sec-fetch-dest") === "document" || (!request.headers.has("sec-fetch-dest") && (request.headers.get("accept") ?? "").includes("text/html"));

function setSecurityHeaders(response: NextResponse, csp: string, document: boolean) {
  response.headers.set("Content-Security-Policy", csp);
  /**
   * A page carries a nonce that belongs to this one request, so a shared cache serving it to
   * anyone else would hand them a nonce that doesn't match their policy and block every script
   * on the page. `private` says so plainly rather than leaving it to a CDN's heuristics, and
   * the browser's own copy still revalidates. A route that chose its own policy keeps it.
   */
  if (document && !response.headers.has("Cache-Control")) response.headers.set("Cache-Control", "private, no-cache");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  if (process.env.BETTER_AUTH_URL?.startsWith("https://")) {
    response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
  return response;
}

/**
 * Sets security headers and redirects obviously signed-out visitors. The cookie
 * check is only a convenience (better-auth's documented pattern): real
 * authorization happens in core/authz, on every page and route.
 */
export function createCmsProxy(cspAdditions: CspAdditions, options: CmsProxyOptions = {}) {
  return async function proxy(request: NextRequest, event: NextFetchEvent) {
    const { pathname, search } = request.nextUrl;
    const isApi = pathname === apiPath() || pathname.startsWith(`${apiPath()}/`);
    const isAdmin = pathname === adminPath() || pathname.startsWith(`${adminPath()}/`);

    if (needsSession(pathname) && !getSessionCookie(request)) {
      const signIn = new URL(authPath("signin"), request.url);
      signIn.searchParams.set("next", pathname + search);
      return NextResponse.redirect(signIn);
    }

    const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
    const csp = contentSecurityPolicy(nonce, isApi, cspAdditions, { dev: process.env.NODE_ENV !== "production", https: Boolean(process.env.BETTER_AUTH_URL?.startsWith("https://")) });
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-nonce", nonce);
    // Overwritten here, so a client can't choose what extensions see.
    requestHeaders.set("x-pathname", pathname);
    requestHeaders.set("content-security-policy", csp);

    // Only a page: an API answer sets its own cache policy, and so does a file.
    const document = !isApi && isDocument(request);
    const answer = options.proxy && !isApi && !isAdmin ? await options.proxy(request, event) : undefined;
    if (!answer) return setSecurityHeaders(NextResponse.next({ request: { headers: requestHeaders } }), csp, document);
    // A copy, because the headers of some responses, such as Response.redirect(), are read-only.
    const response = new NextResponse(answer.body, answer);
    forwardRequestHeaders(response, requestHeaders);
    return setSecurityHeaders(response, csp, document);
  };
}
