import { definePlugin, defineRoute } from "tansy/plugin";

export const WORKSPACE_HEADER = "x-workspace";
export const WORKSPACE_EDITOR = "workspaces-editor";

/**
 * Parses `alpha:ann@example.test,bob@example.test;beta:cat@example.test` into each workspace's
 * members by email. A workspace may list no one.
 */
export function parseWorkspaces(spec: string): Map<string, Set<string>> {
  const workspaces = new Map<string, Set<string>>();
  for (const entry of spec.split(";")) {
    const [name, members = ""] = entry.split(":");
    if (!name?.trim()) continue;
    workspaces.set(name.trim(), new Set(members.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean)));
  }
  return workspaces;
}

/**
 * Example of a row scope provider: the smallest plugin that splits records by workspace. A
 * request names its workspace in the x-workspace header, and the people listed for that
 * workspace edit its records there. Core keeps every scoped collection's records apart, below
 * roles and rules, so a request for one workspace never reads or writes another's. Only
 * collections turned scoped under Collections are split. The multi-tenant plugin does the same
 * on better-auth organizations. See "Row scopes" in docs/contributing/security-model.md.
 */
export const workspacesExample = (spec: string) => {
  const workspaces = parseWorkspaces(spec);
  const first = [...workspaces.keys()][0];
  if (!first) throw new Error("The workspaces example needs at least one workspace, such as TANSY_EXAMPLE_WORKSPACES=alpha:ann@example.test;beta");
  return definePlugin({
    name: "workspaces",
    version: "0.1.1",
    apiVersion: 1,
    requires: { cms: "^0.1.1" },
    migrations: [{
      id: "001-role",
      up: async ({ roles }) => {
        await roles.ensure({
          name: WORKSPACE_EDITOR,
          label: "Workspace editor",
          description: "Edits the records of the workspaces they belong to.",
          scope: "scoped",
          permissions: ["dashboard:access", "record:list", "record:read", "record:create", "record:update", "record:delete", "record:publish"],
        });
      },
    }],
    // A setting each workspace can have its own of, and one they share.
    settings: {
      fields: [
        { type: "text", name: "greeting", label: "Greeting", description: "Each workspace can word it its own way.", default: "Hello", maxLength: 80, perScope: true },
        { type: "text", name: "signature", label: "Signature", description: "The same for every workspace.", default: "The team", maxLength: 80 },
      ],
    },
    routes: [
      defineRoute({
        method: "GET",
        path: "/greeting",
        access: "public",
        reason: "Example: shows the settings as they apply in the request's workspace.",
        handler: async ({ settings }) => {
          const { greeting, signature } = await settings.get();
          return { greeting, signature };
        },
      }),
      // The plugin's store is split by workspace too: each counts its own visits.
      defineRoute({
        method: "POST",
        path: "/visits",
        access: "authenticated",
        audit: "workspaces.visit",
        handler: async ({ store }) => {
          const visits = Number(await store.get("visits") ?? 0) + 1;
          await store.set("visits", visits);
          return { visits };
        },
      }),
      defineRoute({
        method: "GET",
        path: "/visits",
        access: "authenticated",
        handler: async ({ store }) => ({ visits: Number(await store.get("visits") ?? 0), ticks: Number(await store.get("ticks") ?? 0) }),
      }),
    ],
    // Runs outside any workspace, then once in each, so each workspace's store counts its own ticks.
    jobs: [{
      name: "workspaces-tick",
      cron: "* * * * *",
      perScope: true,
      handler: async ({ store }) => void (await store.set("ticks", Number(await store.get("ticks") ?? 0) + 1)),
    }],
    scope: {
      label: "Workspace",
      // Collections stay shared until someone scopes them, so the rest of the site is unchanged.
      scopeNewCollections: false,
      resolve: ({ headers }) => headers.get(WORKSPACE_HEADER)?.trim() || null,
      exists: (value) => workspaces.has(value),
      rolesFor: ({ user }, value) => (workspaces.get(value)?.has(user.email.toLowerCase()) ? [WORKSPACE_EDITOR] : []),
      initial: () => first,
      values: () => [...workspaces.keys()],
    },
  });
};
