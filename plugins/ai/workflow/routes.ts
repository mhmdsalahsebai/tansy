import { z } from "zod";
import { afterResponse, defineRoute, type ExtensionContext, type ExtensionRouteContext, type ExtensionTools, type JobDefinition, type PluginStore } from "tansy/plugin";
import { conform, textOf, type DescribedField } from "../logic";
import { catalogOf } from "../models";
import type { AiProvider, AiSettings } from "../provider";
import { checkWorkflow } from "./check";
import { givesRoles, roleFor } from "../role";
import { activeRuns, commitOrder, createRun, Engine, isDriven, ITEM_ID, MAX_ITEMS, maxItems, regenerate, requestCancel, retryFailed, RUN_ID, runStore, summaryOf, type RunCollection } from "./engine";
import { WORKFLOW_ID, workflowSchema, type Workflow } from "./schema";

/** Building, running and reviewing workflows. They choose which paid models run, so they have their own permission. */
export const WORKFLOWS = "ext.ai:workflows";

const refuse = (status: number, code: string, message: string, details?: unknown) => Response.json({ error: { code, message, ...(details ? { details } : {}) } }, { status });

const workflowKey = (id: string) => `workflow/${id}`;

interface WorkflowSummary { id: string; name: string; description: string; agents: number; steps: number; updatedAt: string; updatedBy: string }

const isWorkflow = (value: unknown): value is Workflow & { updatedAt: string; updatedBy: string } => Boolean(value && typeof value === "object" && Array.isArray((value as Workflow).steps));

