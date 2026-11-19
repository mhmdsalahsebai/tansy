import { supports, type Catalog } from "./check";
import type { Agent, WorkflowInput } from "./schema";

/**
 * Starting points for a new workflow, filled in with models the site can use and
 * collections it has. Everything stays editable.
 */

export type TemplateId = "course" | "articles" | "catalog" | "blank";
export const TEMPLATES: TemplateId[] = ["course", "articles", "catalog", "blank"];

/** The first ready model that can do a task, preferring the provider's own default. */
function pick(catalog: Catalog, task: "write" | "image"): { provider: string; model: string } | null {
  for (const entry of catalog.providers.filter((item) => item.ready)) {
    const models = entry.models ?? [];
    const fallback = models.find((model) => model.value === entry.defaultModel) ?? models[0];
    const found = task === "write"
      ? (supports(fallback?.capabilities, "write") !== "no" ? fallback : models.find((model) => supports(model.capabilities, "write") === "yes"))
      : models.find((model) => supports(model.capabilities, "image") === "yes");
    if (found) return { provider: entry.id, model: found.value };
    if (task === "write" && !entry.models && entry.defaultModel) return { provider: entry.id, model: entry.defaultModel };
  }
  return null;
}

const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "workflow";

export function fromTemplate(template: TemplateId, catalog: Catalog, collections: string[], name: string): WorkflowInput {
  const writer = pick(catalog, "write") ?? { provider: catalog.providers[0]?.id ?? "openai", model: catalog.providers[0]?.defaultModel ?? "" };
  const artist = pick(catalog, "image");
  const has = (slug: string) => collections.includes(slug);
  const id = `${slugOf(name)}-${Math.random().toString(36).slice(2, 6)}`;
  const agent = (agentId: string, agentName: string, role: string, model = writer): Agent => ({ id: agentId, name: agentName, role, provider: model.provider, model: model.model, reasoning: "provider-default" });

  const lead = agent("lead", "Lead editor", "A managing editor who plans the work, sets the voice and writes each writer a sharp brief.");
  const writerA = agent("writer", "Writer", "A clear, warm writer who explains with concrete examples.");
  const writerB = agent("writer-2", "Second writer", "A precise writer who favours structure, short sentences and checklists.");
  const judge = agent("judge", "Judge", "A demanding reviewer who checks accuracy, completeness and fit with the brief, and says exactly what to fix.");
  const illustrator = artist ? agent("illustrator", "Illustrator", "Draws clean editorial illustrations.", artist) : null;
  const base = { id, name, retry: { attempts: 3, backoffSeconds: 4 }, concurrency: 2, status: "draft" as const };

  if (template === "course") {
    const lms = has("lms-courses") && has("lms-sections") && has("lms-lessons");
    return {
      ...base,
      description: "A course with its sections and lessons, planned by a lead, written by two writers in turn and checked by a judge.",
      brief: "Create a complete online course about {{topic}} for {{audience}}. Lessons build on each other, teach by example and end with a short recap.",
      inputs: [{ name: "topic", label: "Topic", multiline: false, required: true }, { name: "audience", label: "Audience", multiline: false, required: true }],
      agents: [lead, writerA, writerB, judge],
      planner: { agent: "lead" },
      steps: [
        { id: "course", name: "Course", collection: lms ? "lms-courses" : collections[0] ?? "", count: { min: 1, max: 1 }, fields: [], instructions: "The course page: a title, a summary that sells it, and what learners will be able to do.", writers: ["writer"], strategy: "rotate", judge: { agent: "judge", criteria: "", minScore: 7, revisions: 1 }, images: [], links: [] },
        { id: "sections", name: "Sections", collection: lms ? "lms-sections" : "", parent: "course", link: lms ? "course" : undefined, orderField: lms ? "position" : undefined, count: { min: 3, max: 6 }, fields: [], instructions: "Modules that take the learner from first steps to confident use.", writers: ["writer"], strategy: "rotate", images: [], links: [] },
        { id: "lessons", name: "Lessons", collection: lms ? "lms-lessons" : "", parent: "sections", link: lms ? "section" : undefined, links: lms ? [{ field: "course", step: "course" }] : [], orderField: lms ? "position" : undefined, count: { min: 2, max: 5 }, fields: [], instructions: "Each lesson teaches one idea with a worked example, then a short exercise.", writers: ["writer", "writer-2"], strategy: "rotate", judge: { agent: "judge", criteria: "", minScore: 7, revisions: 2 }, images: [] },
      ],
    };
  }
  if (template === "articles") {
    const posts = ["posts", "blog-posts", "articles"].find(has) ?? collections[0] ?? "";
    return {
      ...base,
      description: "A batch of articles: two writers compete on each, a judge keeps the better one and sends it back until it's good enough.",
      brief: "Write articles about {{topic}} for the site's readers. Each takes its own angle, opens with a strong hook and ends with a takeaway.",
      inputs: [{ name: "topic", label: "Topic", multiline: true, required: true }],
      agents: [writerA, writerB, judge, ...(illustrator ? [illustrator] : [])],
      steps: [
        { id: "articles", name: "Articles", collection: posts, count: { min: 3, max: 6 }, fields: [], instructions: "", writers: ["writer", "writer-2"], strategy: "compete", judge: { agent: "judge", criteria: "", minScore: 8, revisions: 1 }, images: [], links: [] },
      ],
    };
  }
  if (template === "catalog") {
    const products = ["shop-products", "products"].find(has) ?? collections[0] ?? "";
    return {
      ...base,
      description: "Product descriptions in the site's voice, from a list of product names.",
      brief: "Write product pages for these products, in a confident, friendly voice: {{products}}",
      inputs: [{ name: "products", label: "Products, one per line", multiline: true, required: true }],
      agents: [writerA, judge],
      steps: [
        { id: "products", name: "Products", collection: products, count: { min: 1, max: 20 }, fields: [], instructions: "One record per product listed, in the order given.", writers: ["writer"], strategy: "fallback", judge: { agent: "judge", criteria: "Accurate to the name, benefit-led, no invented specifications or prices.", minScore: 7, revisions: 1 }, images: [], links: [] },
      ],
    };
  }
  return {
    ...base,
    description: "",
    brief: "",
    inputs: [],
    agents: [writerA],
    steps: [{ id: "records", name: "Records", collection: collections[0] ?? "", count: { min: 1, max: 3 }, fields: [], instructions: "", writers: ["writer"], strategy: "rotate", images: [], links: [] }],
  };
}
