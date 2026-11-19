import type { ModelCapabilities, ModelChoice } from "../provider";
import type { Task, Workflow } from "./schema";

/**
 * Whether a workflow's agents can do what it asks of them, as their providers' APIs report.
 * Shared by the server, which refuses to run a workflow with errors, and the dashboard,
 * which shows the same problems as it is edited.
 */

/** A provider as the dashboard sees it: its models and what each can do. Never its key. */
export interface CatalogEntry {
  id: string;
  label: string;
  icon?: string;
  ready: boolean;
  /** Whether it has image models of its own, beside language models that answer with pictures. */
  images: boolean;
  defaultModel: string;
  models: ModelChoice[] | null;
  error?: string;
}

export interface Catalog {
  providers: CatalogEntry[];
  /** The roles a workflow can act with, and the one AI → Settings chooses. */
  roles?: Array<{ name: string; label: string; description?: string }>;
  /** Whether the person may choose that role: whoever may give people roles. */
  chooseRole?: boolean;
  defaultRole?: string;
}

/** Whether a model can do a task: yes, no, or unknown when its provider doesn't say. */
export type Support = "yes" | "no" | "unknown";

export function supports(capabilities: ModelCapabilities | undefined, task: Task): Support {
  const output = capabilities?.output;
  if (task === "image") {
    if (!output) return "unknown";
    return output.includes("image") ? "yes" : "no";
  }
  if (output && !output.includes("text")) return "no";
  // Writing records and plans needs an answer in a given JSON shape.
  if (task !== "judge" && capabilities?.structured === false) return "no";
  return output ? "yes" : "unknown";
}

export interface Problem { path: string; message: string; level: "error" | "warning" }

const TASK_WORDS: Record<Task, string> = { write: "write records", judge: "judge drafts", plan: "plan the work", image: "draw pictures" };

/** What each agent does in the workflow. */
export function tasksOf(workflow: Pick<Workflow, "planner" | "steps">): Map<string, Set<Task>> {
  const uses = new Map<string, Set<Task>>();
  const add = (agent: string, task: Task) => uses.set(agent, (uses.get(agent) ?? new Set()).add(task));
  if (workflow.planner) add(workflow.planner.agent, "plan");
  for (const step of workflow.steps) {
    for (const writer of step.writers) add(writer, "write");
    if (step.judge) add(step.judge.agent, "judge");
    for (const image of step.images ?? []) for (const artist of image.artists) add(artist, "image");
  }
  return uses;
}

/**
 * A model the provider says can't do a task is an error. One it says nothing about is a
 * warning, and runs anyway.
 */
export function checkWorkflow(workflow: Pick<Workflow, "agents" | "planner" | "steps">, catalog: Catalog): Problem[] {
  const problems: Problem[] = [];
  const uses = tasksOf(workflow);
  const providers = new Map(catalog.providers.map((entry) => [entry.id, entry]));
  workflow.agents.forEach((agent, index) => {
    const path = `agents.${index}`;
    const entry = providers.get(agent.provider);
    if (!entry) return problems.push({ path, level: "error", message: `${agent.name}: the provider "${agent.provider}" isn't installed.` });
    if (!entry.ready) return problems.push({ path, level: "error", message: `${agent.name}: ${entry.label} isn't set up. Add its key under AI → Settings.` });
    const tasks = uses.get(agent.id);
    if (!tasks?.size) return problems.push({ path, level: "warning", message: `${agent.name} has nothing to do in any step.` });
    const model = entry.models?.find((choice) => choice.value === agent.model);
    if (entry.models && !model) return problems.push({ path, level: "warning", message: `${agent.name}: ${entry.label} doesn't list "${agent.model}", so what it can do is unknown.` });
    for (const task of tasks) {
      const support = supports(model?.capabilities, task);
      if (support === "no") problems.push({ path, level: "error", message: `${agent.name}: ${agent.model} can't ${TASK_WORDS[task]}, as ${entry.label} reports it.` });
      else if (support === "unknown" && task === "image") problems.push({ path, level: "warning", message: `${agent.name}: ${entry.label} doesn't say whether ${agent.model} can draw pictures.` });
    }
  });
  return problems;
}
