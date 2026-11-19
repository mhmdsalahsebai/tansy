import "server-only";
import { APIError } from "better-auth/api";
import type { NextRequest } from "next/server";
import type { z } from "zod";
import { audit } from "../audit";
import { requestAllowed } from "../auth/extension-hooks";
import { getRuntime, type AuthRuntime } from "../auth/instance";
import { forbidden, HttpError, unauthorized } from "../http/errors";
import { consumeRateLimit } from "../http/rate-limit";
import { consumeReadLimit } from "../http/read-limit";
import { reportRequest } from "../extend/requests";
import { clientIp, isCrossSiteRequest } from "../http/request";
import { holdsRecordPermission, holdsRecordPermissionForSome, type Permission, type RecordPermission } from "./permissions";
import { ANONYMOUS, memberPrincipal, principalFromApiKey, principalFromSession, type ApiKeyPrincipal, type Principal, type UserPrincipal } from "./principal";
import { withScope } from "../scope/context";
import { consumeScopeRequest } from "../scope/limits";
import { ensureScopeRegistry } from "../scope/registry";
import { scopePrincipal } from "../scope/request";
import { refreshPluginOrigins } from "../http/plugin-origins";

/** Every route must declare exactly one of these. There is no default. */
export type Access =
  | { access: "public"; reason: string }
  | { access: "authenticated" }
  | {
      access: "permission";
      permission: Permission | Permission[];
      /**
       * "collection": `record:*` permissions may also be held for just the collection
       * whose numeric id is the `id` route param. Other permissions are unaffected.
       * "record": as "collection", and an own grant (`record:update@c3:own`) passes too.
       * The handler must then check the record through authorizeRecord, as requireRecord
       * does, because only that knows whose record it is.
       */
      scope?: "collection" | "record";
    }
  /** Decided per record in the handler through authorizeRecord (core/authz/records.ts). */
  | { access: "rules" };

type Schema = z.ZodType;
type Parsed<S> = S extends Schema ? z.output<S> : undefined;

export type RouteOptions<B extends Schema | undefined, Q extends Schema | undefined> = Access & {
  body?: B;
  query?: Q;
  /** Require a recent sign-in. Also refuses impersonated sessions. */
  fresh?: boolean;
  /** Allow x-api-key. Off by default: management routes need an interactive session. */
  apiKey?: boolean;
  /** Audit action written on success, e.g. "user.ban". */
  audit?: string;
  /** Overrides the default limit (applied to writes only). `false` needs a justification in review. */
  rateLimit?: { window: number; max: number } | false;
  maxBodyBytes?: number;
};

export interface RouteContext<B, Q, A> {
  request: NextRequest;
  principal: A;
  body: B;
  query: Q;
  params: Record<string, string>;
  runtime: AuthRuntime;
  /** Records what the action touched in the audit log. */
  auditTarget: (type: string, id: string, metadata?: Record<string, unknown>) => void;
  /** Sets a header on the JSON response, such as `Content-Language`. */
  header: (name: string, value: string) => void;
}

type PrincipalFor<O> = O extends { access: "permission" }
  ? UserPrincipal | ApiKeyPrincipal
  : O extends { access: "authenticated" }
    ? UserPrincipal | ApiKeyPrincipal
    : Principal;

export const ROUTE_POLICY = Symbol.for("tansy.route-policy");

export interface RoutePolicy {
  access: Access["access"];
  permission?: Permission | Permission[];
  scope?: "collection" | "record";
  reason?: string;
  fresh: boolean;
  apiKey: boolean;
  audit?: string;
}

type NextHandler = (request: NextRequest, context: { params: Promise<Record<string, string | string[] | undefined>> }) => Promise<Response>;
export type GuardedHandler = NextHandler & { [ROUTE_POLICY]: RoutePolicy };

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_MAX_BODY = 1024 * 1024;

const json = (status: number, payload: unknown, init?: HeadersInit) => {
  const headers = new Headers(init);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(payload), { status, headers });
};

export const errorResponse = (error: HttpError) =>
  json(error.status, { error: { code: error.code, message: error.message, details: error.details } });

async function readBody(request: NextRequest, limit: number): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
  }
  if (Number(request.headers.get("content-length") ?? 0) > limit) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
  const text = await request.text();
  if (Buffer.byteLength(text) > limit) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "Malformed JSON.");
  }
}

function validated<S extends Schema>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed.", result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return result.data;
}

/** The header that asks to be read as a member of the site, as a same-app page's `viewer()` reads. */
export const READ_AS_HEADER = "x-cms-as";

