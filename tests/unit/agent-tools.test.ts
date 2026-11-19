import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentTool, CmsPlugin } from "@/core/extend/define";
import type { Principal } from "@/core/authz/principal";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(async () => {}),
  pluginTools: [] as Array<{ source: string; value: AgentTool }>,
  created: [] as Array<{ slug: string; data: Record<string, unknown>; principal: unknown }>,
}));

vi.mock("@/core/audit", () => ({ audit: mocks.audit }));
vi.mock("@/core/extend/registry", () => ({ extensionTools: () => mocks.pluginTools }));
vi.mock("@/core/extend/records", () => ({
  scopedRecords: (principal: unknown) => ({
    create: async (slug: string, data: Record<string, unknown>) => {
      mocks.created.push({ slug, data, principal });
      return { id: 7, ...data };
    },
    list: async () => ({ page: 1, perPage: 30, totalItems: 0, totalPages: 0, items: [] }),
  }),
}));
vi.mock("@/core/content/access", () => ({
  allCollections: async () => [],
  requireCollectionBySlug: async (slug: string) => ({ id: 1, slug, name: "Posts", type: "base", fields: [{ name: "title", type: "text", config: {} }, { name: "body", type: "rich_text", config: {} }, { name: "content", type: "stream", config: {} }] }),
}));
vi.mock("@/core/blocks/service", () => ({
  listBlockTypes: async () => [],
  loadBlockCatalog: async () => new Map([["callout", { name: "callout", version: 3, fields: [{ name: "text", type: "rich_text" }] }]]),
}));

const { callTool, CORE_TOOLS, toolsFor } = await import("@/core/extend/tools");
const { handleMcp } = await import("@/core/extend/mcp");
const { assertPluginManifest, CORE_TOOL_NAMES } = await import("@/core/extend/manifest");
const { markdownToRichText } = await import("@/core/fields/markdown");
const { richTextProblem } = await import("@/core/fields/rich-text");

const user = (permissions: string[] = []): Principal => ({
  kind: "user",
  user: { id: "u1", email: "editor@example.com", name: "Edie", role: "editor", emailVerified: true, twoFactorEnabled: false, createdAt: new Date(), updatedAt: new Date() },
  session: { id: "s1", createdAt: new Date(), impersonatedBy: null },
  permissions: new Set(permissions),
});

const pluginTool = (overrides: Partial<AgentTool> = {}): AgentTool => ({
  name: "demo_publish",
  description: "Publishes something.",
  input: z.object({ title: z.string().max(10) }),
  access: { access: "permission", permission: "ext.demo:publish" as never },
  write: true,
  audit: "demo.publish",
  handler: async ({ input, principal }) => ({ id: 3, echoed: (input as { title: string }).title, by: principal.kind }),
  ...overrides,
});

const plugin = (tools: AgentTool[]): CmsPlugin => ({ name: "demo", version: "1.0.0", apiVersion: 1, tools });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pluginTools = [];
  mocks.created = [];
});