async function workflows(store: PluginStore): Promise<WorkflowSummary[]> {
  return (await store.list("workflow/")).flatMap(({ value }) => (isWorkflow(value) ? [{ id: value.id, name: value.name, description: value.description, agents: value.agents.length, steps: value.steps.length, updatedAt: value.updatedAt, updatedBy: value.updatedBy }] : []))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const userOf = (context: ExtensionRouteContext<unknown, unknown>) => (context.principal.kind === "user" ? { id: context.principal.user.id, name: context.principal.user.name || context.principal.user.email } : null);

const engineFor = (context: ExtensionContext, providers: AiProvider[]) => new Engine({ store: context.store, settings: async () => (await context.settings.get()) as unknown as AiSettings, providers });

/** Starts working on a run in this server, and logs rather than throws: the job picks it up again if this stops. */
/** Starts work on a run after the response. Where functions stop after a time, it pauses before then and a background pass carries on. */
const kick = (context: ExtensionContext, providers: AiProvider[], id: string) => afterResponse("ai", (pass) => engineFor(context, providers).drive(id, { deadline: pass.deadline }));

const runParam = (context: ExtensionRouteContext<unknown, unknown>) => (RUN_ID.test(context.params.id) ? context.params.id : null);

/** One lock for creating a run's records, so a double click can't create them twice. Stale after ten minutes. */
async function lockCommit(store: PluginStore, id: string) {
  const key = `commit/${id}`;
  const held = (await store.get(key)) as { at: number } | null;
  if (held && Date.now() - held.at > 10 * 60_000) await store.delete(key);
  return (await store.claim(key, { at: Date.now() })) ? () => store.delete(key) : null;
}

/** A record's values as text: rich text and blocks as Markdown, everything else as written. */
function preview(values: Record<string, unknown>): Record<string, string> {
  const text = (value: unknown): string => {
    if (Array.isArray(value)) return value.map((entry) => (entry && typeof entry === "object" && "value" in entry ? Object.values((entry as { value: Record<string, unknown> }).value ?? {}).map(text).filter(Boolean).join("\n\n") : text(entry))).filter(Boolean).join("\n\n");
    if (value && typeof value === "object") return textOf(value);
    return value === null || value === undefined ? "" : String(value);
  };
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, text(value).slice(0, 20_000)]));
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function workflowRoutes(providers: AiProvider[]) {
  const describe = async (context: ExtensionRouteContext<unknown, unknown>, slug: string): Promise<RunCollection> => {
    const collection = (await context.tools.call("describe_collection", { collection: slug })) as { slug: string; name: string; fields: DescribedField[] };
    return { slug: collection.slug, name: collection.name, fields: collection.fields };
  };

  return [
    defineRoute({
      method: "GET",
      path: "/workflows",
      access: "permission",
      permission: WORKFLOWS,
      handler: async (context) => ({ workflows: await workflows(context.store), runs: (await runStore(context.store).list()).slice(0, 50) }),
    }),
    defineRoute({
      method: "GET",
      path: "/workflows/catalog",
      access: "permission",
      permission: WORKFLOWS,
      rateLimit: { window: 60, max: 30 },
      handler: async (context) => {
        // Providers' models with what each can do, and the collections the person can read. Never a key.
        const settings = (await context.settings.get()) as unknown as AiSettings;
        // Only someone who may give people roles may give a workflow one.
        const chooseRole = givesRoles(context.principal);
        const [catalog, collections, roles] = await Promise.all([catalogOf(providers, settings), context.tools.call("list_collections", {}), chooseRole ? context.tools.roles() : []]);
        return { ...catalog, collections, roles, chooseRole, defaultRole: roleFor(settings) };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/workflows/collections/:slug",
      access: "permission",
      permission: WORKFLOWS,
      handler: async (context) => describe(context, context.params.slug),
    }),
    defineRoute({
      method: "GET",
      path: "/workflows/:id",
      access: "permission",
      permission: WORKFLOWS,
      handler: async (context) => {
        const value = WORKFLOW_ID.test(context.params.id) ? await context.store.get(workflowKey(context.params.id)) : null;
        return isWorkflow(value) ? { workflow: value } : refuse(404, "NOT_FOUND", "There's no such workflow.");
      },
    }),
    defineRoute({
      method: "PUT",
      path: "/workflows/:id",
      access: "permission",
      permission: WORKFLOWS,
      audit: "ai.workflow.save",
      body: z.unknown(),
      handler: async (context) => {
        const parsed = workflowSchema.safeParse(context.body);
        if (!parsed.success) return refuse(400, "VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "The workflow isn't valid.", parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })));
        if (parsed.data.id !== context.params.id) return refuse(400, "BAD_REQUEST", "The workflow's id doesn't match its address.");
        const stored = await context.store.get(workflowKey(parsed.data.id));
        if ((parsed.data.actsAs ?? "") !== ((isWorkflow(stored) && stored.actsAs) || "") && !givesRoles(context.principal)) {
          return refuse(403, "FORBIDDEN", "Only someone who may give people roles may choose the role a workflow creates records with.");
        }
        if (maxItems(parsed.data) > MAX_ITEMS) return refuse(400, "TOO_LARGE", `This workflow could make up to ${maxItems(parsed.data)} records. A run makes at most ${MAX_ITEMS}: lower the counts.`);
        const user = userOf(context);
        const workflow = { ...parsed.data, updatedAt: new Date().toISOString(), updatedBy: user?.name ?? "" };
        context.auditTarget("ai-workflow", workflow.id, { agents: workflow.agents.map((agent) => `${agent.provider}/${agent.model}`) });
        await context.store.set(workflowKey(workflow.id), workflow);
        const settings = (await context.settings.get()) as unknown as AiSettings;
        return { workflow, problems: checkWorkflow(workflow, await catalogOf(providers, settings)) };
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/workflows/:id",
      access: "permission",
      permission: WORKFLOWS,
      audit: "ai.workflow.delete",
      handler: async (context) => {
        if (!WORKFLOW_ID.test(context.params.id)) return refuse(404, "NOT_FOUND", "There's no such workflow.");
        context.auditTarget("ai-workflow", context.params.id);
        await context.store.delete(workflowKey(context.params.id));
        return { deleted: true };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/workflows/:id/runs",
      access: "permission",
      permission: WORKFLOWS,
      audit: "ai.workflow.run",
      rateLimit: { window: 60, max: 10 },
      body: z.object({ inputs: z.record(z.string(), z.string().max(8000)).default({}) }),
      handler: async (context) => {
        const user = userOf(context);
        const stored = WORKFLOW_ID.test(context.params.id) ? await context.store.get(workflowKey(context.params.id)) : null;
        if (!user || !isWorkflow(stored)) return refuse(404, "NOT_FOUND", "There's no such workflow.");
        // Stored workflows are checked again: a plugin upgrade may have changed the shape.
        const parsed = workflowSchema.safeParse(stored);
        if (!parsed.success) return refuse(400, "VALIDATION_FAILED", "Open the workflow and save it again: it needs changes.");
        const workflow = parsed.data;
        const missing = workflow.inputs.find((input) => input.required && !context.body.inputs[input.name]?.trim());
        if (missing) return refuse(400, "VALIDATION_FAILED", `Fill in "${missing.label}".`);
        const settings = (await context.settings.get()) as unknown as AiSettings;
        const problems = checkWorkflow(workflow, await catalogOf(providers, settings)).filter((problem) => problem.level === "error");
        if (problems.length) return refuse(400, "WORKFLOW_PROBLEMS", problems[0].message, problems);
        // Read as the person, so a run only ever sees fields they may see.
        const collections: Record<string, RunCollection> = {};
        for (const slug of new Set(workflow.steps.map((step) => step.collection))) collections[slug] = await describe(context, slug);
        const inputs = Object.fromEntries(workflow.inputs.map((input) => [input.name, (context.body.inputs[input.name] ?? "").trim()]));
        const run = createRun({ workflow, inputs, collections, user });
        await runStore(context.store).save(run);
        context.auditTarget("ai-workflow-run", run.id, { workflow: workflow.id });
        kick(context, providers, run.id);
        return { run: summaryOf(run) };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/runs/:id",
      access: "permission",
      permission: WORKFLOWS,
      query: z.object({ values: z.enum(["1"]).optional() }),
      handler: async (context) => {
        const id = runParam(context);
        const runs = runStore(context.store);
        const run = id ? await runs.get(id) : null;
        if (!run) return refuse(404, "NOT_FOUND", "There's no such run.");
        // For reading in the review: each value as text, rich text and blocks as Markdown.
        const values = context.query.values ? Object.fromEntries(await Promise.all(run.items.filter((item) => item.status === "ready").map(async (item) => [item.id, preview((await runs.values(run.id, item.id)) ?? {})] as const))) : undefined;
        return { run, driving: await isDriven(context.store, run.id), ...(values ? { values } : {}) };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/runs/:id/images/:image",
      access: "permission",
      permission: WORKFLOWS,
      handler: async (context) => {
        const id = runParam(context);
        const image = id && ITEM_ID.test(context.params.image) ? await runStore(context.store).image(id, context.params.image) : null;
        if (!image) return refuse(404, "NOT_FOUND", "There's no such picture.");
        // Only pictures, never anything a browser would run.
        const type = IMAGE_TYPES.has(image.mediaType) ? image.mediaType : "application/octet-stream";
        return new Response(new Uint8Array(image.bytes), { headers: { "content-type": type, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" } });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/runs/:id/cancel",
      access: "permission",
      permission: WORKFLOWS,
      audit: "ai.workflow.cancel",
      handler: async (context) => {
        const id = runParam(context);
        const runs = runStore(context.store);
        const run = id ? await runs.get(id) : null;
        if (!run) return refuse(404, "NOT_FOUND", "There's no such run.");
        context.auditTarget("ai-workflow-run", run.id);
        if (run.status !== "running") return { run: summaryOf(run) };
        if (await isDriven(context.store, run.id)) {
          await requestCancel(context.store, run.id);
          return { cancelling: true };
        }
        for (const task of run.tasks) if (task.status === "pending" || task.status === "running") task.status = "cancelled";
        run.status = "cancelled";
        await runs.save(run);
        return { run: summaryOf(run) };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/runs/:id/retry",
      access: "permission",
      permission: WORKFLOWS,
      audit: "ai.workflow.retry",
      rateLimit: { window: 60, max: 20 },
      handler: async (context) => {
        const id = runParam(context);
        const runs = runStore(context.store);
        const run = id ? await runs.get(id) : null;
        if (!run) return refuse(404, "NOT_FOUND", "There's no such run.");
        if (run.status === "running" || (await isDriven(context.store, run.id))) return refuse(409, "BUSY", "The run is still working. Wait for it to finish, or cancel it.");
        if (!retryFailed(run)) return refuse(400, "NOTHING_TO_RETRY", "Nothing failed.");
        context.auditTarget("ai-workflow-run", run.id);
        await runs.save(run);
        kick(context, providers, run.id);
        return { run: summaryOf(run) };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/runs/:id/items/:item/regenerate",
      access: "permission",
      permission: WORKFLOWS,
      audit: "ai.workflow.regenerate",
      rateLimit: { window: 60, max: 30 },
      handler: async (context) => {
        const id = runParam(context);
        const runs = runStore(context.store);
        const run = id ? await runs.get(id) : null;
        if (!run) return refuse(404, "NOT_FOUND", "There's no such run.");
        if (run.status === "running" || (await isDriven(context.store, run.id))) return refuse(409, "BUSY", "The run is still working. Wait for it to finish.");
        if (!regenerate(run, context.params.item)) return refuse(400, "NOT_REGENERABLE", "That record is gone or already created.");
        context.auditTarget("ai-workflow-run", run.id, { item: context.params.item });
        await runs.save(run);
        kick(context, providers, run.id);
        return { run: summaryOf(run) };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/runs/:id/commit",
      access: "permission",
      permission: WORKFLOWS,
      audit: "ai.workflow.commit",
      rateLimit: { window: 60, max: 10 },
      body: z.object({
        /** The items to create. All that are ready when left out. */
        include: z.array(z.string().regex(ITEM_ID)).max(1000).optional(),
        /** Pictures the person uploaded, by the run's picture id: the file ids the image fields take. */
        files: z.record(z.string().regex(ITEM_ID), z.string().min(1).max(64)).default({}),
      }),
      handler: async (context) => {
        const id = runParam(context);
        const runs = runStore(context.store);
        const run = id ? await runs.get(id) : null;
        if (!run) return refuse(404, "NOT_FOUND", "There's no such run.");
        if (run.status === "running") return refuse(409, "BUSY", "The run is still working. Wait for it to finish.");
        const unlock = await lockCommit(context.store, run.id);
        if (!unlock) return refuse(409, "BUSY", "These records are being created already.");
        // As the person, limited to what the workflow's role also grants.
        const role = run.workflow.actsAs || roleFor((await context.settings.get()) as unknown as AiSettings);
        let tools: ExtensionTools;
        try {
          tools = await context.tools.withRole(role);
        } catch {
          await unlock();
          return refuse(400, "AI_ROLE_MISSING", `The workflow's role "${role}" doesn't exist any more. Choose another in the workflow or under AI → Settings.`);
        }
        context.auditTarget("ai-workflow-run", run.id, { role });
        const created: Array<{ item: string; collection: string; id: number }> = [];
        try {
          const ids = new Map(run.items.map((item) => [item.id, item.recordId]));
          // Each collection's fields as they are now, to fix or drop values a model wrote that the fields don't take.
          const current = new Map<string, Promise<Map<string, DescribedField>>>();
          const fieldsOf = (slug: string) => {
            if (!current.has(slug)) current.set(slug, describe(context, slug).then((collection) => new Map(collection.fields.map((field) => [field.name, field]))).catch(() => new Map()));
            return current.get(slug)!;
          };
          for (const item of commitOrder(run, context.body.include ? new Set(context.body.include) : null)) {
            if (item.recordId) continue;
            const step = run.workflow.steps.find((entry) => entry.id === item.step)!;
            const fields = await fieldsOf(step.collection);
            const data: Record<string, unknown> = { status: run.workflow.status };
            for (const [name, value] of Object.entries((await runs.values(run.id, item.id)) ?? {})) {
              const field = fields.get(name);
              const kept = field && field.type !== "stream" ? conform(field, value) : value;
              if (kept !== undefined) data[name] = kept;
            }
            if (step.link && item.parent) {
              const parent = ids.get(item.parent);
              if (!parent) continue;
              data[step.link] = parent;
            }
            for (const link of step.links) {
              let above = run.items.find((entry) => entry.id === item.parent);
              while (above && above.step !== link.step) above = run.items.find((entry) => entry.id === above!.parent);
              const record = above && ids.get(above.id);
              if (record) data[link.field] = record;
            }
            if (step.orderField) data[step.orderField] = item.index + 1;
            for (const [field, image] of Object.entries(item.images)) if (context.body.files[image]) data[field] = context.body.files[image];
            // Through the same tool the assistant uses: the person's rules and validation apply.
            try {
              const record = (await tools.call("create_record", { collection: step.collection, data })) as { id: number };
              item.recordId = record.id;
              ids.set(item.id, record.id);
              created.push({ item: item.id, collection: step.collection, id: record.id });
            } catch (error) {
              const known = error as { message?: string; details?: unknown };
              // Name the fields that were refused: "Request validation failed." alone doesn't say what to fix.
              const fields = Array.isArray(known.details) ? known.details.flatMap((issue: { path?: unknown; message?: unknown }) => (issue && typeof issue.message === "string" ? [`${typeof issue.path === "string" && issue.path ? `${issue.path}: ` : ""}${issue.message}`] : [])).slice(0, 5).join("; ") : "";
              const reason = `${known.message ?? "it was refused."}${fields ? ` ${fields}` : ""}`;
              run.log.push({ at: new Date().toISOString(), level: "error", message: `Creating "${item.title}" failed: ${reason.slice(0, 400)}` });
              await runs.save(run);
              return refuse(400, "COMMIT_FAILED", `Creating "${item.title}" failed: ${reason}`, { created, details: known.details });
            }
          }
          if (commitOrder(run, null).every((item) => item.recordId)) run.status = "done";
          run.log.push({ at: new Date().toISOString(), level: "info", message: `${userOf(context)?.name ?? "Someone"} created ${created.length} record(s).` });
          await runs.save(run);
          return { created, run: summaryOf(run) };
        } finally {
          await unlock();
        }
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/runs/:id",
      access: "permission",
      permission: WORKFLOWS,
      audit: "ai.workflow.run.delete",
      handler: async (context) => {
        const id = runParam(context);
        const runs = runStore(context.store);
        const run = id ? await runs.get(id) : null;
        if (!run) return refuse(404, "NOT_FOUND", "There's no such run.");
        if (await isDriven(context.store, run.id)) return refuse(409, "BUSY", "Cancel the run first.");
        context.auditTarget("ai-workflow-run", run.id);
        await runs.remove(run);
        return { deleted: true };
      },
    }),
  ];
}

/**
 * Picks up runs a stopped server left, once a minute. Each run is worked on by one server at a
 * time. Where background work runs in passes with a deadline, as on Vercel, this is what moves
 * runs on: each pass works on them until just before its deadline, and the next carries on.
 */
export function workflowJob(providers: AiProvider[]): JobDefinition {
  return {
    name: "ai-workflows",
    cron: "* * * * *",
    // Runs live in the store of the tenant they started in, so each tenant's are picked up in its own.
    perScope: true,
    handler: async (context, pass) => {
      const idle: string[] = [];
      for (const id of await activeRuns(context.store)) if (!(await isDriven(context.store, id))) idle.push(id);
      if (pass.deadline === null) return void idle.forEach((id) => kick(context, providers, id));
      await Promise.all(idle.map((id) => engineFor(context, providers).drive(id, { deadline: pass.deadline }).catch((error) => console.error("[ai] a workflow run failed", error))));
    },
  };
}
