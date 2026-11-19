import "server-only";
import { getCmsConfig } from "../config";
import { isKnownPermission } from "../authz/permissions";
import { fieldTypeNames } from "../fields/registry";
import { assertPreviewUrl, assertThemeManifest } from "../theme/define";
import { installedThemes } from "../theme/installed";
import { parseCron } from "./cron";
import { assertPluginManifest, pluginRoutes } from "./manifest";
import { HOOK_EVENTS, type AfterHook, type AgentTool, type BeforeHook, type CmsPlugin, type LifecycleHook, type ExtensionRoute, type HookEvent, type JobDefinition } from "./define";
import { HTTP_METHODS, routePathProblem } from "./routing";

export interface Registered<T> { source: string; value: T }
export interface HookEntry { source: string; event: HookEvent; fn: BeforeHook | AfterHook | LifecycleHook<never> }

export interface Registrations {
  hooks: HookEntry[];
  routes: Array<Registered<ExtensionRoute>>;
  jobs: Array<Registered<JobDefinition>>;
  blocks?: Array<Registered<{ name: string }>>;
  tools?: Array<Registered<AgentTool>>;
}

export interface LoadedFile extends Registrations { file: string; mtimeMs: number; error?: string }

interface DynamicState { files: Map<string, LoadedFile> }

declare const globalThis: { cmsExtensions?: DynamicState } & typeof global;

/** On globalThis because Next.js gives routes and instrumentation separate copies of a module. */
export const dynamicState: DynamicState = (globalThis.cmsExtensions ??= { files: new Map() });

export function assertRoute(route: ExtensionRoute) {
  const name = `${route.method} ${route.path}`;
  const fail = (problem: string) => { throw new Error(`Route ${name}: ${problem}.`); };
  if (!HTTP_METHODS.includes(route.method)) fail("unknown method");
  const pathProblem = routePathProblem(route.path);
  if (pathProblem) fail(`path ${pathProblem}`);
  if (typeof route.handler !== "function") fail("needs a handler");
  if (route.access === "public") {
    if (!route.reason?.trim()) fail("a public route must give a reason");
  } else if (route.access === "permission") {
    if (!isKnownPermission(route.permission)) fail(`unknown permission "${route.permission}"`);
    if (route.method !== "GET" && !route.audit) fail("a write must declare an audit action");
  } else if (route.access === "authenticated") {
    if (route.method !== "GET" && !route.audit) fail("a write must declare an audit action");
  } else {
    fail('access must be "public", "authenticated" or "permission"');
  }
}

const JOB_NAME = /^[A-Za-z0-9._:-]{1,100}$/;

/** Startup fails on a tool an agent couldn't be trusted with, the way it does for a route. */
export function assertTool(tool: AgentTool) {
  const fail = (problem: string) => { throw new Error(`Tool ${tool.name}: ${problem}.`); };
  if (tool.access?.access === "permission") {
    if (!isKnownPermission(tool.access.permission)) fail(`unknown permission "${tool.access.permission}"`);
  } else if (tool.access?.access !== "authenticated") {
    fail('access must be "authenticated" or "permission"');
  }
}

export function assertJob(job: JobDefinition) {
  if (!JOB_NAME.test(job.name)) throw new Error(`Invalid job name "${job.name}".`);
  if (typeof job.handler !== "function") throw new Error(`Job ${job.name} needs a handler.`);
  parseCron(job.cron);
}

export function assertHookEvent(event: string): asserts event is HookEvent {
  if (!HOOK_EVENTS.includes(event as HookEvent)) throw new Error(`Unknown hook event "${event}".`);
}

function fromPlugin(plugin: CmsPlugin): Registrations {
  assertPluginManifest(plugin);
  const source = `plugin:${plugin.name}`;
  return {
    hooks: Object.entries(plugin.hooks ?? {}).map(([event, fn]) => {
      assertHookEvent(event);
      return { source, event, fn: fn as HookEntry["fn"] };
    }),
    routes: pluginRoutes(plugin).map((value) => (assertRoute(value), { source, value })),
    jobs: (plugin.jobs ?? []).map((value) => (assertJob(value), { source, value })),
    blocks: (plugin.blocks ?? []).map((value) => ({ source, value })),
    tools: (plugin.tools ?? []).map((value) => (assertTool(value), { source, value })),
  };
}

/** Throws when two registrations want the same route, job or block. Parameter names don't count, since /a/:x and /a/:y match the same requests. */
export function assertNoClashes(groups: Registrations[]) {
  const taken = new Map<string, string>();
  const claim = (label: string, source: string) => {
    const owner = taken.get(label);
    if (owner) throw new Error(`${label} is registered by ${owner} and again by ${source}.`);
    taken.set(label, source);
  };
  for (const { routes, jobs, blocks, tools } of groups) {
    for (const { source, value } of routes) claim(`Route ${value.method} ${value.path.replace(/:[^/]+/g, ":param")}`, source);
    for (const { source, value } of jobs) claim(`Job ${value.name}`, source);
    for (const { source, value } of blocks ?? []) claim(`Block ${value.name}`, source);
    for (const { source, value } of tools ?? []) claim(`Tool ${value.name}`, source);
  }
}

let fromConfig: Registrations | undefined;

function configured(): Registrations {
  if (fromConfig) return fromConfig;
  const names = new Set<string>();
  const parts = (getCmsConfig().plugins ?? []).map((plugin) => {
    if (names.has(plugin.name)) throw new Error(`Plugin "${plugin.name}" is registered twice.`);
    names.add(plugin.name);
    return fromPlugin(plugin);
  });
  assertNoClashes(parts);
  return (fromConfig = { hooks: parts.flatMap((part) => part.hooks), routes: parts.flatMap((part) => part.routes), jobs: parts.flatMap((part) => part.jobs), tools: parts.flatMap((part) => part.tools ?? []) });
}

/** A hook file may not take a route or job already registered by a plugin or another file. `file` is left out, so a file can be saved again. */
export const assertFileFits = (file: string, loaded: Registrations) =>
  assertNoClashes([configured(), ...[...dynamicState.files].filter(([other]) => other !== file).map(([, state]) => state), loaded]);

/** Throws on a bad plugin, so startup fails instead of quietly losing a hook or route. */
export function assertConfiguredExtensions() {
  fieldTypeNames();
  configured();
  const { plugins = [], previewUrl } = getCmsConfig();
  const names = plugins.map(({ name }) => name);
  // Every installed theme is checked, not only the default one, so a tenant can't choose a theme that would fail.
  for (const theme of installedThemes()) assertThemeManifest(theme, names);
  if (previewUrl) assertPreviewUrl(previewUrl);
}

const dynamicFiles = () => [...dynamicState.files.values()];

export const hooksFor = (event: HookEvent): HookEntry[] => [...configured().hooks, ...dynamicFiles().flatMap((file) => file.hooks)].filter((hook) => hook.event === event);

export const extensionRoutes = (): Array<Registered<ExtensionRoute>> => [...configured().routes, ...dynamicFiles().flatMap((file) => file.routes)];

/** Plugins' agent tools. Hook files don't declare tools. */
export const extensionTools = (): Array<Registered<AgentTool>> => configured().tools ?? [];

export const extensionJobs = (): Array<Registered<JobDefinition>> => [...configured().jobs, ...dynamicFiles().flatMap((file) => file.jobs)];

export const hookFiles = () => dynamicFiles().map(({ file, error }) => ({ file, error: error ?? null }));
