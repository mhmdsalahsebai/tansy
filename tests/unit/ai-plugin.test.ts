import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { ExtensionRoute, ExtensionRouteContext, ToolInfo } from "@/core/extend/define";
import { assertPluginManifest } from "@/core/extend/manifest";
import { richTextProblem } from "@/core/fields/rich-text";
import { fieldSchema } from "@/core/schema/describe";
import { withinRole } from "@/core/authz/roles";
import { ai } from "../../plugins/ai/index";
import { ASSISTANT_ROLE, assistantRole, GIVE_ROLE } from "../../plugins/ai/role";
import { fillSchema, fillValues, forModel, systemPrompt, textOf, writePrompt, type DescribedField } from "../../plugins/ai/logic";
import { defineAiProvider, type AiSettings } from "../../plugins/ai/provider";
import { anthropic } from "../../plugins/ai-anthropic/index";
import { deepseek } from "../../plugins/ai-deepseek/index";
import { gateway } from "../../plugins/ai-gateway/index";
import { google } from "../../plugins/ai-google/index";
import { groq } from "../../plugins/ai-groq/index";
import { mistral } from "../../plugins/ai-mistral/index";
import { openai } from "../../plugins/ai-openai/index";
import { openaiCompatible } from "../../plugins/ai-openai-compatible/index";
import { commandcode } from "../../plugins/ai-commandcode/index";
import { opencode } from "../../plugins/ai-opencode/index";
import { openrouter } from "../../plugins/ai-openrouter/index";
import { xai } from "../../plugins/ai-xai/index";
import { lmsTools } from "../../plugins/lms/tools";
import { shopTools } from "../../plugins/shop/tools";

const ADAPTERS = [openai(), anthropic(), google(), gateway(), mistral(), xai(), groq(), deepseek(), openrouter(), opencode(), commandcode(), openaiCompatible()];

const FIELDS: DescribedField[] = [
  { name: "title", type: "text", label: "Title", schema: { type: "string", maxLength: 200 } },
  { name: "body", type: "rich_text", schema: { type: "object" } },
  { name: "level", type: "radio", schema: { type: "string", enum: ["beginner", "advanced"] } },
  { name: "cover", type: "image", schema: { type: "string" } },
  { name: "course", type: "reference", schema: { type: "integer" } },
  { name: "code", type: "text", readonly: true, schema: { type: "string" } },
  { name: "price", type: "payments_price", schema: { type: "number" } },
];