/** Also used by realtime, to re-check a live connection the same way as a request. */
export async function resolvePrincipal(request: { headers: Headers }, runtime: AuthRuntime, allowApiKey: boolean): Promise<Principal> {
  const readAs = request.headers.get(READ_AS_HEADER);
  if (readAs !== null && readAs !== "member") throw new HttpError(400, "BAD_REQUEST", `${READ_AS_HEADER} accepts only "member".`);
  const key = request.headers.get("x-api-key");
  if (key) {
    // A member is a person signed in to the site, and a same-app page never reads as one with a key either.
    if (readAs) throw new HttpError(400, "MEMBER_NEEDS_SESSION", "Reading as a member needs a signed-in session, not an API key.");
    if (!allowApiKey) throw new HttpError(401, "API_KEY_NOT_ACCEPTED", "This endpoint does not accept API keys.");
    const principal = await principalFromApiKey(key, runtime);
    if (!principal) throw new HttpError(401, "INVALID_API_KEY", "Invalid API key.");
    return principal;
  }
  const principal = await principalFromSession(request.headers, runtime);
  // Only ever takes permissions away: who they are stays for @request.auth, and their role grants nothing.
  return readAs ? (memberPrincipal(principal) ?? principal) : principal;
}

const RECORD_PERMISSION = /^record:[a-z]+$/;

/** The collection a scoped route acts on. Anything but a plain positive id scopes to nothing, so only global grants pass. */
function scopedCollection(options: Access, params: Record<string, string>): number | null {
  if (options.access !== "permission" || !options.scope) return null;
  return /^[1-9]\d{0,15}$/.test(params.id ?? "") ? Number(params.id) : null;
}

function holds(principal: Principal, permission: Permission, collectionId: number | null, own: boolean) {
  if (collectionId === null || !RECORD_PERMISSION.test(permission)) return principal.permissions.has(permission);
  const check = own ? holdsRecordPermissionForSome : holdsRecordPermission;
  return check(principal.permissions, permission as RecordPermission, collectionId);
}

function authorize(options: Access & { fresh?: boolean }, principal: Principal, runtime: AuthRuntime, params: Record<string, string>) {
  if (options.access === "public" || options.access === "rules") return;
  if (principal.kind === "anonymous") throw unauthorized();
  if (options.access === "permission") {
    const required = Array.isArray(options.permission) ? options.permission : [options.permission];
    const collectionId = scopedCollection(options, params);
    if (!required.every((permission) => holds(principal, permission, collectionId, options.scope === "record"))) throw forbidden();
    if (principal.kind === "user" && runtime.settings.mfa.requireForDashboard && principal.permissions.has("dashboard:access") && !principal.user.twoFactorEnabled && !principal.session.impersonatedBy) {
      throw new HttpError(403, "MFA_ENROLLMENT_REQUIRED", "Set up two-factor authentication to continue.");
    }
  }
}

function assertFresh(principal: Principal, runtime: AuthRuntime) {
  if (principal.kind !== "user") throw forbidden();
  if (principal.session.impersonatedBy) throw new HttpError(403, "IMPERSONATION_NOT_ALLOWED", "This action is not available while impersonating.");
  const age = (Date.now() - principal.session.createdAt.getTime()) / 1000;
  if (age > runtime.settings.session.freshFor) throw new HttpError(403, "REAUTH_REQUIRED", "Sign in again to continue.");
}

/**
 * The single entry point for API routes. Order: CSRF, identity, authorization,
 * freshness, rate limit, then input validation, so unauthorized callers learn
 * nothing about payload rules.
 */
