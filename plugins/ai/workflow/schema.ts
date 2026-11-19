import { z } from "zod";

/**
 * A workflow: a team of AI agents that writes records into one or more collections, such as
 * a course with its sections and lessons. Plain data, saved in the plugin's store and
 * edited in the dashboard. The engine in ./engine.ts runs it, and nothing is saved as a
 * record until a person reviews what it wrote and creates the records.
 */

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const WORKFLOW_ID = ID;
const id = z.string().regex(ID, "Use lowercase letters, digits and dashes.");
const name = z.string().trim().min(1).max(80);
const prompt = (max: number) => z.string().max(max).default("");

export const REASONING = ["provider-default", "none", "low", "medium", "high"] as const;

/** One model on the team, with the part it plays. */
export const agentSchema = z.object({
  id,
  name,
  /** Who it is and how it works, such as "A senior instructional designer who writes in plain English". */
  role: prompt(2000),
  provider: z.string().min(1).max(20),
  model: z.string().regex(/^[A-Za-z0-9][\w.:/@+-]{0,199}$/, "That isn't a model id."),
  reasoning: z.enum(REASONING).default("provider-default"),
  /** 0 to 2. Empty uses the model's default. */
  temperature: z.number().min(0).max(2).optional(),
});

/** How several writers on one step share the work. */
export const STRATEGIES = ["rotate", "compete", "fallback"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export const judgeSchema = z.object({
  agent: id,
  /** What a good answer is. Empty lets the planner write it from the brief. */
  criteria: prompt(2000),
  /** 1 to 10. A draft scoring less goes back to its writer with the judge's notes. */
  minScore: z.number().int().min(1).max(10).default(7),
  /** How many times a draft may be sent back. */
  revisions: z.number().int().min(0).max(3).default(1),
});

export const imageTaskSchema = z.object({
  /** The image field it fills. */
  field: z.string().min(1).max(63),
  /** Agents that draw. The first that succeeds is used; the rest are fallbacks. */
  artists: z.array(id).min(1).max(5),
  /** The look, such as "flat vector illustration, warm palette, no text". The record's own content is added. */
  style: prompt(1000),
  aspectRatio: z.enum(["1:1", "16:9", "4:3", "3:2", "2:3", "9:16"]).default("16:9"),
});

export const stepSchema = z.object({
  id,
  name,
  collection: z.string().min(1).max(63),
  /** A step whose records this one's belong to: each of its records gets its own set of these. */
  parent: id.optional(),
  /** The field on this collection that points at the parent's record, filled when records are created. */
  link: z.string().max(63).optional(),
  /** More fields that point at records further up, such as a lesson's course beside its section. */
  links: z.array(z.object({ field: z.string().min(1).max(63), step: id })).max(4).default([]),
  /** A number field filled with each record's place among its siblings: 1, 2, 3. */
  orderField: z.string().max(63).optional(),
  /** How many records: exactly `min`, or as many between `min` and `max` as the content needs. */
  count: z.object({ min: z.number().int().min(1).max(50), max: z.number().int().min(1).max(50) }).refine((count) => count.max >= count.min, "The most can't be fewer than the least."),
  /** The fields to write. Empty writes every field AI can fill. */
  fields: z.array(z.string().max(63)).max(100).default([]),
  /** What this step writes, on top of the brief. May use {{input}} names. */
  instructions: prompt(4000),
  writers: z.array(id).min(1).max(8),
  strategy: z.enum(STRATEGIES).default("rotate"),
  judge: judgeSchema.optional(),
  images: z.array(imageTaskSchema).max(5).default([]),
});

export const inputSchema = z.object({
  name: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/, "Start with a lowercase letter; letters, digits and _ after."),
  label: name,
  multiline: z.boolean().default(false),
  required: z.boolean().default(true),
});

