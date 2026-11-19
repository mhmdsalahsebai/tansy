import { describe, expect, it, vi } from "vitest";
import { APICallError } from "@ai-sdk/provider";
import { MockImageModelV4, MockLanguageModelV4 } from "ai/test";
import type { ExtensionRoute, ExtensionRouteContext, PluginStore } from "@/core/extend/define";
import { ai } from "../../plugins/ai/index";
import { defineAiProvider, type ModelChoice } from "../../plugins/ai/provider";
import { checkWorkflow, supports, type Catalog } from "../../plugins/ai/workflow/check";
import { commitOrder, createRun, Engine, maxItems, regenerate, retryable, retryFailed, runStore, writeSchema, writeValues, type RunCollection } from "../../plugins/ai/workflow/engine";
import { fill, workflowSchema, type WorkflowInput } from "../../plugins/ai/workflow/schema";
import { modelIconKey } from "../../plugins/ai/workflow/icons";
import { fromTemplate } from "../../plugins/ai/workflow/templates";

/** The plugin store, in memory, with the same claim semantics. */
function memoryStore(): PluginStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  const copy = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
  return {
    data,
    get: async (key) => (data.has(key) ? copy(data.get(key)) : null),
    set: async (key, value) => void data.set(key, copy(value)),
    claim: async (key, value) => (data.has(key) ? false : (data.set(key, copy(value)), true)),
    delete: async (key) => void data.delete(key),
    list: async (prefix = "") => [...data.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value: copy(value) })),
    deleteMany: async (prefix: string) => { const gone = [...data.keys()].filter((key) => key.startsWith(prefix)); gone.forEach((key) => data.delete(key)); return gone.length; },
  };
}

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
const answer = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] });
/** The user's words in a call, as the model reads them. */
const userText = (prompt: Array<{ role: string; content: unknown }>) => prompt.filter((message) => message.role === "user").flatMap((message) => (message.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "")).join("\n");

const COLLECTIONS: Record<string, RunCollection> = {
  courses: { slug: "courses", name: "Courses", fields: [{ name: "title", type: "text", schema: { type: "string" } }, { name: "summary", type: "text", schema: { type: "string" } }, { name: "cover", type: "image", schema: { type: "string" } }] },
  sections: { slug: "sections", name: "Sections", fields: [{ name: "title", type: "text", schema: { type: "string" } }, { name: "course", type: "reference", schema: { type: "integer" } }, { name: "position", type: "number", schema: { type: "number" } }] },
  lessons: {
    slug: "lessons",
    name: "Lessons",
    fields: [
      { name: "title", type: "text", schema: { type: "string" } },
      { name: "content", type: "stream", schema: { type: "array" }, blocks: [{ name: "lms_text", fields: [{ name: "body", type: "rich_text" }] }] },
      { name: "course", type: "reference", schema: { type: "integer" } },
      { name: "section", type: "reference", schema: { type: "integer" } },
      { name: "position", type: "number", schema: { type: "number" } },
    ],
  },
};

const COURSE: WorkflowInput = {
  id: "course",
  name: "Course",
  brief: "A course about {{topic}}.",
  inputs: [{ name: "topic", label: "Topic" }],
  agents: [
    { id: "lead", name: "Lead", provider: "mock", model: "planner" },
    { id: "w1", name: "Writer one", provider: "mock", model: "writer-1" },
    { id: "w2", name: "Writer two", provider: "mock", model: "writer-2" },
    { id: "judge", name: "Judge", provider: "mock", model: "judge" },
    { id: "artist", name: "Artist", provider: "mock", model: "painter" },
  ],
  planner: { agent: "lead" },
  steps: [
    { id: "course", name: "Course", collection: "courses", count: { min: 1, max: 1 }, writers: ["w1"], images: [{ field: "cover", artists: ["artist"] }] },
    { id: "sections", name: "Sections", collection: "sections", parent: "course", link: "course", orderField: "position", count: { min: 2, max: 2 }, writers: ["w1"] },
    { id: "lessons", name: "Lessons", collection: "lessons", parent: "sections", link: "section", links: [{ field: "course", step: "course" }], orderField: "position", count: { min: 2, max: 3 }, writers: ["w1", "w2"], strategy: "rotate", judge: { agent: "judge", criteria: "", minScore: 8, revisions: 1 } },
  ],
  retry: { attempts: 3, backoffSeconds: 1 },
};