describe("filling and writing", () => {
  it("asks only for fields a model can fill, with rich text as Markdown", () => {
    const schema = fillSchema(FIELDS);
    expect(Object.keys(schema.properties)).toEqual(["title", "body", "level"]);
    expect(schema.properties.body).toMatchObject({ type: "string", description: "Markdown" });
    expect(schema.properties.title).toMatchObject({ maxLength: 200, description: "Title" });
  });

  it("keeps only fillable fields from the answer, and turns Markdown into rich text", () => {
    const values = fillValues(FIELDS, { title: "Git basics", body: "## Why\n\nBecause.", code: "HACK", cover: "f1", course: 3, nope: 1, level: "" });
    expect(Object.keys(values)).toEqual(["title", "body"]);
    expect(richTextProblem(values.body)).toBeNull();
  });

  it("tells the model a choice field's values, and drops an answer off the list", () => {
    const radio = fieldSchema({ type: "radio", config: { options: [{ label: "Beginner", value: "beginner" }, { label: "Advanced", value: "advanced" }, { label: "Old", value: "old", disabled: true }] } });
    expect(radio).toMatchObject({ type: "string", enum: ["beginner", "advanced"] });
    const tags = fieldSchema({ type: "checkbox", config: { options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] } });
    expect(tags).toMatchObject({ type: "array", items: { enum: ["a", "b"] } });
    const fields: DescribedField[] = [{ name: "level", type: "radio", schema: radio }, { name: "tags", type: "checkbox", schema: tags }];
    expect(fillValues(fields, { level: "Expert", tags: ["a", "z"] })).toEqual({ tags: ["a"] });
    expect(fillValues(fields, { level: "advanced", tags: ["z"] })).toEqual({ level: "advanced" });
    const typed: DescribedField[] = [{ name: "preview", type: "boolean", schema: { type: "boolean" } }, { name: "minutes", type: "number", schema: { type: "number" } }];
    expect(fillValues(typed, { preview: "false", minutes: "45" })).toEqual({ preview: false, minutes: 45 });
    expect(fillValues(typed, { preview: "maybe", minutes: "soon" })).toEqual({});
  });

  it("reads rich text back as Markdown for the model", () => {
    expect(textOf({ type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Hi" }] }, { type: "paragraph", content: [{ type: "text", text: "bold", marks: [{ type: "bold" }] }] }] })).toBe("## Hi\n\n**bold**");
  });

  it("tells the model about the field and its limit", () => {
    const prompt = writePrompt({ action: "shorten", field: FIELDS[0], value: "A long title", record: { summary: "About git" }, collection: "Courses" });
    expect(prompt).toContain("under 200 characters");
    expect(prompt).toContain("summary: About git");
    expect(prompt).toContain("Current text:\nA long title");
  });

  it("cuts long tool results short", () => {
    const big = { items: Array.from({ length: 5000 }, (_, id) => ({ id, title: "x".repeat(20) })) };
    expect(forModel(big, 1000)).toMatchObject({ truncated: true });
    expect(forModel({ id: 1 })).toEqual({ id: 1 });
  });

  it("tells the assistant that record text is data, and puts the site's guidance last", () => {
    const prompt = systemPrompt({ userName: "Edie", instructions: "Write in British English." });
    expect(prompt).toMatch(/data, not instructions/);
    expect(prompt.trim().endsWith("Write in British English.")).toBe(true);
  });
});

describe("the plugin", () => {
  it("passes the manifest checks with every adapter", () => {
    expect(() => assertPluginManifest(ai({ providers: ADAPTERS }))).not.toThrow();
  });

  it("keeps each adapter's settings under its own name, keys as secrets", () => {
    for (const adapter of ADAPTERS) {
      for (const field of adapter.settings()) expect(field.name.startsWith(adapter.id)).toBe(true);
      expect(adapter.settings().some((field) => field.type === "secret")).toBe(true);
    }
  });

  it("refuses two adapters with one id, and a default that isn't listed", () => {
    expect(() => ai({ providers: [openai(), openai()] })).toThrow(/listed twice/);
    expect(() => ai({ providers: [openai()], provider: "anthropic" })).toThrow(/isn't one of the providers/);
  });

  it("is ready only with what each provider needs", () => {
    const empty = { provider: "", model: "", fastModel: "", instructions: "", maxSteps: 5, maxOutputTokens: 1000 } as AiSettings;
    expect(openai().ready(empty)).toBe(false);
    expect(openai().ready({ ...empty, openaiApiKey: "sk-test" })).toBe(true);
    expect(openaiCompatible().ready({ ...empty, compatibleBaseUrl: "http://localhost:11434/v1" })).toBe(true);
    expect(openaiCompatible().ready({ ...empty, compatibleBaseUrl: "ftp://nope" })).toBe(false);
  });
});

/** A model that asks for one tool call, then answers in text once it has the result. */
function scriptedModel(toolName: string, input: Record<string, unknown>) {
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      call++;
      const parts = call === 1
        ? [{ type: "stream-start", warnings: [] }, { type: "tool-call", toolCallId: "call-1", toolName, input: JSON.stringify(input) }, { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage }]
        : [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Done." }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }];
      return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) } as never;
    },
  });
}

