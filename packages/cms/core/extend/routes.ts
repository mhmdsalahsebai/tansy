import "server-only";
import { extensionScope } from "../scope/context";
import type { NextRequest } from "next/server";
import { systemPrincipal, type Principal } from "../authz/principal";
import { route, type GuardedHandler, type RouteContext } from "../authz/guard";
import { notFound } from "../http/errors";
import type { ExtensionRoute } from "./define";
import { scopedRecords } from "./records";
import { extensionRoutes } from "./registry";
import { matchRoute } from "./routing";
import { extensionMail } from "./mail";
import { extensionCaptcha } from "../captcha";
import { clientIp } from "../http/request";
import { extensionSchema } from "./schema";
import { pluginStore } from "./store";
import { extensionSettings } from "./settings";
import { extensionUsers } from "./users";
import { extensionAuth } from "./auth-call";
import { extensionToolsFor } from "./tools";

const guarded = new WeakMap<ExtensionRoute, GuardedHandler>();

/** Each extension route gets the same route() guard as a file under app/api, with its own policy. */
function guardFor(definition: ExtensionRoute, source: string) {
  let handler = guarded.get(definition);
  if (handler) return handler;
  // route() reads only its policy fields, so the definition can serve as its options.
  const run = (context: RouteContext<unknown, unknown, Principal>) => definition.handler({
    request: context.request,
    principal: context.principal,
    body: context.body,
    query: context.query,
    params: context.params,
    ip: clientIp(context.request.headers, context.runtime.settings),
    auditTarget: context.auditTarget,
    records: scopedRecords(context.principal, context.request.headers),
    system: { records: scopedRecords(systemPrincipal(source), new Headers(), source), users: extensionUsers(source) },
    store: pluginStore(source.replace(/^plugin:/, "")),
    mail: extensionMail(source),
    captcha: extensionCaptcha,
    schema: extensionSchema,
    scope: extensionScope(source),
    settings: extensionSettings(source),
    auth: extensionAuth(context.runtime, source, context.request.headers),
    tools: extensionToolsFor(context.principal, context.request.headers, source),
  }) as Promise<unknown>;
  handler = route(definition as never, run as never);
  guarded.set(definition, handler);
  return handler;
}

export function dispatchExtensionRoute(request: NextRequest, segments: string[]) {
  const routes = extensionRoutes();
  const match = matchRoute(routes.map(({ value }) => value), request.method, segments);
  if (!match) throw notFound("Route");
  const { source } = routes.find(({ value }) => value === match.route)!;
  return guardFor(match.route, source)(request, { params: Promise.resolve(match.params) });
}
