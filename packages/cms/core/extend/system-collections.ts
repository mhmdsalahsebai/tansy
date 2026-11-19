import { getCmsConfig } from "../config";

/**
 * Collections only one plugin's own `system.records` may write (`systemCollections` in its
 * manifest), by slug, with the plugin's name. Each must start with the plugin's name, so a
 * plugin can't claim someone else's collection.
 */
export function systemCollections(): Map<string, string> {
  const owners = new Map<string, string>();
  for (const plugin of getCmsConfig().plugins ?? []) {
    for (const slug of plugin.systemCollections ?? []) {
      if (!slug.startsWith(`${plugin.name}-`)) throw new Error(`Plugin "${plugin.name}": system collection "${slug}" must start with "${plugin.name}-".`);
      owners.set(slug, plugin.name);
    }
  }
  return owners;
}

export const systemCollectionOwner = (slug: string): string | null => systemCollections().get(slug) ?? null;
