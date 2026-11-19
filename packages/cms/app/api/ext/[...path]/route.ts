import { route } from "../../../../core/authz/guard";
import { dispatchExtensionRoute } from "../../../../core/extend/routes";

// The dispatcher itself grants nothing. Each extension route runs under its own route() guard, which is also where CSRF, rate limits and audit apply.
const dispatcher = { access: "public", reason: "dispatches to extension routes, each guarded by its own declared policy", apiKey: true, rateLimit: false } as const;
const segments = (params: Record<string, string>) => params.path as unknown as string[];

export const GET = route(dispatcher, async ({ request, params }) => dispatchExtensionRoute(request, segments(params)));
export const POST = route(dispatcher, async ({ request, params }) => dispatchExtensionRoute(request, segments(params)));
export const PUT = route(dispatcher, async ({ request, params }) => dispatchExtensionRoute(request, segments(params)));
export const PATCH = route(dispatcher, async ({ request, params }) => dispatchExtensionRoute(request, segments(params)));
export const DELETE = route(dispatcher, async ({ request, params }) => dispatchExtensionRoute(request, segments(params)));
