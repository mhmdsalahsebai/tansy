import "server-only";
import prisma from "../../lib/prisma";
import { adminPath, apiPath } from "../../lib/paths";
import { getAdminConfig, getCmsConfig } from "../config";
import { holdsRecordPermissionForSome, type Permission } from "../authz/permissions";
import type { AdminIcon, AdminPage } from "./admin";
import { hasParams, matchPagePath, navIcon } from "./admin-paths";
import { labelIn } from "../i18n/labels";
import { pluginWord, type Translate } from "../i18n/messages";

export { hasParams, matchPagePath, navIcon };

/** A link in the navigation. `children` makes it a plugin's section, which opens to them. */
export interface PluginNavLink { name: string; href: string; icon?: string | AdminIcon; children?: PluginNavLink[] }

/** A plugin's choice in the top bar, with its routes as addresses (AdminSwitcher). */
export interface PluginSwitcher { plugin: string; label: string; options: string; select: string }

/** The plugin page at this address, exact paths before ones with params. */
export function findAdminPage(address: string): (AdminPage & { plugin: string; params: Record<string, string> }) | null {
  const pages = getAdminConfig().plugins.flatMap((plugin) => (plugin.pages ?? []).map((page) => ({ ...page, plugin: plugin.name })));
  for (const page of [...pages.filter((p) => !hasParams(p.path)), ...pages.filter((p) => hasParams(p.path))]) {
    const params = matchPagePath(page.path, address);
    if (params) return { ...page, params };
  }
  return null;
}

/** Whether someone may list some of this collection's records. False when there's no such collection. */
export async function canListCollection(permissions: ReadonlySet<string>, slug: string) {
  const collection = await prisma.collection.findUnique({ where: { slug }, select: { id: true } });
  return Boolean(collection && holdsRecordPermissionForSome(permissions, "record:list", collection.id));
}

/** Who may see and change a plugin's settings. */
export function settingsPermission(plugin: string): Permission | null {
  const manifest = (getCmsConfig().plugins ?? []).find((candidate) => candidate.name === plugin);
  if (!manifest?.settings) return null;
  return manifest.settings.permission ?? "setting:update";
}

export const pluginSettingsPath = (plugin: string) => adminPath(`/extensions/${plugin}/settings`);

/**
 * Plugins' entries in the navigation for someone with these permissions: a section for each
 * plugin that declares one, and the pages and links of those that don't, flat. It only decides
 * what to offer. Every page it links to checks for itself.
 */
/** `t` and `locale` give the names in the person's interface language. */
export async function pluginNav(permissions: ReadonlySet<string>, { t = (key: string) => key, locale = "en" }: { t?: Translate; locale?: string } = {}): Promise<{ sections: PluginNavLink[]; loose: PluginNavLink[]; shortcuts: PluginNavLink[]; switchers: PluginSwitcher[] }> {
  const plugins = getAdminConfig().plugins;
  const slugs = plugins.flatMap((plugin) => [
    ...(plugin.section?.items.flatMap((item) => ("collection" in item ? [item.collection] : [])) ?? []),
    ...(plugin.pages ?? []).flatMap((page) => (page.collection ? [page.collection] : [])),
  ]);
  const collections = new Map(slugs.length ? (await prisma.collection.findMany({ where: { slug: { in: slugs } }, select: { id: true, slug: true, name: true, labels: true } })).map((c) => [c.slug, c]) : []);
  const allowed = (permission?: Permission) => !permission || permissions.has(permission);
  const lists = (slug: string) => { const collection = collections.get(slug); return Boolean(collection && holdsRecordPermissionForSome(permissions, "record:list", collection.id)); };
  const opens = (page: AdminPage) => !hasParams(page.path) && allowed(page.permission) && (!page.collection || lists(page.collection));

  const sections: PluginNavLink[] = [];
  const loose: PluginNavLink[] = [];
  const shortcuts: PluginNavLink[] = [];
  const switchers: PluginSwitcher[] = [];
  const manifests = new Map((getCmsConfig().plugins ?? []).map((manifest) => [manifest.name, manifest]));
  for (const plugin of plugins) {
    const word = (key: string, fallback: string) => pluginWord(t, plugin.name, key, fallback);
    const named = new Set<string>();
    const children: PluginNavLink[] = [];
    for (const item of plugin.section?.items ?? []) {
      if ("page" in item) {
        named.add(item.page);
        const page = plugin.pages?.find((candidate) => candidate.path === item.page);
        if (page && opens(page)) children.push({ name: word(`pages.${page.path}`, item.title ?? page.title), href: adminPath(`/ext/${page.path}`) });
      } else if ("collection" in item) {
        const collection = collections.get(item.collection);
        if (collection && lists(item.collection)) children.push({ name: word(`collections.${item.collection}`, item.title ?? labelIn(collection, collection.name, locale)), href: adminPath(`/collections/${collection.id}`) });
      } else {
        const permission = settingsPermission(plugin.name);
        if (permission && allowed(permission)) children.push({ name: word("settingsTitle", item.title ?? t("nav.Settings")), href: pluginSettingsPath(plugin.name) });
      }
    }
    // A section of one item is one link, with the section's name and icon, for a plugin that does everything on one page.
    if (plugin.section && children.length === 1) sections.push({ name: word("section", plugin.section.title), href: children[0].href, icon: navIcon(plugin.section.icon) });
    else if (plugin.section && children.length) sections.push({ name: word("section", plugin.section.title), href: children[0].href, icon: navIcon(plugin.section.icon), children });
    for (const page of plugin.pages ?? []) {
      if (!named.has(page.path) && opens(page)) loose.push({ name: word(`pages.${page.path}`, page.title), href: adminPath(`/ext/${page.path}`) });
    }
    for (const item of plugin.navItems ?? []) if (allowed(item.permission)) loose.push({ name: word(`nav.${item.path}`, item.title), href: adminPath(item.path) });
    const shortcut = plugin.shortcut;
    const target = shortcut && plugin.pages?.find((page) => page.path === shortcut.page);
    if (shortcut && target && opens(target)) shortcuts.push({ name: word("shortcut", shortcut.title ?? word(`pages.${target.path}`, target.title)), href: adminPath(`/ext/${target.path}`), icon: navIcon(shortcut.icon ?? plugin.section?.icon) });
    const switcher = plugin.switcher;
    if (switcher && allowed(switcher.permission)) {
      const routes = manifests.get(plugin.name)?.routes ?? [];
      const has = (method: string, path: string) => routes.some((route) => route.method === method && route.path === path);
      if (has("GET", switcher.options) && has("POST", switcher.select)) {
        switchers.push({ plugin: plugin.name, label: word("switcher", switcher.label), options: apiPath(`/ext/${plugin.name}${switcher.options}`), select: apiPath(`/ext/${plugin.name}${switcher.select}`) });
      } else {
        console.error(`[admin] ${plugin.name}: the switcher needs a GET ${switcher.options} and a POST ${switcher.select} among the plugin's routes. It isn't shown.`);
      }
    }
  }
  return { sections, loose, shortcuts, switchers };
}

/** The plugin, if any, that a collection belongs to by its slug, with the title its section shows. */
export function collectionOwners(t: Translate = (key) => key): Array<{ plugin: string; prefix: string; title: string }> {
  return getAdminConfig().plugins.map((plugin) => ({ plugin: plugin.name, prefix: `${plugin.name}-`, title: plugin.section ? pluginWord(t, plugin.name, "section", plugin.section.title) : plugin.name }));
}