/** A provider whose models answer by the duty their system prompt names. */
function mockProvider(options: { failFirstWrite?: boolean; writerOneBroken?: boolean } = {}) {
  const calls: Array<{ model: string; system: string }> = [];
  let judged = 0;
  let failed = false;
  const language = (id: string) => new MockLanguageModelV4({
    modelId: id,
    doGenerate: async (call) => {
      const text = userText(call.prompt as never);
      const system = (call.prompt.find((message) => message.role === "system")?.content as string | undefined) ?? "";
      calls.push({ model: id, system });
      if (system.includes("You lead the team")) return answer({ guide: "Plain English.", steps: [{ step: "lessons", rubric: "1. Correct.", prompts: [{ agent: "w1", prompt: "Write warmly." }, { agent: "w2", prompt: "Write tersely." }, { agent: "nobody", prompt: "x" }] }] });
      if (system.includes("Right now you outline")) {
        return answer({ items: text.includes("Lessons record") ? [{ title: "Lesson A", brief: "a" }, { title: "Lesson B", brief: "b" }] : [{ title: "Section 1", brief: "one" }, { title: "Section 2", brief: "two" }] });
      }
      if (system.includes("Right now you judge")) {
        judged++;
        // The first lesson judged scores low once, so it goes back with notes.
        return answer({ score: judged === 1 ? 6 : 9, feedback: judged === 1 ? "Add an example." : "Good." });
      }
      if (system.includes("Right now you write")) {
        if (options.writerOneBroken && id === "writer-1") throw new APICallError({ message: "Unauthorized", url: "https://x.test", requestBodyValues: {}, statusCode: 401, isRetryable: false });
        if (options.failFirstWrite && !failed) {
          failed = true;
          throw new APICallError({ message: "Overloaded", url: "https://x.test", requestBodyValues: {}, statusCode: 503, isRetryable: true });
        }
        const title = /record "([^"]+)"/.exec(text)?.[1] ?? "Untitled";
        const schema = JSON.stringify(call.responseFormat);
        return answer({ title: `${title} (by ${id})`, ...(schema.includes("summary") ? { summary: "Learn it." } : {}), ...(schema.includes("content") ? { content: "## Hello\n\nAn example." } : {}) });
      }
      throw new Error(`unexpected call: ${system.slice(0, 80)}`);
    },
  });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");
  const provider = defineAiProvider({
    id: "mock",
    label: "Mock",
    defaultModel: "writer-1",
    settings: () => [],
    ready: () => true,
    model: (_settings, id) => language(id),
    imageModel: (_settings, id) => (id === "painter" ? new MockImageModelV4({ doGenerate: async () => ({ images: [png], warnings: [], response: { timestamp: new Date(), modelId: id, headers: undefined } }) }) : undefined),
    models: async () => [
      { value: "planner", capabilities: { output: ["text"], structured: true, reported: true } },
      { value: "writer-1", capabilities: { output: ["text"], structured: true, reported: true } },
      { value: "writer-2", capabilities: { output: ["text"], structured: true, reported: true } },
      { value: "judge", capabilities: { output: ["text"], reported: true } },
      { value: "painter", capabilities: { output: ["image"], reported: true } },
    ] satisfies ModelChoice[],
  });
  return { provider, calls };
}

const SETTINGS = { provider: "mock", model: "", fastModel: "", chooseModel: true, reasoning: "provider-default", instructions: "Be kind.", maxSteps: 5, maxOutputTokens: 1000 };