async function runChat(toolName: string, input: Record<string, unknown>, tools: ToolInfo[], extra: Record<string, unknown> = {}) {
  const model = scriptedModel(toolName, input);
  const mock = defineAiProvider({ id: "mock", label: "Mock", defaultModel: "m", settings: () => [{ name: "mockKey", type: "secret", label: "Key" }], ready: () => true, model: () => model as never });
  const plugin = ai({ providers: [mock] });
  const route = plugin.routes!.find((item) => item.path === "/chat") as ExtensionRoute;
  const call = vi.fn(async () => ({ items: [] }));
  const unscoped = vi.fn(async () => ({ items: [] }));
  // Only the tools narrowed to a role are handed to the model.
  const withRole = vi.fn(async (role: string) => {
    if (role === "gone") throw new Error("There's no role");
    return { list: async () => tools, call };
  });
  const context = {
    request: new Request("http://localhost/api/ext/ai/chat", { method: "POST" }),
    principal: { kind: "user", user: { id: "u1", name: "Edie", email: "edie@example.com" }, permissions: new Set() },
    body: { messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Make a course" }] }] },
    settings: { get: async () => ({ provider: "mock", model: "", fastModel: "", instructions: "", maxSteps: 5, maxOutputTokens: 1000 }) },
    tools: { list: async () => tools, call: unscoped, withRole, roles: async () => [] },
    auditTarget: vi.fn(),
    ...extra,
  } as unknown as ExtensionRouteContext;
  const response = (await route.handler(context)) as Response;
  return { text: await response.text(), status: response.status, call, unscoped, withRole };
}

describe("the assistant", () => {
  const tools: ToolInfo[] = [
    { name: "list_records", description: "List", inputSchema: { type: "object", properties: { collection: { type: "string" } } }, write: false },
    { name: "lms_create_course", description: "Create a course", inputSchema: { type: "object", properties: { title: { type: "string" } } }, write: true },
  ];

  it("asks before a write, and doesn't run it", async () => {
    const { text, call } = await runChat("lms_create_course", { title: "Git" }, tools);
    expect(text).toContain("tool-approval-request");
    expect(call).not.toHaveBeenCalled();
  });

  it("runs a read straight away, as the caller within the AI's role", async () => {
    const { text, call, unscoped, withRole } = await runChat("list_records", { collection: "posts" }, tools);
    expect(withRole).toHaveBeenCalledWith(ASSISTANT_ROLE);
    expect(call).toHaveBeenCalledWith("list_records", { collection: "posts" });
    expect(unscoped).not.toHaveBeenCalled();
    expect(text).not.toContain("tool-approval-request");
    expect(text).toContain("Done.");
  });
});

describe("the AI's role", () => {
  const tools: ToolInfo[] = [{ name: "list_records", description: "List", inputSchema: { type: "object", properties: {} }, write: false }];
  const settings = (more: Record<string, unknown>) => ({ settings: { get: async () => ({ provider: "mock", model: "", fastModel: "", instructions: "", maxSteps: 5, maxOutputTokens: 1000, ...more }) } });
  const body = (more: Record<string, unknown>) => ({ body: { messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] }], ...more } });
  // Giving the AI a role is for whoever may give people roles: admins by default.
  const admin = { principal: { kind: "user", user: { id: "u1", name: "Ada", email: "ada@example.com" }, permissions: new Set([GIVE_ROLE]) } };

  it("is the one the person picks, while the settings let them", async () => {
    const { withRole } = await runChat("list_records", {}, tools, { ...admin, ...body({ role: "editor" }) });
    expect(withRole).toHaveBeenCalledWith("editor");
  });

  it("stays the settings' when people may not choose", async () => {
    const { withRole } = await runChat("list_records", {}, tools, { ...admin, ...settings({ role: "blog-author", chooseRole: false }), ...body({ role: "superadmin" }) });
    expect(withRole).toHaveBeenCalledWith("blog-author");
  });

  it("refuses the chat when the role is gone, rather than acting without one", async () => {
    const { status, call } = await runChat("list_records", {}, tools, { ...admin, ...body({ role: "gone" }) });
    expect(status).toBe(400);
    expect(call).not.toHaveBeenCalled();
  });

  it("can't be chosen by someone who may not give people roles", async () => {
    const { status, call, withRole } = await runChat("list_records", {}, tools, { ...body({ role: "superadmin" }) });
    expect(status).toBe(403);
    expect(withRole).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("is the site's for someone who may not choose, and the status says they can't", async () => {
    const { withRole } = await runChat("list_records", {}, tools, { ...settings({ role: "blog-author" }), ...body({}) });
    expect(withRole).toHaveBeenCalledWith("blog-author");
    const mock = defineAiProvider({ id: "mock", label: "Mock", defaultModel: "m", settings: () => [], ready: () => true, model: () => ({}) as never });
    const routes = ai({ providers: [mock] }).routes as ExtensionRoute[];
    const status = routes.find((item) => item.path === "/status" && item.method === "GET")!;
    const roles = routes.find((item) => item.path === "/roles")!;
    const context = (permissions: string[]) => ({ principal: { kind: "user", user: { id: "u1", name: "E", email: "e@example.com" }, permissions: new Set(permissions) }, ...settings({}), tools: { roles: async () => [{ name: "editor", label: "Editor" }] } }) as unknown as ExtensionRouteContext;
    expect(await status.handler(context(["ext.ai:use"]))).toMatchObject({ chooseRole: false });
    expect(await status.handler(context(["ext.ai:use", GIVE_ROLE]))).toMatchObject({ chooseRole: true });
    expect(((await roles.handler(context(["ext.ai:use"]))) as Response).status).toBe(403);
    expect(await roles.handler(context(["ext.ai:use", GIVE_ROLE]))).toEqual({ options: [{ value: "editor", label: "Editor" }] });
  });

  it("is created safe: no deleting, schemas, users, settings or roles", () => {
    const granted = new Set(assistantRole.permissions);
    for (const permission of granted) expect(permission).not.toMatch(/delete|^user:|^role:|^setting:|^api-key:|^collection:(create|update|manage)/);
    expect(granted.has("record:read")).toBe(true);
  });

  it("narrows what someone holds, and never adds to it", () => {
    expect([...withinRole(new Set(["record:create", "record:delete", "user:list"]), new Set(["record:create@c3", "record:update", "setting:update"]))].sort()).toEqual(["record:create@c3"]);
    expect([...withinRole(new Set(["record:update@c2:own", "locale:edit"]), new Set(["record:update", "locale:edit@ar"]))].sort()).toEqual(["locale:edit@ar", "record:update@c2:own"]);
  });
});

