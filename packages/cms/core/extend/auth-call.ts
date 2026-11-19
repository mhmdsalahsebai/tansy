import "server-only";
import type { AuthRuntime } from "../auth/instance";
import { HttpError } from "../http/errors";
import type { ExtensionAuth } from "./define";
import { refreshPluginOrigins } from "../http/plugin-origins";

/**
 * Headers a better-auth endpoint needs to know who is calling and from where. The session
 * cookie is the caller's own: a route can act for nobody else. API keys stay behind, as an
 * extension route takes them only when it says so, and better-auth would read them as a
 * session of their own.
 */
const FORWARDED = ["cookie", "user-agent", "x-forwarded-for", "x-real-ip", "cf-connecting-ip", "accept-language"];

/**
 * A bearer session token is the same session as a cookie, sent by a headless site or an app
 * that can't keep cookies, and the route guard already read the caller from it. It goes along
 * only as a bearer token, and only when no API key came with it: then the guard's caller is the
 * key's owner, who may not be the token's.
 */
function bearerToken(incoming: Headers) {
  const value = incoming.get("authorization");
  return value && !incoming.has("x-api-key") && /^bearer \S/i.test(value) ? value : null;
}

/**
 * better-auth's errors carry a status and a message meant for the caller. A plugin's
 * better-auth plugin may bring its own copy of better-call, whose APIError the route guard's
 * `instanceof` can't recognize, so they're recognized by shape and become an HttpError.
 */
function asHttpError(error: unknown) {
  const { statusCode, body } = (error ?? {}) as { statusCode?: unknown; body?: { code?: unknown; message?: unknown } };
  if (typeof statusCode !== "number" || statusCode < 400 || statusCode > 599) return error;
  const code = typeof body?.code === "string" && body.code ? body.code : "AUTH_ERROR";
  const message = typeof body?.message === "string" && body.message ? body.message : "Request could not be completed.";
  // A 5xx says nothing useful to the caller and may describe the server.
  return statusCode >= 500 ? new HttpError(502, "UPSTREAM_FAILED", "Something went wrong.") : new HttpError(statusCode, code, message);
}

type Input = { body?: Record<string, unknown>; query?: Record<string, unknown> };
type Endpoint = (context: Record<string, unknown>) => Promise<unknown>;

/** `source` is plugin:<name> for a plugin. Hook files add no better-auth plugins, so they can call nothing. */
export function extensionAuth(runtime: AuthRuntime, source: string, incoming: Headers): ExtensionAuth {
  const plugin = source.startsWith("plugin:") ? source.slice("plugin:".length) : null;
  const refuse = (what: string) => new Error(`${plugin ? `Plugin "${plugin}"` : "A hook file"} added no better-auth endpoint ${what}. Only endpoints of a plugin's own auth.plugins can be called, and only while they're installed.`);
  const run = async <T>(key: string, headers: Headers | undefined, input: Input) => {
    const endpoint = (runtime.auth.api as unknown as Record<string, Endpoint>)[key];
    try {
      return await endpoint({ ...(headers ? { headers } : {}), ...(input.body ? { body: input.body } : {}), ...(input.query ? { query: input.query } : {}) }) as T;
    } catch (error) {
      throw asHttpError(error);
    }
  };
  return {
    refreshTrustedOrigins: () => refreshPluginOrigins(true),
    async server<T>(endpoint: string, input: Input = {}) {
      const key = !plugin ? undefined : endpoint.startsWith("/") ? runtime.extensionEndpoints.get(plugin)?.get(endpoint) : runtime.extensionEndpointNames?.get(plugin)?.has(endpoint) ? endpoint : undefined;
      if (!plugin || !key) throw refuse(`called ${endpoint}`);
      // No headers at all: better-auth runs it as the server's own action, with no caller.
      return run<T>(key, undefined, input);
    },
    async call<T>(path: string, input: Input = {}) {
      const key = plugin ? runtime.extensionEndpoints.get(plugin)?.get(path) : undefined;
      if (!plugin || !key) throw refuse(`at ${path}`);
      const headers = new Headers();
      for (const name of FORWARDED) {
        const value = incoming.get(name);
        if (value !== null) headers.set(name, value);
      }
      const bearer = bearerToken(incoming);
      if (bearer) headers.set("authorization", bearer);
      return run<T>(key, headers, input);
    },
  };
}