async function runCourse(options: Parameters<typeof mockProvider>[0] = {}) {
  const { provider, calls } = mockProvider(options);
  const store = memoryStore();
  const workflow = workflowSchema.parse(COURSE);
  const run = createRun({ workflow, inputs: { topic: "Git" }, collections: COLLECTIONS, user: { id: "u1", name: "Edie" } });
  const runs = runStore(store);
  await runs.save(run);
  const engine = new Engine({ store, settings: async () => SETTINGS, providers: [provider], sleep: async () => {} });
  await engine.drive(run.id);
  return { store, runs, run: (await runs.get(run.id))!, calls, provider };
}

describe("a workflow's shape", () => {
  it("fills inputs into prompts and leaves unknown names", () => {
    expect(fill("About {{ topic }} for {{who}}", { topic: "Git" })).toBe("About Git for {{who}}");
  });

  it("refuses parents after their children, writers off the team, competing without a judge, and links outside the parents", () => {
    const bad = workflowSchema.safeParse({
      ...COURSE,
      steps: [
        { id: "a", name: "A", collection: "x", parent: "b", link: "x", count: { min: 1, max: 1 }, writers: ["ghost"] },
        { id: "b", name: "B", collection: "y", count: { min: 1, max: 2 }, writers: ["w1", "w2"], strategy: "compete", links: [{ field: "z", step: "a" }] },
      ],
    });
    expect(bad.success).toBe(false);
    const messages = bad.error!.issues.map((issue) => issue.message);
    expect(messages).toEqual(expect.arrayContaining(["A step's parent must come before it.", "\"ghost\" isn't on the team.", "Writers that compete need a judge to choose between them.", "Link only to a step this one is under."]));
  });

  it("counts the most records a run can make", () => {
    expect(maxItems(workflowSchema.parse(COURSE))).toBe(1 + 2 + 6);
  });
});

describe("checking models against their tasks", () => {
  const catalog = (models: ModelChoice[] | null): Catalog => ({ providers: [{ id: "mock", label: "Mock", ready: true, images: true, defaultModel: "", models }] });

  it("knows what each task needs", () => {
    expect(supports({ output: ["image"] }, "image")).toBe("yes");
    expect(supports({ output: ["text"] }, "image")).toBe("no");
    expect(supports(undefined, "image")).toBe("unknown");
    expect(supports({ output: ["text"], structured: false }, "write")).toBe("no");
    expect(supports({ output: ["text"], structured: false }, "judge")).toBe("yes");
  });

  it("is an error when the provider says a model can't, and a warning when it doesn't say", () => {
    const workflow = workflowSchema.parse(COURSE);
    const problems = checkWorkflow(workflow, catalog([{ value: "planner", capabilities: { output: ["text"] } }, { value: "writer-1", capabilities: { output: ["image"] } }, { value: "painter", capabilities: { output: ["text"] } }]));
    expect(problems.filter((problem) => problem.level === "error").map((problem) => problem.message)).toEqual([
      "Writer one: writer-1 can't write records, as Mock reports it.",
      "Artist: painter can't draw pictures, as Mock reports it.",
    ]);
    expect(problems.some((problem) => problem.level === "warning" && problem.message.includes("doesn't list \"writer-2\""))).toBe(true);
    expect(checkWorkflow(workflow, { providers: [{ id: "mock", label: "Mock", ready: false, images: false, defaultModel: "", models: null }] })[0].message).toContain("isn't set up");
  });
});