describe("saved chats", () => {
  it("are saved for the caller when the answer ends", async () => {
    const rows = new Map<string, unknown>();
    const store = { get: async (key: string) => rows.get(key) ?? null, set: async (key: string, value: unknown) => { rows.set(key, value); }, delete: async (key: string) => { rows.delete(key); }, list: async (prefix = "") => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) };
    const tools: ToolInfo[] = [{ name: "list_records", description: "List", inputSchema: { type: "object", properties: {} }, write: false }];
    await runChat("list_records", {}, tools, { store, body: { chatId: "chat1", messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Make a course" }] }] } });
    const saved = [...rows].find(([key]) => key.startsWith("chat/"))?.[1] as { title: string; messages: Array<{ role: string }> };
    expect(saved.title).toBe("Make a course");
    expect(saved.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });
});

describe("plugins' tools", () => {
  it("are well-formed", () => {
    expect(() => assertPluginManifest({ name: "lms", version: "1.0.0", apiVersion: 1, tools: lmsTools })).not.toThrow();
    expect(() => assertPluginManifest({ name: "shop", version: "1.0.0", apiVersion: 1, tools: shopTools })).not.toThrow();
  });

  it("create a course through create_record, as drafts in order, keeping only fields the owner kept", async () => {
    const calls: Array<{ collection: string; data: Record<string, unknown> }> = [];
    let id = 10;
    const context = {
      input: { title: "Git", summary: "Basics", level: "beginner", sections: [{ title: "Start", lessons: [{ title: "Install", content: "Run **brew install git**." }, { title: "Config" }] }, { title: "Next", lessons: [] }] },
      schema: { describe: async (slug: string) => ({ slug, fields: ["title", "summary", "course", "section", "position", "content", "description", "status", "preview", "durationMinutes"].map((name) => ({ name, type: "text", config: {} })) }) },
      tools: { call: async (_: string, args: { collection: string; data: Record<string, unknown> }) => { calls.push(args); return { id: id++, ...args.data }; }, list: async () => [] },
    };
    const tool = lmsTools.find((item) => item.name === "lms_create_course")!;
    const result = await tool.handler(context as never);
    expect(result).toMatchObject({ course: { id: 10 }, sections: 2, lessons: 2 });
    expect(calls.map((item) => item.collection)).toEqual(["lms-courses", "lms-sections", "lms-lessons", "lms-lessons", "lms-sections"]);
    expect(calls[0].data).not.toHaveProperty("level");
    expect(calls.every((item) => item.data.status === "draft")).toBe(true);
    expect(calls[3].data).toMatchObject({ course: 10, section: 11, position: 1 });
    expect(calls[2].data.content).toEqual([{ type: "lms_text", value: { body: "Run **brew install git**." } }]);
  });
});

describe("choosing the model and thinking in the chat", () => {
  async function chatWith(settings: Record<string, unknown>, body: Record<string, unknown>) {
    const used: string[] = [];
    const calls: Array<Record<string, unknown>> = [];
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        calls.push(options as unknown as Record<string, unknown>);
        const parts = [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Hi." }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }];
        return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) } as never;
      },
    });
    const mock = defineAiProvider({ id: "mock", label: "Mock", defaultModel: "m", settings: () => [], ready: () => true, model: (_s, id) => { used.push(id); return model as never; } });
    const route = ai({ providers: [mock] }).routes!.find((item) => item.path === "/chat") as ExtensionRoute;
    const auditTarget = vi.fn();
    const context = {
      request: new Request("http://localhost/api/ext/ai/chat", { method: "POST" }),
      principal: { kind: "user", user: { id: "u1", name: "Edie", email: "edie@example.com" }, permissions: new Set() },
      body: { messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hello" }] }], ...body },
      settings: { get: async () => ({ provider: "mock", model: "site-model", fastModel: "", instructions: "", maxSteps: 5, maxOutputTokens: 1000, ...settings }) },
      tools: { list: async () => [], call: vi.fn(), withRole: async () => ({ list: async () => [], call: vi.fn() }) },
      auditTarget,
    } as unknown as ExtensionRouteContext;
    await ((await route.handler(context)) as Response).text();
    return { used, calls, auditTarget };
  }

  it("uses the model the person picked, and audits it with the thinking", async () => {
    const { used, calls, auditTarget } = await chatWith({ chooseModel: true }, { model: "vendor/picked-1", reasoning: "high" });
    expect(used).toEqual(["vendor/picked-1"]);
    expect(calls[0].reasoning).toBe("high");
    expect(auditTarget).toHaveBeenCalledWith("ai", "mock", { model: "vendor/picked-1", role: "ai-assistant", reasoning: "high" });
  });

  it("keeps everyone on the site's model and thinking when choosing is off", async () => {
    const { used, calls } = await chatWith({ chooseModel: false, reasoning: "low" }, { model: "vendor/picked-1", reasoning: "high" });
    expect(used).toEqual(["site-model"]);
    expect(calls[0].reasoning).toBe("low");
  });

  it("leaves thinking to the model by default", async () => {
    const { used, calls } = await chatWith({}, {});
    expect(used).toEqual(["site-model"]);
    expect(calls[0].reasoning).toBeUndefined();
  });

  it("offers no models to choose from when choosing is off", async () => {
    const mock = defineAiProvider({ id: "mock", label: "Mock", defaultModel: "m", settings: () => [], ready: () => true, model: () => null as never, models: async () => [{ value: "a" }] });
    const route = ai({ providers: [mock] }).routes!.find((item) => item.path === "/chat/models") as ExtensionRoute;
    const context = (chooseModel: boolean) => ({ query: {}, settings: { get: async () => ({ provider: "mock", chooseModel }) } }) as unknown as ExtensionRouteContext;
    expect(await route.handler(context(false))).toEqual({ options: [] });
    expect(await route.handler(context(true))).toEqual({ options: [{ value: "a" }] });
  });
});
