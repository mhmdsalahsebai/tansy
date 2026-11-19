import "server-only";
import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CmsHooks } from "./define";
import { assertFileFits, assertHookEvent, assertJob, assertRoute, dynamicState, type LoadedFile, type Registrations } from "./registry";

const hooksDir = () => path.resolve(process.env.TANSY_HOOKS_DIR ?? "cms_hooks");
const IS_HOOK_FILE = /^[^._].*(?<!\.d)\.(ts|mts|js|mjs)$/;

/** Node runs these directly, stripping types. The bundler must leave this import alone, or changing a file would need a rebuild. */
const importFile = (url: string): Promise<{ default?: unknown }> => import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url);

async function loadFile(file: string, mtimeMs: number): Promise<Registrations> {
  const loaded: Registrations = { hooks: [], routes: [], jobs: [] };
  const source = `cms_hooks/${path.basename(file)}`;
  const api: CmsHooks = {
    on: (event: string, fn: unknown) => {
      assertHookEvent(event);
      if (typeof fn !== "function") throw new Error(`The hook for ${event} is not a function.`);
      loaded.hooks.push({ source, event, fn: fn as never });
    },
    route: (value) => { assertRoute(value); loaded.routes.push({ source, value }); },
    job: (value) => { assertJob(value); loaded.jobs.push({ source, value }); },
  };
  const { default: register } = await importFile(`${pathToFileURL(file).href}?v=${mtimeMs}`);
  if (typeof register !== "function") throw new Error("The file must have a default export: (cms) => { ... }.");
  await register(api);
  return loaded;
}

async function listFiles(dir: string) {
  const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  return names.filter((name) => IS_HOOK_FILE.test(name)).map((name) => path.join(dir, name));
}

/**
 * Loads new and changed files. When a change fails to load, the file's previous
 * version stays active: a broken save must not silently remove a hook that
 * rejects bad writes. With `strict`, as at startup, a failure throws instead.
 */
export async function loadHookFiles({ strict }: { strict: boolean }) {
  const files = await listFiles(hooksDir());
  const present = new Set(files);
  for (const file of dynamicState.files.keys()) if (!present.has(file)) dynamicState.files.delete(file);

  for (const file of files) {
    const { mtimeMs } = await stat(file);
    const current = dynamicState.files.get(file);
    if (current?.mtimeMs === mtimeMs) continue;
    try {
      const loaded: LoadedFile = { file: path.basename(file), mtimeMs, ...(await loadFile(file, mtimeMs)) };
      assertFileFits(file, loaded);
      dynamicState.files.set(file, loaded);
    } catch (error) {
      if (strict) throw new Error(`Could not load ${file}: ${(error as Error).message}`, { cause: error });
      console.error(`[hooks] could not load ${file}. Keeping the previous version.`, error);
      const previous = current ?? { file: path.basename(file), hooks: [], routes: [], jobs: [] };
      dynamicState.files.set(file, { ...previous, mtimeMs, error: (error as Error).message.slice(0, 500) });
    }
  }
}

let watcher: FSWatcher | undefined;

/** Picks up saved files without a restart. A missing directory just means no hooks. */
export function watchHookFiles() {
  if (watcher) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    watcher = watch(hooksDir(), () => {
      clearTimeout(timer);
      timer = setTimeout(() => void loadHookFiles({ strict: false }).catch((error) => console.error("[hooks]", error)), 250);
    });
    watcher.unref();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