describe("running a workflow", () => {
  it("plans, outlines, writes, judges and draws, then waits for review", async () => {
    const { run, runs, calls } = await runCourse();
    expect(run.status).toBe("review");
    expect(run.plan?.steps.lessons.prompts).toEqual({ w1: "Write warmly.", w2: "Write tersely." });
    const byStep = (step: string) => run.items.filter((item) => item.step === step);
    expect(byStep("course")).toHaveLength(1);
    expect(byStep("sections").map((item) => item.index)).toEqual([0, 1]);
    expect(byStep("lessons")).toHaveLength(4);
    expect(run.items.every((item) => item.status === "ready")).toBe(true);
    // Lessons take turns between the two writers.
    expect(new Set(byStep("lessons").map((item) => item.agent))).toEqual(new Set(["w1", "w2"]));
    // The planner's prompt reaches the writer it was written for.
    expect(calls.some((call) => call.model === "writer-2" && call.system.includes("Write tersely."))).toBe(true);
    expect(calls.every((call) => call.system.includes("Be kind."))).toBe(true);
    // Every call asks for JSON in words and gives the schema, for providers that only have JSON mode.
    expect(calls.every((call) => call.system.includes("Answer with one JSON object") && call.system.includes('"properties"'))).toBe(true);
    // The draft under the bar went back once and the better one was kept.
    expect(byStep("lessons").some((item) => item.revisions === 1 && item.score === 9)).toBe(true);
    // Stream fields are written as Markdown and become the text block.
    const lesson = await runs.values(run.id, byStep("lessons")[0].id);
    expect(lesson?.content).toEqual([{ type: "lms_text", value: { body: "## Hello\n\nAn example." } }]);
    expect(lesson).not.toHaveProperty("section");
    // The cover was drawn and kept.
    const course = byStep("course")[0];
    const image = await runs.image(run.id, course.images.cover);
    expect(image?.bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(run.usage).toMatchObject({ images: 1 });
    expect(run.usage.calls).toBeGreaterThan(8);
  });

  it("tries a failing call again, and hands work to the next writer when one can't", async () => {
    const retried = await runCourse({ failFirstWrite: true });
    expect(retried.run.status).toBe("review");
    expect(retried.run.log.some((entry) => entry.level === "warn" && entry.message.includes("Trying again"))).toBe(true);

    const broken = await runCourse({ writerOneBroken: true });
    // The course and sections only have writer one, so they fail; nothing under them is written.
    expect(broken.run.status).toBe("failed");
    expect(broken.run.tasks.find((task) => task.kind === "write")?.error).toContain("Unauthorized");
  });

  it("knows which errors are worth trying again", () => {
    expect(retryable(new APICallError({ message: "x", url: "u", requestBodyValues: {}, statusCode: 429 }))).toBe(true);
    expect(retryable(new APICallError({ message: "x", url: "u", requestBodyValues: {}, statusCode: 400 }))).toBe(false);
    expect(retryable(new Error("bad JSON"))).toBe(true);
  });

  it("only one server works on a run at a time", async () => {
    const { provider } = mockProvider();
    const store = memoryStore();
    const run = createRun({ workflow: workflowSchema.parse(COURSE), inputs: { topic: "Git" }, collections: COLLECTIONS, user: { id: "u1", name: "Edie" } });
    await runStore(store).save(run);
    await store.set(`lease/${run.id}`, { until: Date.now() + 60_000, owner: "someone-else" });
    await new Engine({ store, settings: async () => SETTINGS, providers: [provider], sleep: async () => {} }).drive(run.id);
    expect((await runStore(store).get(run.id))?.status).toBe("running");
  });

  it("pauses at a pass's deadline and carries on in the next pass", async () => {
    const { provider } = mockProvider();
    const store = memoryStore();
    const run = createRun({ workflow: workflowSchema.parse(COURSE), inputs: { topic: "Git" }, collections: COLLECTIONS, user: { id: "u1", name: "Edie" } });
    await runStore(store).save(run);
    const engine = () => new Engine({ store, settings: async () => SETTINGS, providers: [provider], sleep: async () => {} });
    // Under a minute left: nothing starts, and the run waits for the next pass.
    await engine().drive(run.id, { deadline: Date.now() + 30_000 });
    const paused = (await runStore(store).get(run.id))!;
    expect(paused.status).toBe("running");
    expect(paused.tasks.every((task) => task.status === "pending")).toBe(true);
    expect(await store.get("active")).toEqual([run.id]);
    await engine().drive(run.id, { deadline: Date.now() + 600_000 });
    expect((await runStore(store).get(run.id))?.status).toBe("review");
    expect(await store.get("active")).toEqual([]);
  });

  it("fails a task cut off at the end of a pass too many times", async () => {
    const { provider } = mockProvider();
    const store = memoryStore();
    const run = createRun({ workflow: workflowSchema.parse(COURSE), inputs: { topic: "Git" }, collections: COLLECTIONS, user: { id: "u1", name: "Edie" } });
    Object.assign(run.tasks[0], { status: "running", attempts: 5 });
    await runStore(store).save(run);
    await new Engine({ store, settings: async () => SETTINGS, providers: [provider], sleep: async () => {} }).drive(run.id);
    const after = (await runStore(store).get(run.id))!;
    expect(after.tasks[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/TANSY_BACKGROUND_SECONDS/) });
  });

  it("starts failed tasks again, and writes one record again", async () => {
    const { run } = await runCourse({ writerOneBroken: true });
    expect(retryFailed(run)).toBeGreaterThan(0);
    expect(run.status).toBe("running");
    const done = await runCourse();
    const lesson = done.run.items.find((item) => item.step === "lessons")!;
    expect(regenerate(done.run, lesson.id)).toBe(true);
    expect(done.run.tasks.at(-1)).toMatchObject({ kind: "write", item: lesson.id, status: "pending" });
  });
});

