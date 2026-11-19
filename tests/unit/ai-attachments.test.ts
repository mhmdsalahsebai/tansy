import { describe, expect, it, vi } from "vitest";
import { MockImageModelV4, MockLanguageModelV4 } from "ai/test";
import type { ExtensionRoute, ExtensionRouteContext, PluginStore } from "@/core/extend/define";
import { ai } from "../../plugins/ai/index";
import { attachmentIdOf, attachmentIds, attachmentStore } from "../../plugins/ai/attachments";
import { chatStore } from "../../plugins/ai/chats";
import { acceptedTypes, attachmentType, readsMedia } from "../../plugins/ai/media";
import { defineAiProvider, type ModelChoice } from "../../plugins/ai/provider";

function memoryStore(): PluginStore & { keys(): string[] } {
  const rows = new Map<string, unknown>();
  return {
    keys: () => [...rows.keys()],
    get: async (key) => rows.get(key) ?? null,
    set: async (key, value) => { rows.set(key, JSON.parse(JSON.stringify(value))); },
    claim: async (key, value) => (rows.has(key) ? false : (rows.set(key, value), true)),
    delete: async (key) => { rows.delete(key); },
    list: async (prefix = "") => [...rows].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value })),
    deleteMany: async (prefix: string) => { const gone = [...rows.keys()].filter((key) => key.startsWith(prefix)); gone.forEach((key) => rows.delete(key)); return gone.length; },
  };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

describe("what the chat lets people attach", () => {
  it("takes pictures, PDFs, text, sound and video, never SVG or HTML", () => {
    expect(attachmentType("image/png")).toBe("image/png");
    expect(attachmentType("image/jpeg; charset=binary")).toBe("image/jpeg");
    expect(attachmentType("", "notes.md")).toBe("text/markdown");
    expect(attachmentType("audio/mp3")).toBe("audio/mpeg");
    expect(attachmentType("image/svg+xml", "logo.svg")).toBeNull();
    expect(attachmentType("text/html", "page.html")).toBeNull();
  });

  it("offers a model only what it reads", () => {
    expect(acceptedTypes({ input: ["text"], output: ["text"], reported: true })).toEqual(["text/plain", "text/markdown", "text/csv", "application/json"]);
    expect(readsMedia({ input: ["text"], output: ["text"], reported: true })).toBe(false);
    // A provider that says it sees pictures, but not PDFs, gets no PDFs.
    expect(acceptedTypes({ input: ["text", "image"], reported: true })).not.toContain("application/pdf");
    // A model known only by its name that sees pictures usually reads PDFs too.
    expect(acceptedTypes({ input: ["text", "image"] })).toContain("application/pdf");
    expect(acceptedTypes({ input: ["text", "audio", "video"], reported: true })).toEqual(expect.arrayContaining(["audio/mpeg", "video/mp4"]));
  });

  it("names only its own addresses as attachments", () => {
    expect(attachmentIdOf("/api/ext/ai/attachments/abcdefghij0123456789")).toBe("abcdefghij0123456789");
    expect(attachmentIdOf("https://evil.example/api/ext/ai/attachments/abcdefghij0123456789")).toBeNull();
    expect(attachmentIdOf("data:image/png;base64,AAAA")).toBeNull();
    expect(attachmentIdOf("/api/ext/ai/attachments/abcdefghij0123456789?x=1")).toBeNull();
  });
});

describe("kept attachments", () => {
  it("belong to one person, and come back whole from many pieces", async () => {
    const store = memoryStore();
    const files = attachmentStore(store);
    const data = new Uint8Array(500 * 1024).map((_, index) => index % 251);
    const id = await files.put("alice", { data, mediaType: "application/pdf", name: "deck.pdf" });
    expect(store.keys().filter((key) => key.startsWith("att/")).length).toBeGreaterThan(1);
    expect(store.keys().every((key) => !key.includes("alice"))).toBe(true);
    const back = await files.get("alice", id);
    expect(back?.mediaType).toBe("application/pdf");
    expect(Buffer.compare(back!.data, Buffer.from(data))).toBe(0);
    expect(await files.get("bob", id)).toBeNull();
    await files.remove("bob", id);
    expect(await files.get("alice", id)).not.toBeNull();
    await files.remove("alice", id);
    expect(store.keys()).toEqual([]);
  });

  it("go when the chat they're in is deleted", async () => {
    const store = memoryStore();
    const id = await attachmentStore(store).put("alice", { data: PNG, mediaType: "image/png", name: "a.png" });
    const url = `/api/ext/ai/attachments/${id}`;
    expect(attachmentIds([{ parts: [{ type: "file", url }] }])).toEqual([id]);
    const chats = chatStore(store);
    await chats.save("alice", "c1", [{ id: "1", role: "user", parts: [{ type: "file", mediaType: "image/png", url }] }]);
    await chats.remove("alice", "c1");
    expect(store.keys()).toEqual([]);
  });
});

