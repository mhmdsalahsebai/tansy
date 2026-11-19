"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AdminClientParts, AdminClientPlugin, SitePreview } from "../core/extend/admin";

/** Each item keeps the name of its plugin, for the error boundary around it. */
export type AdminClientConfig = { [K in keyof AdminClientParts]-?: Array<NonNullable<AdminClientParts[K]>[number] & { plugin: string }> };

const SLOTS = ["fieldAdmin", "authWidgets", "recordPanels", "fieldActions", "gridColumns", "recordActions", "bulkActions", "settingsTabs", "blockActions", "blockEditors"] as const;

export function flattenPlugins(plugins: AdminClientPlugin[], enabled: string[]): AdminClientConfig {
  const active = plugins.filter((plugin) => enabled.includes(plugin.name));
  return Object.fromEntries(SLOTS.map((slot) => [slot, active.flatMap((plugin) => (plugin[slot] ?? []).map((item: object) => ({ ...item, plugin: plugin.name })))])) as AdminClientConfig;
}

const AdminClientContext = createContext<AdminClientConfig | null>(null);
const AccessContext = createContext<readonly string[]>([]);

type SitePreviewLoader = () => Promise<{ default: SitePreview }>;
const SitePreviewContext = createContext<SitePreviewLoader | null>(null);

/**
 * Hands the plugins' browser-side code to the forms. It comes from the app's generated
 * map, so the package never imports the app. `enabled` holds the plugins this server is
 * running, as the map may list one that's switched off. `sitePreview` loads the site's
 * components when the editor first needs them, so blocks show as they will look.
 */
export function AdminClientProvider({ plugins, enabled, sitePreview, children }: { plugins: AdminClientPlugin[]; enabled: string[]; sitePreview?: SitePreviewLoader; children?: ReactNode }) {
  const value = useMemo(() => flattenPlugins(plugins, enabled), [plugins, enabled]);
  return (
    <AdminClientContext.Provider value={value}>
      <SitePreviewContext.Provider value={sitePreview ?? null}>{children}</SitePreviewContext.Provider>
    </AdminClientContext.Provider>
  );
}

const loaded = new WeakMap<SitePreviewLoader, SitePreview | null>();
const loading = new WeakMap<SitePreviewLoader, Promise<SitePreview | null>>();

/** Starts loading the site's components, once per loader. */
export function loadPreview(load: SitePreviewLoader) {
  let pending = loading.get(load);
  if (!pending) {
    pending = load().then((module) => module.default ?? null, (error: unknown) => {
      console.error("The site's components couldn't load, so blocks show as forms.", error);
      return null;
    }).then((preview) => {
      loaded.set(load, preview);
      return preview;
    });
    loading.set(load, pending);
  }
  return pending;
}

/** The site's components, once loaded. Null until then, and in an app whose host files don't pass them. */
export function useSitePreview(): SitePreview | null {
  const load = useContext(SitePreviewContext);
  const [preview, setPreview] = useState<SitePreview | null>(() => (load ? loaded.get(load) ?? null : null));
  useEffect(() => {
    if (!load) return;
    let live = true;
    void loadPreview(load).then((next) => { if (live) setPreview(next); });
    return () => { live = false; };
  }, [load]);
  return preview;
}

/** The signed-in person's permissions, to decide which slots to offer. It grants nothing: routes check for themselves. */
export function AdminAccess({ permissions, children }: { permissions: string[]; children?: ReactNode }) {
  return <AccessContext.Provider value={permissions}>{children}</AccessContext.Provider>;
}

/** Whether this person holds a permission, for deciding what to offer. It grants nothing: routes check for themselves. */
export function useHolds() {
  const permissions = useContext(AccessContext);
  return useMemo(() => {
    const held = new Set(permissions);
    return (permission: string) => held.has(permission);
  }, [permissions]);
}

/**
 * Whether this person holds a `record:*` permission for a collection, for all
 * collections, for that one, or for their own records in it. For deciding what to
 * show: routes check for themselves, record by record.
 */
export function useRecordAccess() {
  const permissions = useContext(AccessContext);
  return useMemo(() => {
    const held = new Set(permissions);
    return (permission: `record:${string}`, collectionId: number | string) =>
      held.has(permission) || held.has(`${permission}@c${collectionId}`) || held.has(`${permission}@c${collectionId}:own`);
  }, [permissions]);
}

/** Throws without a provider, so a missing setup can't quietly drop a plugin's input or CAPTCHA. */
export function useAdminClient(): AdminClientConfig {
  const config = useContext(AdminClientContext);
  if (!config) throw new Error("AdminClientProvider is missing from the root layout.");
  return config;
}

const applies = (item: { collections?: string[] }, slug: string) => !item.collections || item.collections.includes(slug);

/** The slots this person may see, for one collection. */
export function useAdminSlots(collection?: string) {
  const config = useAdminClient();
  const permissions = useContext(AccessContext);
  return useMemo(() => {
    const allowed = <T extends { permission: string }>(items: T[]) => items.filter((item) => permissions.includes(item.permission));
    const inCollection = <T extends { permission: string; collections?: string[] }>(items: T[]) => allowed(items).filter((item) => collection === undefined || applies(item, collection));
    return {
      gridColumns: inCollection(config.gridColumns),
      recordActions: inCollection(config.recordActions),
      fieldActions: inCollection(config.fieldActions),
      bulkActions: inCollection(config.bulkActions),
      settingsTabs: allowed(config.settingsTabs),
      blockActions: allowed(config.blockActions),
    };
  }, [config, permissions, collection]);
}