describe("creating the records", () => {
  it("orders parents first and skips what's left out and what's under it", async () => {
    const { run } = await runCourse();
    const section = run.items.find((item) => item.step === "sections")!;
    const order = commitOrder(run, new Set(run.items.filter((item) => item.id !== section.id).map((item) => item.id)));
    expect(order[0].step).toBe("course");
    expect(order.some((item) => item.parent === section.id)).toBe(false);
    expect(order).toHaveLength(1 + 1 + 2);
  });

  it("creates them as the person, with links, positions and uploaded pictures, once", async () => {
    const { store, run } = await runCourse();
    const plugin = ai({ providers: [mockProvider().provider] });
    const route = (method: string, path: string) => plugin.routes!.find((item) => item.method === method && item.path === path) as ExtensionRoute;
    let id = 100;
    const created: Array<{ collection: string; data: Record<string, unknown> }> = [];
    const call = vi.fn(async (name: string, input: { collection: string; data: Record<string, unknown> }) => {
      expect(name).toBe("create_record");
      created.push(input);
      return { id: ++id };
    });
    const course = run.items.find((item) => item.step === "course")!;
    const roles: string[] = [];
    const context = (body: unknown) => ({
      params: { id: run.id },
      body,
      store,
      principal: { kind: "user", user: { id: "u1", name: "Edie", email: "e@x.test" }, permissions: new Set() },
      tools: { call: vi.fn(), list: async () => [], withRole: async (role: string) => { roles.push(role); return { call, list: async () => [] }; } },
      auditTarget: vi.fn(),
      settings: { get: async () => SETTINGS },
    }) as unknown as ExtensionRouteContext;
    const result = (await route("POST", "/runs/:id/commit").handler(context({ files: { [course.images.cover]: "file123" } }))) as { created: unknown[] };
    expect(result.created).toHaveLength(7);
    // Within the AI's role, never the person's whole access.
    expect(roles).toEqual(["ai-assistant"]);
    expect(created[0]).toMatchObject({ collection: "courses", data: { cover: "file123", status: "draft" } });
    expect(created[1]).toMatchObject({ collection: "sections", data: { course: 101, position: 1 } });
    const lessons = created.filter((item) => item.collection === "lessons");
    expect(lessons[0].data).toMatchObject({ course: 101, position: 1 });
    expect([102, 103]).toContain(lessons[0].data.section);
    expect((await runStore(store).get(run.id))?.status).toBe("done");
    // A second press creates nothing more.
    await route("POST", "/runs/:id/commit").handler(context({ files: {} }));
    expect(call).toHaveBeenCalledTimes(7);
  });

  it("won't start a run whose models can't do their tasks", async () => {
    const { provider } = mockProvider();
    const plugin = ai({ providers: [{ ...provider, models: async () => [{ value: "writer-1", capabilities: { output: ["image"], reported: true } }] }] });
    const store = memoryStore();
    await store.set("workflow/course", { ...workflowSchema.parse(COURSE), updatedAt: "", updatedBy: "" });
    const route = plugin.routes!.find((item) => item.path === "/workflows/:id/runs") as ExtensionRoute;
    const response = (await route.handler({ params: { id: "course" }, body: { inputs: { topic: "Git" } }, store, principal: { kind: "user", user: { id: "u1", name: "Edie", email: "e" }, permissions: new Set() }, settings: { get: async () => SETTINGS }, tools: { call: vi.fn(), list: async () => [] }, auditTarget: vi.fn() } as unknown as ExtensionRouteContext)) as Response;
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({ code: "WORKFLOW_PROBLEMS", message: "Writer one: writer-1 can't write records, as Mock reports it." });
  });
});