function routes(options: { models?: ModelChoice[]; language?: MockLanguageModelV4; image?: MockImageModelV4 } = {}) {
  const mock = defineAiProvider({
    id: "mock",
    label: "Mock",
    defaultModel: "m",
    settings: () => [],
    ready: () => true,
    model: () => (options.language ?? new MockLanguageModelV4()) as never,
    imageModel: (_settings, id) => (id === "painter" ? options.image as never : undefined),
    ...(options.models ? { models: async () => options.models! } : {}),
  });
  const plugin = ai({ providers: [mock] });
  return (method: string, path: string) => plugin.routes!.find((route) => route.method === method && route.path === path) as ExtensionRoute;
}

const person = (id: string) => ({ kind: "user", user: { id, name: id, email: `${id}@example.com` }, permissions: new Set() });

async function upload(store: PluginStore, body: BodyInit, type: string, name: string, user = "alice") {
  const auditTarget = vi.fn();
  const result = await routes()("POST", "/attachments").handler({
    request: new Request("http://localhost/api/ext/ai/attachments", { method: "POST", headers: { "content-type": type }, body }),
    principal: person(user),
    query: { name },
    store,
    auditTarget,
  } as unknown as ExtensionRouteContext);
  return { result: result as { id: string; url: string } | Response, auditTarget };
}

describe("attaching a file", () => {
  it("keeps it for its owner, and serves it back to them alone, never as a page", async () => {
    const store = memoryStore();
    const { result, auditTarget } = await upload(store, PNG, "image/png", "cat <1>.png");
    expect(result).not.toBeInstanceOf(Response);
    const { id, url } = result as { id: string; url: string };
    expect(url).toMatch(/\/ext\/ai\/attachments\/[a-z0-9]{20}$/);
    expect(auditTarget).toHaveBeenCalledWith("ai-attachment", id, { mediaType: "image/png", bytes: PNG.byteLength });
    const read = (user: string) => routes()("GET", "/attachments/:id").handler({ principal: person(user), params: { id }, store } as unknown as ExtensionRouteContext) as Promise<Response>;
    const mine = await read("alice");
    expect(mine.status).toBe(200);
    expect(mine.headers.get("content-type")).toBe("image/png");
    expect(mine.headers.get("x-content-type-options")).toBe("nosniff");
    expect(mine.headers.get("content-security-policy")).toContain("sandbox");
    expect((await read("bob")).status).toBe(404);
  });

  it("refuses what can't be attached, and what's too large", async () => {
    const store = memoryStore();
    expect(((await upload(store, "<svg onload=alert(1)>", "image/svg+xml", "x.svg")).result as Response).status).toBe(415);
    expect(((await upload(store, new Uint8Array(9 * 1024 * 1024), "application/pdf", "big.pdf")).result as Response).status).toBe(413);
    expect(store.keys()).toEqual([]);
  });
});

