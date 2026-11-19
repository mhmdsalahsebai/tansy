import type { NextRequest } from "next/server";
import type { CmsConfig } from "../core/auth/extensions";
import { getRuntime } from "../core/auth/instance";
import { ROUTE_POLICY, type GuardedHandler } from "../core/authz/guard";
import { provideCmsConfig } from "../core/config";
import { preflight, withCors } from "../core/http/cors";
import { apiRoutes } from "./api-table.generated";
import { createMatcher } from "./match";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

type Context = { params: Promise<{ cms: string[] }> };
type Handler = (request: NextRequest, context: Context) => Promise<Response>;

const notFound = () => Response.json({ error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404 });

const allowed = (routeModule: Record<string, unknown>) => {
  const methods = METHODS.filter((method) => routeModule[method]);
  return [...methods, ...(routeModule.GET ? ["HEAD"] : []), "OPTIONS"].join(", ");
};

const match = createMatcher(apiRoutes);

/** Serves every CMS API route from one catch-all file. It grants nothing: each route still runs under its own route() guard. */
export function createApiHandlers(config: CmsConfig): Record<(typeof METHODS)[number] | "HEAD" | "OPTIONS", Handler> {
  provideCmsConfig(config);

  const serve = (method: string): Handler => async (request, context) => {
    const found = match((await context.params).cms);
    if (!found) return notFound();
    const routeModule = (await found.entry.load()) as Record<string, unknown>;

    // What Next.js does for a route file that doesn't export these, and a browser's CORS preflight.
    if (method === "OPTIONS" && !routeModule.OPTIONS) {
      if (!request.headers.has("origin")) return new Response(null, { status: 204, headers: { Allow: allowed(routeModule) } });
      return preflight(request, (await getRuntime()).settings, allowed(routeModule));
    }
    const handler = (routeModule[method] ?? (method === "HEAD" ? routeModule.GET : undefined)) as GuardedHandler | undefined;
    if (!handler) return new Response(null, { status: 405, headers: { Allow: allowed(routeModule) } });

    // tests/contract proves this can't happen. Refusing here keeps it that way if the table is ever wrong.
    if (!handler[ROUTE_POLICY]) throw new Error(`${method} /api/${found.entry.pattern} is not wrapped in route().`);

    const response = await handler(request, { params: Promise.resolve(found.params) });
    return method === "HEAD" && !routeModule.HEAD ? new Response(null, { status: response.status, headers: response.headers }) : response;
  };

  // Every answer, better-auth's and errors included, so a trusted frontend on another origin can read it.
  const dispatch = (method: string): Handler => async (request, context) => {
    const response = await serve(method)(request, context);
    if (method === "OPTIONS" || !request.headers.has("origin")) return response;
    return withCors(response, request, (await getRuntime()).settings);
  };

  return { GET: dispatch("GET"), POST: dispatch("POST"), PUT: dispatch("PUT"), PATCH: dispatch("PATCH"), DELETE: dispatch("DELETE"), HEAD: dispatch("HEAD"), OPTIONS: dispatch("OPTIONS") };
}