describe("the role a workflow creates records with", () => {
  const save = async (permissions: string[], actsAs: string | undefined, stored?: string) => {
    const { provider } = mockProvider();
    const plugin = ai({ providers: [provider] });
    const store = memoryStore();
    if (stored !== undefined) await store.set("workflow/course", { ...workflowSchema.parse({ ...COURSE, actsAs: stored || undefined }), updatedAt: "", updatedBy: "" });
    const route = plugin.routes!.find((item) => item.path === "/workflows/:id" && item.method === "PUT") as ExtensionRoute;
    const result = await route.handler({ params: { id: "course" }, body: { ...COURSE, actsAs }, store, principal: { kind: "user", user: { id: "u1", name: "Edie", email: "e" }, permissions: new Set(permissions) }, settings: { get: async () => SETTINGS }, auditTarget: vi.fn() } as unknown as ExtensionRouteContext);
    return { status: result instanceof Response ? result.status : 200, store };
  };

  it("is chosen only by someone who may give people roles", async () => {
    expect((await save(["ext.ai:workflows"], "superadmin")).status).toBe(403);
    expect((await save(["ext.ai:workflows"], "editor", "")).status).toBe(403);
    expect((await save(["ext.ai:workflows"], undefined, "editor")).status).toBe(403);
    const { status, store } = await save(["ext.ai:workflows", "user:set-role"], "editor");
    expect(status).toBe(200);
    expect(await store.get("workflow/course")).toMatchObject({ actsAs: "editor" });
  });

  it("can be kept as it is by anyone who edits workflows", async () => {
    expect((await save(["ext.ai:workflows"], "editor", "editor")).status).toBe(200);
    expect((await save(["ext.ai:workflows"], undefined)).status).toBe(200);
  });
});

describe("pieces the dashboard uses", () => {
  it("writes streams with a text block as Markdown", () => {
    const fields = COLLECTIONS.lessons.fields;
    expect(Object.keys(writeSchema(fields).properties)).toEqual(["title", "content", "position"]);
    expect(writeValues(fields, { content: "Hi" }).content).toEqual([{ type: "lms_text", value: { body: "Hi" } }]);
  });

  it("finds an icon for a model by family or vendor", () => {
    expect(modelIconKey("anthropic/claude-opus-5-5")).toBe("claude");
    expect(modelIconKey("gpt-6-astra")).toBe("openai");
    expect(modelIconKey("black-forest-labs/flux-1.1-pro")).toBe("flux");
    expect(modelIconKey("meta-llama/llama-4-scout")).toBe("meta");
    expect(modelIconKey("mystery")).toBeNull();
  });

  it("starts every template as a valid workflow when the collections exist", () => {
    const catalog: Catalog = { providers: [{ id: "mock", label: "Mock", ready: true, images: true, defaultModel: "writer-1", models: [{ value: "writer-1", capabilities: { output: ["text"], structured: true } }, { value: "painter", capabilities: { output: ["image"] } }] }] };
    // A blank workflow waits for its brief.
    for (const template of ["course", "articles", "catalog"] as const) {
      const workflow = fromTemplate(template, catalog, ["lms-courses", "lms-sections", "lms-lessons", "posts", "shop-products"], "Mine");
      const parsed = workflowSchema.safeParse(workflow);
      expect(parsed.success, `${template}: ${parsed.error?.issues[0]?.message}`).toBe(true);
    }
  });
});