describe("files in the chat", () => {
  function answering() {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(options.prompt);
        const parts = [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Seen." }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }];
        return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) } as never;
      },
    });
    return { model, prompts };
  }

  async function chat(store: PluginStore, parts: unknown[], options: { models?: ModelChoice[]; settings?: Record<string, unknown> } = {}) {
    const { model, prompts } = answering();
    const response = await routes({ language: model, models: options.models })("POST", "/chat").handler({
      request: new Request("http://localhost/api/ext/ai/chat", { method: "POST" }),
      principal: person("alice"),
      body: { messages: [{ id: "m1", role: "user", parts }] },
      settings: { get: async () => ({ provider: "mock", model: "eyes", fastModel: "", instructions: "", maxSteps: 5, maxOutputTokens: 1000, ...options.settings }) },
      tools: { withRole: async () => ({ list: async () => [], call: vi.fn() }) },
      store,
      auditTarget: vi.fn(),
    } as unknown as ExtensionRouteContext) as Response;
    return { response, text: await response.text(), prompts };
  }

  it("sends the person's own pictures to the model, read from the store", async () => {
    const store = memoryStore();
    const id = await attachmentStore(store).put("alice", { data: PNG, mediaType: "image/png", name: "cat.png" });
    const { response, prompts } = await chat(store, [{ type: "text", text: "What is this?" }, { type: "file", mediaType: "image/png", filename: "cat.png", url: `/api/ext/ai/attachments/${id}` }], { models: [{ value: "eyes", capabilities: { input: ["text", "image"], output: ["text"], tools: true, reported: true } }] });
    expect(response.status).toBe(200);
    const sent = JSON.stringify(prompts[0]);
    expect(sent).toContain("image/png");
    expect(sent).toContain("What is this?");
  });

  it("gives any model a text file as text", async () => {
    const store = memoryStore();
    const id = await attachmentStore(store).put("alice", { data: new TextEncoder().encode("name,price\nmug,12"), mediaType: "text/csv", name: "prices.csv" });
    const { prompts } = await chat(store, [{ type: "file", mediaType: "text/csv", url: `/api/ext/ai/attachments/${id}` }], { settings: { model: "reader" }, models: [{ value: "reader", capabilities: { input: ["text"], output: ["text"], tools: true, reported: true } }] });
    expect(JSON.stringify(prompts[0])).toContain("mug,12");
  });

  it("refuses a picture for a model its provider says can't see", async () => {
    const store = memoryStore();
    const id = await attachmentStore(store).put("alice", { data: PNG, mediaType: "image/png", name: "cat.png" });
    // Its own model id: providers' lists are cached by their settings.
    const { response, prompts } = await chat(store, [{ type: "file", mediaType: "image/png", url: `/api/ext/ai/attachments/${id}` }], { settings: { model: "blind" }, models: [{ value: "blind", capabilities: { input: ["text"], output: ["text"], tools: true, reported: true } }] });
    expect(response.status).toBe(400);
    expect(prompts).toEqual([]);
  });

  it("never fetches an address a request names, or someone else's file", async () => {
    const store = memoryStore();
    const bobs = await attachmentStore(store).put("bob", { data: PNG, mediaType: "image/png", name: "bob.png" });
    const outside = await chat(store, [{ type: "file", mediaType: "image/png", url: "http://169.254.169.254/latest/meta-data" }]);
    expect(outside.response.status).toBe(400);
    expect(outside.prompts).toEqual([]);
    const other = await chat(store, [{ type: "text", text: "Hi" }, { type: "file", mediaType: "image/png", url: `/api/ext/ai/attachments/${bobs}` }]);
    expect(JSON.stringify(other.prompts[0])).not.toContain("image/png\",\"data");
    expect(JSON.stringify(other.prompts[0])).toContain("no longer kept");
  });
});

describe("drawing in the chat", () => {
  function drawingModel() {
    let call = 0;
    return new MockLanguageModelV4({
      doStream: async () => {
        call++;
        const parts = call === 1
          ? [{ type: "stream-start", warnings: [] }, { type: "tool-call", toolCallId: "c1", toolName: "generate_image", input: JSON.stringify({ prompt: "A red fox at dawn", aspectRatio: "16:9" }) }, { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage }]
          : [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Here it is." }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }];
        return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) } as never;
      },
    });
  }

  async function draw(settings: Record<string, unknown>) {
    const store = memoryStore();
    const image = new MockImageModelV4({ doGenerate: async () => ({ images: [Buffer.from(PNG).toString("base64")], warnings: [], response: { timestamp: new Date(), modelId: "painter", headers: undefined } }) as never });
    const generate = vi.spyOn(image, "doGenerate");
    const response = await routes({ language: drawingModel(), image })("POST", "/chat").handler({
      request: new Request("http://localhost/api/ext/ai/chat", { method: "POST" }),
      principal: person("alice"),
      body: { messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Draw a fox" }] }] },
      settings: { get: async () => ({ provider: "mock", model: "m", fastModel: "", instructions: "", maxSteps: 5, maxOutputTokens: 1000, ...settings }) },
      tools: { withRole: async () => ({ list: async () => [], call: vi.fn() }) },
      store,
      auditTarget: vi.fn(),
    } as unknown as ExtensionRouteContext) as Response;
    return { text: await response.text(), store, generate };
  }

  it("draws with the model the settings choose, and keeps the picture for the person", async () => {
    const { text, store, generate } = await draw({ imageProvider: "same", imageModel: "painter" });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: "A red fox at dawn", aspectRatio: "16:9" }));
    expect(text).toMatch(/\/ext\/ai\/attachments\/[a-z0-9]{20}/);
    const id = /\/ext\/ai\/attachments\/([a-z0-9]{20})/.exec(text)![1];
    expect((await attachmentStore(store).get("alice", id))?.mediaType).toBe("image/png");
  });

  it("doesn't draw when no model for pictures is chosen", async () => {
    const { text, generate } = await draw({});
    expect(generate).not.toHaveBeenCalled();
    expect(text).not.toMatch(/\/ext\/ai\/attachments\//);
  });
});
