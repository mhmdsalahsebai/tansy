"use client";

import { apiPath } from "tansy/admin";
import type { Catalog, Problem } from "./check";
import type { Run, RunSummary } from "./engine";
import type { Workflow, WorkflowInput } from "./schema";

export type { Catalog, CatalogEntry, Problem } from "./check";
export type { Run, RunItem, RunSummary, RunTask, LogEntry } from "./engine";
export type { Agent, Step, Workflow, WorkflowInput } from "./schema";

export interface WorkflowSummary { id: string; name: string; description: string; agents: number; steps: number; updatedAt: string; updatedBy: string }
export interface CollectionInfo { slug: string; name: string; type?: string; readOnly?: boolean }
export interface FieldInfo { name: string; type: string; label?: string; description?: string; required?: boolean; readonly?: boolean; schema?: Record<string, unknown>; blocks?: Array<{ name: string; fields: Array<{ name: string; type: string }> }> }

/** An error the route gave, with its details: the workflow's problems, or what was created before a failure. */
export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly details?: unknown) { super(message); }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiPath(`/ext/ai${path}`), { cache: "no-store", ...init, headers: init.body ? { "content-type": "application/json", ...init.headers } : init.headers }).catch(() => null);
  if (!response) throw new ApiError("The server couldn't be reached.", "NETWORK");
  const json = (await response.json().catch(() => null)) as (T & { error?: { code?: string; message?: string; details?: unknown } }) | null;
  if (!response.ok) throw new ApiError(json?.error?.message ?? "That didn't work. Try again in a moment.", json?.error?.code ?? "FAILED", json?.error?.details);
  return json as T;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const listWorkflows = () => call<{ workflows: WorkflowSummary[]; runs: RunSummary[] }>("/workflows");
export const loadCatalog = () => call<Catalog & { collections: CollectionInfo[] }>("/workflows/catalog");
export const loadCollection = (slug: string) => call<{ slug: string; name: string; fields: FieldInfo[] }>(`/workflows/collections/${encodeURIComponent(slug)}`);
export const loadWorkflow = (id: string) => call<{ workflow: Workflow }>(`/workflows/${encodeURIComponent(id)}`);
export const saveWorkflow = (workflow: WorkflowInput) => call<{ workflow: Workflow; problems: Problem[] }>(`/workflows/${encodeURIComponent(workflow.id)}`, json("PUT", workflow));
export const deleteWorkflow = (id: string) => call<{ deleted: true }>(`/workflows/${encodeURIComponent(id)}`, json("DELETE"));
export const startRun = (id: string, inputs: Record<string, string>) => call<{ run: RunSummary }>(`/workflows/${encodeURIComponent(id)}/runs`, json("POST", { inputs }));
export const loadRun = (id: string, values = false) => call<{ run: Run; driving: boolean; values?: Record<string, Record<string, string>> }>(`/runs/${id}${values ? "?values=1" : ""}`);
export const cancelRun = (id: string) => call<unknown>(`/runs/${id}/cancel`, json("POST"));
export const retryRun = (id: string) => call<unknown>(`/runs/${id}/retry`, json("POST"));
export const regenerateItem = (id: string, item: string) => call<unknown>(`/runs/${id}/items/${item}/regenerate`, json("POST"));
export const deleteRun = (id: string) => call<unknown>(`/runs/${id}`, json("DELETE"));
export const commitRun = (id: string, body: { include?: string[]; files: Record<string, string> }) => call<{ created: Array<{ item: string; collection: string; id: number }> }>(`/runs/${id}/commit`, json("POST", body));

export const imageUrl = (run: string, image: string) => apiPath(`/ext/ai/runs/${run}/images/${image}`);

/** Uploads one of a run's pictures to the site's files, as the person, and gives its file id. */
export async function uploadImage(run: string, image: string, name: string): Promise<string> {
  const picture = await fetch(imageUrl(run, image), { cache: "no-store" });
  if (!picture.ok) throw new ApiError("A picture couldn't be read.", "IMAGE");
  const type = picture.headers.get("content-type") ?? "image/png";
  const extension = type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "image";
  // Temporary until a record uses it, so a picture left out is cleaned up.
  const response = await fetch(apiPath(`/files/upload?name=${encodeURIComponent(`${safe}.${extension}`)}&temporary=true`), { method: "POST", headers: { "content-type": type }, body: await picture.blob() });
  const json = (await response.json().catch(() => null)) as { id?: string; error?: { message?: string } } | null;
  if (!response.ok || !json?.id) throw new ApiError(json?.error?.message ?? "A picture couldn't be uploaded.", "UPLOAD");
  return json.id;
}
