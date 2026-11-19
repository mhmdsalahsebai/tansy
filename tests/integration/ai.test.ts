/**
 * Agent tools over MCP, and the AI plugin, installed the way a site owner would. The model
 * is a fake OpenAI-compatible server in this process, reached through the
 * @tansy/ai-openai-compatible adapter, so every request runs through the real routes,
 * the AI SDK and the tools, with nothing mocked inside the CMS.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const base = inject("baseUrl");
const PASSWORD = "correct-horse-battery-staple-9431";

interface Actor { id: string; cookie: string; email: string }
let root: Actor, member: Actor;

async function call(path: string, { method = "GET", body, as, headers = {} }: { method?: string; body?: unknown; as?: Actor | null; headers?: Record<string, string> } = {}) {
  const response = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: { origin: base, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(as ? { cookie: as.cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any -- API responses have many shapes
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json, text, headers: response.headers };
}

async function signIn(email: string): Promise<Actor> {
  const r = await call("/api/auth/sign-in/email", { method: "POST", body: { email, password: PASSWORD } });
  expect(r.status, r.text).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).filter((pair) => !pair.endsWith("=")).join("; ");
  return { id: r.json.user.id, cookie, email };
}

/** What the fake model answers next, one entry per request, and every request it got. */
const script: Array<{ text?: string; toolCall?: { name: string; arguments: Record<string, unknown> } }> = [];
const received: Array<Record<string, unknown>> = [];

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

const fake = http.createServer((request, response) => {
  let raw = "";
  request.on("data", (part) => (raw += part));
  request.on("end", () => {
    const body = JSON.parse(raw || "{}") as Record<string, unknown>;
    received.push(body);
    const next = script.shift() ?? { text: "Okay." };
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (next.toolCall) {
        response.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: next.toolCall.name, arguments: JSON.stringify(next.toolCall.arguments) } }] }));
        response.write(chunk({}, "tool_calls"));
      } else {
        response.write(chunk({ role: "assistant", content: next.text ?? "" }));
        response.write(chunk({}, "stop"));
      }
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "c1", object: "chat.completion", created: 0, model: "fake", choices: [{ index: 0, message: { role: "assistant", content: next.text ?? "" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
});

const SETTINGS = "/api/extensions/ai/settings";

async function saveSettings(changes: Record<string, unknown>) {
  const current = await call(SETTINGS, { as: root });
  expect(current.status, current.text).toBe(200);
  const saved = await call(SETTINGS, { method: "PUT", as: root, body: { values: { ...current.json.values, ...changes } } });
  expect(saved.status, saved.text).toBe(200);
}

const rpc = async (as: Actor, method: string, params?: unknown) => (await call("/api/mcp", { method: "POST", as, body: { jsonrpc: "2.0", id: 1, method, params } })).json;
const tool = async (as: Actor, name: string, args: unknown) => (await rpc(as, "tools/call", { name, arguments: args })).result;

beforeAll(async () => {
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  root = await signIn("root@example.test");
  const made = await call("/api/users", { method: "POST", as: root, body: { name: "aimember", email: "aimember@example.test", password: PASSWORD, role: "user" } });
  expect(made.status, made.text).toBe(200);
  member = await signIn("aimember@example.test");
});

afterAll(() => new Promise<void>((resolve) => fake.close(() => resolve())));

describe("agent tools over MCP", () => {
  it("lists plugins' tools beside core's, each with a JSON Schema", async () => {
    const { tools } = (await rpc(root, "tools/list")).result as { tools: Array<{ name: string; inputSchema: { type: string } }> };
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["describe_collection", "create_record", "lms_create_course", "lms_outline", "shop_create_product"]));
    expect(tools.every((t) => t.inputSchema.type === "object")).toBe(true);
  });

  it("creates a whole course as drafts, with Markdown turned into lesson blocks", async () => {
    const result = await tool(root, "lms_create_course", { title: "Git by agent", summary: "Version control.", sections: [{ title: "Start", lessons: [{ title: "Install", content: "Run **git --version**." }, { title: "Configure" }] }] });
    expect(result.isError, result.content[0].text).toBeUndefined();
    const made = JSON.parse(result.content[0].text);
    expect(made).toMatchObject({ sections: 1, lessons: 2 });
    const outline = JSON.parse((await tool(root, "lms_outline", { course: made.course.id })).content[0].text);
    expect(outline.course.status).toBe("draft");
    expect(outline.sections[0].lessons.map((l: { title: string }) => l.title)).toEqual(["Install", "Configure"]);
    const lesson = await call(`/api/collections/lms-lessons/records/${outline.sections[0].lessons[0].id}`, { as: root });
    expect(lesson.json.content[0]).toMatchObject({ type: "lms_text", v: expect.any(Number) });
    expect(JSON.stringify(lesson.json.content[0].value.body)).toContain("bold");
  });

  it("acts only with the caller's access", async () => {
    const refused = await tool(member, "lms_create_course", { title: "Not mine", sections: [] });
    expect(refused.isError).toBe(true);
    expect((await call("/api/collections/lms-courses/records?filter=" + encodeURIComponent('title = "Not mine"'), { as: root })).json.totalItems).toBe(0);
    const hidden = await tool(member, "describe_collection", { collection: "email-messages" });
    expect(hidden.isError).toBe(true);
    expect(JSON.parse(hidden.content[0].text).code).toBe("NOT_FOUND");
  });
});

