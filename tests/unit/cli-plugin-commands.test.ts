import { describe, expect, it, vi } from "vitest";

const config = { plugins: [] as Array<{ name: string; commands?: Array<{ name: string; usage: string; describe: string; run: () => void }> }> };
vi.mock("../../packages/cms/scripts/sync.mjs", () => ({ loadCmsConfig: () => config }));

const { pluginCommands, runPluginCommand } = await import("../../packages/cms/scripts/commands.mjs");

const CORE = ["init", "sync", "routes", "doctor", "migrate", "superadmin", "types", "tick", "backup", "restore", "plugin", "field", "theme"];
const command = (name: string) => ({ name, usage: `tansy ${name} <thing>`, describe: "Does a thing.", run: () => {} });
const withPlugins = (plugins: typeof config.plugins) => { config.plugins = plugins; return () => pluginCommands("/app", CORE); };

/**
 * `tansy` dispatches a name it doesn't know to the plugin that declares it, so core never names a
 * plugin. These are the rules that keep that safe: a plugin can't take over a command of core's,
 * and two plugins can't both claim one.
 */
describe("the commands plugins add", () => {
  it("finds each plugin's commands by name, with the plugin that added them", () => {
    const found = withPlugins([
      { name: "multi-tenant", commands: [command("tenant")] },
      { name: "shop", commands: [command("orders")] },
      { name: "blog" },
    ])();
    expect([...found.keys()].sort()).toEqual(["orders", "tenant"]);
    expect(found.get("tenant")!.plugin).toBe("multi-tenant");
  });

  it("refuses a plugin that takes a name of cms's own", () => {
    for (const reserved of ["migrate", "backup", "doctor"]) {
      expect(withPlugins([{ name: "greedy", commands: [command(reserved)] }]), reserved)
        .toThrow(`adds a command called "${reserved}", which is one of cms's own`);
    }
  });

  it("refuses two plugins claiming the same command", () => {
    expect(withPlugins([
      { name: "multi-tenant", commands: [command("tenant")] },
      { name: "other", commands: [command("tenant")] },
    ])).toThrow(/both add "cms tenant"/);
  });

  it("refuses a name that isn't one plain word", () => {
    for (const bad of ["Tenant", "tenant list", "", "-tenant", "tenant!"]) {
      expect(withPlugins([{ name: "odd", commands: [command(bad)] }]), JSON.stringify(bad)).toThrow(/A command's name is lower-case letters/);
    }
  });
});

describe("what a command is given", () => {
  const run = async (flags: Record<string, string | boolean | undefined>, key: string | undefined, request = false) => {
    let seen: { url: string; args: string[] } | null = null;
    const previous = process.env.TANSY_API_KEY;
    if (key === undefined) delete process.env.TANSY_API_KEY;
    else process.env.TANSY_API_KEY = key;
    try {
      await runPluginCommand(
        {
          plugin: "multi-tenant",
          command: {
            ...command("tenant"),
            run: async (context: { api: { url: string; request: (path: string) => Promise<unknown> }; args: string[] }) => {
              seen = { url: context.api.url, args: context.args };
              if (request) await context.api.request("/tenants");
            },
          },
        },
        { args: ["list", "extra"], flags, fail: (message: string) => { throw new Error(message); }, log: () => {} },
      );
    } finally {
      if (previous === undefined) delete process.env.TANSY_API_KEY;
      else process.env.TANSY_API_KEY = previous;
    }
    return seen!;
  };

  it("hands over the words after the command's own name", async () => {
    expect((await run({}, "key-value")).args).toEqual(["list", "extra"]);
  });

  it("takes the server from --url before the environment", async () => {
    expect((await run({ url: "https://cms.example" }, "key-value")).url).toBe("https://cms.example");
  });

  /** Asked for on the first request, so `tansy tenant` with no action can still print its usage. */
  it("asks for the API key when a command first reaches the server, not before", async () => {
    expect((await run({}, undefined)).args).toEqual(["list", "extra"]);
    await expect(run({}, undefined, true)).rejects.toThrow(/Set TANSY_API_KEY/);
    // The message names the command the person typed, not the plugin behind it.
    await expect(run({}, undefined, true)).rejects.toThrow(/"cms tenant"/);
  });
});