export const workflowSchema = z.object({
  id,
  name,
  description: z.string().max(500).default(""),
  /** The master prompt: what to make and for whom. May use {{input}} names. */
  brief: z.string().trim().min(1, "Write the brief: what the team should make.").max(8000),
  inputs: z.array(inputSchema).max(12).default([]),
  agents: z.array(agentSchema).min(1, "Add at least one agent.").max(16),
  /** An agent that reads the brief first and writes each agent its own prompt, as a lead does for a team. */
  planner: z.object({ agent: id }).optional(),
  steps: z.array(stepSchema).min(1, "Add at least one step.").max(12),
  /** Calls to a provider that fail are tried again, waiting longer each time. */
  retry: z.object({ attempts: z.number().int().min(1).max(6).default(3), backoffSeconds: z.number().min(0).max(120).default(4) }).default({ attempts: 3, backoffSeconds: 4 }),
  /** How many tasks run at once. */
  concurrency: z.number().int().min(1).max(6).default(2),
  /** What the records are saved as. */
  status: z.enum(["draft", "published"]).default("draft"),
  /**
   * The role the records are created with, beside the access of the person who creates them:
   * never more than either. Empty uses the role chosen under AI → Settings.
   */
  actsAs: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/, "That isn't a role's name.").optional(),
}).superRefine((workflow, issues) => {
  const twice = (values: string[]) => values.find((value, index) => values.indexOf(value) !== index);
  const agents = new Set(workflow.agents.map((agent) => agent.id));
  const steps = new Map(workflow.steps.map((step, index) => [step.id, index]));
  const agentTwice = twice(workflow.agents.map((agent) => agent.id));
  if (agentTwice) issues.addIssue({ code: "custom", path: ["agents"], message: `The agent "${agentTwice}" is listed twice.` });
  const stepTwice = twice(workflow.steps.map((step) => step.id));
  if (stepTwice) issues.addIssue({ code: "custom", path: ["steps"], message: `The step "${stepTwice}" is listed twice.` });
  const inputTwice = twice(workflow.inputs.map((input) => input.name));
  if (inputTwice) issues.addIssue({ code: "custom", path: ["inputs"], message: `The input "${inputTwice}" is listed twice.` });
  if (workflow.planner && !agents.has(workflow.planner.agent)) issues.addIssue({ code: "custom", path: ["planner", "agent"], message: "The planner isn't on the team." });
  workflow.steps.forEach((step, index) => {
    const at = (path: Array<string | number>, message: string) => issues.addIssue({ code: "custom", path: ["steps", index, ...path], message });
    for (const writer of step.writers) if (!agents.has(writer)) at(["writers"], `"${writer}" isn't on the team.`);
    if (step.judge && !agents.has(step.judge.agent)) at(["judge", "agent"], "The judge isn't on the team.");
    if (step.strategy === "compete" && !step.judge) at(["judge"], "Writers that compete need a judge to choose between them.");
    step.images.forEach((image, imageIndex) => { for (const artist of image.artists) if (!agents.has(artist)) at(["images", imageIndex, "artists"], `"${artist}" isn't on the team.`); });
    if (step.parent) {
      // Parents come first, so a step's records always have theirs to belong to.
      const parent = steps.get(step.parent);
      if (parent === undefined) at(["parent"], "There's no such step.");
      else if (parent >= index) at(["parent"], "A step's parent must come before it.");
      if (!step.link) at(["link"], "Choose the field that links each record to its parent.");
    }
    // A link further up must name a step this one is under.
    const ancestors = new Set<string>();
    for (let parent = step.parent; parent && !ancestors.has(parent); parent = workflow.steps.find((other) => other.id === parent)?.parent) ancestors.add(parent);
    step.links.forEach((link, linkIndex) => { if (!ancestors.has(link.step)) at(["links", linkIndex, "step"], "Link only to a step this one is under."); });
  });
});

export type Agent = z.output<typeof agentSchema>;
export type Step = z.output<typeof stepSchema>;
export type Judge = z.output<typeof judgeSchema>;
export type ImageTask = z.output<typeof imageTaskSchema>;
export type Workflow = z.output<typeof workflowSchema>;
export type WorkflowInput = z.input<typeof workflowSchema>;

/** The parts of a model's abilities a task needs. */
export type Task = "write" | "judge" | "plan" | "image";

/** Fills {{name}} with the run's inputs. Unknown names stay as written. */
export const fill = (template: string, inputs: Record<string, string>) => template.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (whole, key: string) => (key in inputs ? inputs[key] : whole));