describe("ai plugin", () => {
  it("is closed to anyone without the permission, and to API keys", async () => {
    expect((await call("/api/ext/ai/status")).status).toBe(401);
    expect((await call("/api/ext/ai/status", { as: member })).status).toBe(403);
    expect((await call("/api/ext/ai/write", { method: "POST", as: member, body: { collection: "lms-courses", field: "title", action: "write", values: {} } })).status).toBe(403);
    expect((await call("/api/ext/ai/status", { headers: { "x-api-key": "cms_not_a_key" } })).status).toBe(401);
  });

  it("answers 503 until a provider is set up", async () => {
    await saveSettings({ provider: "compatible", compatibleBaseUrl: "" });
    expect((await call("/api/ext/ai/status", { as: root })).json).toEqual({ ready: false });
    const r = await call("/api/ext/ai/write", { method: "POST", as: root, body: { collection: "lms-courses", field: "title", action: "write", values: {} } });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("AI_NOT_SET_UP");
  });

  it("writes one field, and saves nothing", async () => {
    await saveSettings({ provider: "compatible", compatibleBaseUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`, model: "fake-model" });
    expect((await call("/api/ext/ai/status", { as: root })).json).toMatchObject({ ready: true, model: "fake-model" });
    script.push({ text: "A friendly start to Git" });
    const r = await call("/api/ext/ai/write", { method: "POST", as: root, body: { collection: "lms-courses", field: "summary", action: "improve", value: "git intro", values: { title: "Git" } } });
    expect(r.status, r.text).toBe(200);
    expect(r.json.value).toBe("A friendly start to Git");
    expect(JSON.stringify(received.at(-1))).toContain("git intro");
  });

  it("fills a form from a prompt with only fields it may fill", async () => {
    script.push({ text: JSON.stringify({ title: "Docker basics", summary: "Containers, simply.", level: "beginner", byline: "Should be ignored?", cover: "not-a-file" }) });
    const r = await call("/api/ext/ai/fill", { method: "POST", as: root, body: { collection: "lms-courses", prompt: "A beginner course on Docker" } });
    expect(r.status, r.text).toBe(200);
    expect(r.json.values).toMatchObject({ title: "Docker basics", summary: "Containers, simply.", level: "beginner" });
    expect(r.json.values).not.toHaveProperty("cover");
  });

  it("asks before a write in chat, and runs nothing until approved", async () => {
    const before = (await call("/api/collections/lms-courses/records?perPage=1", { as: root })).json.totalItems;
    script.push({ toolCall: { name: "create_record", arguments: { collection: "lms-courses", data: { title: "From chat" } } } });
    const r = await call("/api/ext/ai/chat", { method: "POST", as: root, body: { messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Make a course called From chat" }] }] } });
    expect(r.status, r.text).toBe(200);
    expect(r.text).toContain("tool-approval-request");
    expect((await call("/api/collections/lms-courses/records?perPage=1", { as: root })).json.totalItems).toBe(before);
  });

  it("runs reads in chat straight away and answers", async () => {
    script.push({ toolCall: { name: "list_collections", arguments: {} } }, { text: "You have courses." });
    const r = await call("/api/ext/ai/chat", { method: "POST", as: root, body: { messages: [{ id: "m2", role: "user", parts: [{ type: "text", text: "What do I have?" }] }] } });
    expect(r.status, r.text).toBe(200);
    expect(r.text).toContain("You have courses.");
    expect(r.text).not.toContain("tool-approval-request");
  });
});
