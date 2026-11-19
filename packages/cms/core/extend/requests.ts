import "server-only";
import { getCmsConfig } from "../config";
import type { ApiRequest, ExtensionContext } from "./define";
import { extensionContext } from "./hooks";

const contexts = new Map<string, ExtensionContext>();

/** Hands a finished API request to every plugin's `onRequest`. Never throws, and never waits on a plugin. */
export function reportRequest(request: ApiRequest) {
  let plugins;
  try {
    plugins = getCmsConfig().plugins ?? [];
  } catch {
    return;
  }
  for (const plugin of plugins) {
    if (!plugin.onRequest) continue;
    try {
      let context = contexts.get(plugin.name);
      if (!context) contexts.set(plugin.name, context = extensionContext(`plugin:${plugin.name}`));
      plugin.onRequest({ ...request }, context);
    } catch (error) {
      console.error(`[plugin:${plugin.name}] onRequest failed`, error);
    }
  }
}