describe("agent tool manifests", () => {
  it("accepts a well-formed tool", () => {
    expect(() => assertPluginManifest(plugin([pluginTool()]))).not.toThrow();
  });

  it.each([
    ["a name outside the plugin's prefix", { name: "publish" }, /must start with "demo_"/],
    ["a name with capitals", { name: "demo_Publish" }, /lowercase letters/],
    ["no description", { description: " " }, /needs a description/],
    ["a write without an audit action", { audit: undefined }, /must declare an audit action/],
    ["a non-object input", { input: z.string() as never }, /must take an object/],
    ["an input JSON Schema can't express", { input: z.object({ when: z.date() }) as never }, /JSON Schema can't express/],
    ["no handler", { handler: undefined as never }, /needs a handler/],
  ])("refuses %s", (_, change, message) => {
    expect(() => assertPluginManifest(plugin([pluginTool(change as Partial<AgentTool>)]))).toThrow(message);
  });

  it("keeps the list of core's tool names in step with the tools themselves", () => {
    expect(CORE_TOOLS.map((tool) => tool.name).sort()).toEqual([...CORE_TOOL_NAMES].sort());
  });
});

describe("running tools", () => {
  it("lists only the tools a caller may run", () => {
    mocks.pluginTools = [{ source: "plugin:demo", value: pluginTool() }];
    expect(toolsFor(user()).map((tool) => tool.name)).not.toContain("demo_publish");
    expect(toolsFor(user(["ext.demo:publish"])).map((tool) => tool.name)).toContain("demo_publish");
    expect(toolsFor({ kind: "anonymous", permissions: new Set() })).toEqual([]);
  });

  it("answers a tool the caller can't run as it answers an unknown one", async () => {
    mocks.pluginTools = [{ source: "plugin:demo", value: pluginTool() }];
    const refused = await callTool("demo_publish", { title: "x" }, user(), new Headers(), "mcp").catch((error) => error);
    const unknown = await callTool("nope", {}, user(), new Headers(), "mcp").catch((error) => error);
    expect(refused).toMatchObject({ status: 400, code: "UNKNOWN_TOOL" });
    expect(unknown).toMatchObject({ status: 400, code: "UNKNOWN_TOOL" });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("validates input before running", async () => {
    mocks.pluginTools = [{ source: "plugin:demo", value: pluginTool() }];
    await expect(callTool("demo_publish", { title: "far too long a title" }, user(["ext.demo:publish"]), new Headers(), "mcp")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("runs as the caller and audits ids, never values", async () => {
    mocks.pluginTools = [{ source: "plugin:demo", value: pluginTool() }];
    const result = await callTool("demo_publish", { title: "secret" }, user(["ext.demo:publish"]), new Headers(), "plugin:ai");
    expect(result).toEqual({ id: 3, echoed: "secret", by: "user" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "demo.publish", outcome: "success", actorId: "u1", targetId: "demo_publish", metadata: expect.objectContaining({ via: "plugin:ai", record: 3 }) }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("secret");
  });

  it("audits a failed call", async () => {
    mocks.pluginTools = [{ source: "plugin:demo", value: pluginTool({ handler: async () => { throw Object.assign(new Error("no"), { status: 403, code: "RULE_LOCKED" }); } }) }];
    await expect(callTool("demo_publish", { title: "x" }, user(["ext.demo:publish"]), new Headers(), "mcp")).rejects.toThrow("no");
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure", metadata: expect.objectContaining({ reason: "ERROR" }) }));
  });

  it("turns Markdown into rich text and fills in blocks' ids and versions when creating", async () => {
    await callTool("create_record", { collection: "posts", data: { title: "Hi", body: "# Hello\n\nSome **bold** text.", content: [{ type: "callout", value: { text: "Be *careful*" } }] } }, user(), new Headers(), "mcp");
    const [{ data, principal }] = mocks.created;
    expect((principal as Principal).kind).toBe("user");
    expect(data.title).toBe("Hi");
    expect(richTextProblem(data.body)).toBeNull();
    expect((data.body as { content: Array<{ type: string }> }).content[0].type).toBe("heading");
    const [block] = data.content as Array<{ id: string; v: number; value: { text: unknown } }>;
    expect(block.v).toBe(3);
    expect(block.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(richTextProblem(block.value.text)).toBeNull();
  });
});

describe("MCP", () => {
  const rpc = (method: string, params?: Record<string, unknown>) => handleMcp({ jsonrpc: "2.0", id: 1, method, params }, user(["ext.demo:publish"]), new Headers(), vi.fn());

  it("lists core's and plugins' tools with JSON Schema and hints", async () => {
    mocks.pluginTools = [{ source: "plugin:demo", value: pluginTool() }];
    const { result } = (await rpc("tools/list")) as { result: { tools: Array<{ name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }> } };
    const byName = new Map(result.tools.map((tool) => [tool.name, tool]));
    expect([...byName.keys()]).toEqual(expect.arrayContaining([...CORE_TOOL_NAMES, "demo_publish"]));
    expect(byName.get("demo_publish")).toMatchObject({ inputSchema: { type: "object" }, annotations: { readOnlyHint: false } });
    expect(byName.get("list_records")?.annotations.readOnlyHint).toBe(true);
    expect(JSON.stringify(result)).not.toContain("$schema");
  });

  it("returns a tool's error as a tool result", async () => {
    const { result } = (await rpc("tools/call", { name: "nope", arguments: {} })) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe("UNKNOWN_TOOL");
  });
});

describe("Markdown to rich text", () => {
  it("covers what rich text holds, and passes its validation", () => {
    const doc = markdownToRichText("# Title\n\nA *line* with `code` and a [link](https://example.com).\n\n- one\n- two\n\n1. first\n\n> quoted\n\n```\nconst a = 1;\n```\n\n---");
    expect(richTextProblem(doc)).toBeNull();
    expect(doc.content?.map((node) => node.type)).toEqual(["heading", "paragraph", "bulletList", "orderedList", "blockquote", "codeBlock", "horizontalRule"]);
  });

  it("keeps an unsafe link as plain text", () => {
    const doc = markdownToRichText("[click](javascript:alert(1))");
    expect(richTextProblem(doc)).toBeNull();
    expect(JSON.stringify(doc)).not.toContain("javascript");
  });

  it("gives an empty document for empty text", () => {
    expect(markdownToRichText("")).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
  });
});