export function route<B extends Schema | undefined = undefined, Q extends Schema | undefined = undefined, O extends RouteOptions<B, Q> = RouteOptions<B, Q>>(
  options: O & RouteOptions<B, Q>,
  handler: (context: RouteContext<Parsed<B>, Parsed<Q>, PrincipalFor<O>>) => Promise<unknown>,
): GuardedHandler {
  const guarded: NextHandler = async (request, context) => {
    let runtime: AuthRuntime | undefined;
    let principal: Principal = ANONYMOUS;
    const unsafe = UNSAFE.has(request.method);
    const path = new URL(request.url).pathname;
    let target: { type?: string; id?: string; metadata?: Record<string, unknown> } = {};
    const extraHeaders = new Headers();
    const started = Date.now();

    const auditContext = () => ({
      actorId: principal.kind === "anonymous" ? null : principal.user.id,
      actorEmail: principal.kind === "anonymous" ? null : principal.user.email,
      actorKind: principal.kind,
      scope: principal.scope ?? null,
      ipAddress: runtime ? clientIp(request.headers, runtime.settings) : null,
      userAgent: request.headers.get("user-agent"),
    });

    const respond = async (): Promise<Response> => { try {
      runtime = await getRuntime();
      await refreshPluginOrigins();

      const cookieAuthenticated = !request.headers.has("x-api-key") && !request.headers.has("authorization");
      if (unsafe && cookieAuthenticated && options.access !== "public" && isCrossSiteRequest(request.headers, runtime.settings)) {
        throw new HttpError(403, "CSRF_REJECTED", "Cross-site request rejected.");
      }

      principal = await resolvePrincipal(request, runtime, options.apiKey === true);
      // Row scopes: which scope value this request is for, and what the caller holds there (core/scope).
      await ensureScopeRegistry();
      principal = await scopePrincipal({ headers: request.headers, path }, principal, runtime, request.headers.get(READ_AS_HEADER) === "member");
      const params = (await context.params) as Record<string, string>;
      authorize(options, principal, runtime, params);
      // A scope value's budget of requests, across all its callers (core/scope/limits.ts).
      if (options.rateLimit !== false) await consumeScopeRequest(principal.scope);
      if (options.fresh) assertFresh(principal, runtime);
      if (!(await requestAllowed({ surface: "api", principal, ip: clientIp(request.headers, runtime.settings), method: request.method, path, headers: request.headers }))) {
        throw new HttpError(403, "REQUEST_REFUSED", "This request is not allowed.");
      }

      if (unsafe && options.rateLimit !== false && runtime.settings.rateLimit.enabled) {
        const limit = options.rateLimit ?? { window: runtime.settings.rateLimit.apiWriteWindow, max: runtime.settings.rateLimit.apiWriteMax };
        const actor = principal.kind === "anonymous" ? `ip:${clientIp(request.headers, runtime.settings) ?? "unknown"}` : `u:${principal.user.id}`;
        if (!(await consumeRateLimit(`${actor}:${request.method}:${path}`, limit.window, limit.max))) {
          throw new HttpError(429, "RATE_LIMITED", "Too many requests.");
        }
      }

      // One budget per caller, not per path, or varying the path would escape it. Dashboard staff browse through these same routes.
      const staff = principal.kind === "user" && principal.permissions.has("dashboard:access");
      if (!unsafe && !staff && options.rateLimit !== false && runtime.settings.rateLimit.enabled) {
        const ip = clientIp(request.headers, runtime.settings);
        const reader = principal.kind === "anonymous" ? (ip && `ip:${ip}`) : `u:${principal.user.id}`;
        if (reader && !consumeReadLimit(reader, runtime.settings.rateLimit.apiReadWindow, runtime.settings.rateLimit.apiReadMax)) {
          throw new HttpError(429, "RATE_LIMITED", "Too many requests.");
        }
      }

      const body = options.body ? validated(options.body, await readBody(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY)) : undefined;
      const query = options.query ? validated(options.query, Object.fromEntries(new URL(request.url).searchParams)) : undefined;

      const scope = principal.scope ?? null;
      const live = runtime;
      const result = await withScope(scope, () => handler({
        request,
        principal: principal as PrincipalFor<O>,
        body: body as Parsed<B>,
        query: query as Parsed<Q>,
        params,
        runtime: live,
        auditTarget: (type, id, metadata) => { target = { type, id, metadata }; },
        header: (name, value) => { extraHeaders.set(name, value); },
      }));

      if (options.audit) {
        await audit({ action: options.audit, outcome: "success", ...auditContext(), targetType: target.type, targetId: target.id, metadata: target.metadata });
      }

      if (result instanceof Response) return result;
      if (result === undefined || result === null) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      return json(200, result, extraHeaders);
    } catch (error) {
      if (error instanceof APIError) {
        const body = error.body as { code?: string; message?: string } | undefined;
        return errorResponse(new HttpError(error.statusCode, body?.code ?? "AUTH_ERROR", body?.message ?? "Request could not be completed."));
      }
      if (error instanceof HttpError) {
        if (error.status === 403 || error.code === "INVALID_API_KEY") {
          await audit({ action: "authz.denied", outcome: "denied", ...auditContext(), metadata: { path, method: request.method, reason: error.code } });
        }
        return errorResponse(error);
      }
      console.error(`[api] ${request.method} ${path}`, error);
      return errorResponse(new HttpError(500, "INTERNAL_ERROR", "Something went wrong."));
    } };

    const response = await respond();
    // TypeScript can't see that respond() assigned these.
    const [actor, resolved] = [principal as Principal, runtime as AuthRuntime | undefined];
    if (resolved) {
      reportRequest({
        at: new Date(started),
        method: request.method,
        path: path.slice(0, 512),
        status: response.status,
        durationMs: Date.now() - started,
        actorId: actor.kind === "anonymous" ? null : actor.user.id,
        ipAddress: clientIp(request.headers, resolved.settings),
        userAgent: request.headers.get("user-agent")?.slice(0, 256) ?? null,
      });
    }
    return response;
  };

  const policy: RoutePolicy = {
    access: options.access,
    permission: options.access === "permission" ? options.permission : undefined,
    scope: options.access === "permission" ? options.scope : undefined,
    reason: options.access === "public" ? options.reason : undefined,
    fresh: options.fresh === true,
    apiKey: options.apiKey === true,
    audit: options.audit,
  };
  return Object.assign(guarded, { [ROUTE_POLICY]: policy });
}

/** Mounts better-auth's own HTTP surface, which applies its own CSRF, rate limits and sessions. */
export function authEndpoint(): GuardedHandler {
  const handler: NextHandler = async (request) => {
    const { auth } = await getRuntime();
    return auth.handler(request);
  };
  return Object.assign(handler, {
    [ROUTE_POLICY]: { access: "public", reason: "better-auth endpoints authenticate themselves", fresh: false, apiKey: false } satisfies RoutePolicy,
  });
}
