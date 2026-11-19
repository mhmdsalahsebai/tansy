"use client";

import { apiPath } from "tansy/admin";

export type Reasoning = "provider-default" | "none" | "low" | "medium" | "high";

export interface AiStatus {
  ready: boolean;
  provider?: string;
  providerLabel?: string;
  /** The model the settings choose. */
  model?: string;
  /** The thinking the settings choose. */
  reasoning?: Reasoning;
  /** Whether the person may choose the model and thinking in the chat. */
  chooseModel?: boolean;
  /** Whether the provider can list its models. */
  listsModels?: boolean;
  /** The provider's icon from @lobehub/icons, when its adapter names one. */
  providerIcon?: string;
  /** The role the AI acts with unless the person picks another. */
  role?: string;
  /** Whether the person may pick the role in the chat. */
  chooseRole?: boolean;
  /** The providers set up, while the person may choose the model. The chat offers them when there's more than one. */
  providers?: ProviderChoice[];
}

export interface ProviderChoice {
  id: string;
  label: string;
  icon?: string;
  /** The model it uses unless the person picks another. */
  model?: string;
  listsModels: boolean;
}

export interface RoleChoice { value: string; label: string; description?: string }

/** The roles the person may give the assistant, or the reason they can't be listed. */
export async function chatRoles(): Promise<{ options: RoleChoice[] } | { error: string }> {
  const response = await fetch(apiPath("/ext/ai/roles"), { cache: "no-store" }).catch(() => null);
  const json = (await response?.json().catch(() => null)) as { options?: RoleChoice[]; error?: { message?: string } } | null;
  if (response?.ok && Array.isArray(json?.options)) return { options: json.options };
  return { error: json?.error?.message ?? "The roles couldn't be listed." };
}

export interface ModelChoice { value: string; label?: string }

/** The models of a provider, the site's when left out, the person may choose from in the chat, or the reason they can't be listed. */
export async function chatModels(provider?: string | null): Promise<{ options: ModelChoice[] } | { error: string }> {
  const response = await fetch(apiPath(`/ext/ai/chat/models${provider ? `?provider=${encodeURIComponent(provider)}` : ""}`), { cache: "no-store" }).catch(() => null);
  const json = (await response?.json().catch(() => null)) as { options?: ModelChoice[]; error?: { message?: string } } | null;
  if (response?.ok && Array.isArray(json?.options)) return { options: json.options };
  return { error: json?.error?.message ?? "The models couldn't be listed." };
}

let status: Promise<AiStatus | null> | null = null;

/** Whether this person may use AI and a provider is set up. Asked once per page load: every field's menu needs it. Null means they may not. */
export function aiStatus(): Promise<AiStatus | null> {
  status ??= fetch(apiPath("/ext/ai/status"), { cache: "no-store" })
    .then(async (response) => (response.ok ? ((await response.json()) as AiStatus) : null))
    .catch(() => null);
  return status;
}

/** Posts to one of the plugin's routes and returns its JSON, or throws with the message the route gave. */
export async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(apiPath(`/ext/ai${path}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await response.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!response.ok) throw new Error(json?.error?.message ?? "AI couldn't do that just now. Try again in a moment.");
  return json as T;
}

export interface ChatSummary { id: string; title: string; updatedAt: string }

/** The signed-in person's saved chats, most recent first. Empty when they can't be read. */
export async function listChats(): Promise<ChatSummary[]> {
  const response = await fetch(apiPath("/ext/ai/chats"), { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return [];
  return ((await response.json()) as { chats: ChatSummary[] }).chats;
}

/** One saved chat with its messages, or null when it's gone. */
export async function loadChat<M>(id: string): Promise<(ChatSummary & { messages: M[] }) | null> {
  const response = await fetch(apiPath(`/ext/ai/chats/${encodeURIComponent(id)}`), { cache: "no-store" }).catch(() => null);
  return response?.ok ? ((await response.json()) as ChatSummary & { messages: M[] }) : null;
}

export async function deleteChat(id: string): Promise<boolean> {
  const response = await fetch(apiPath(`/ext/ai/chats/${encodeURIComponent(id)}`), { method: "DELETE" }).catch(() => null);
  return Boolean(response?.ok);
}

export interface ChatCapabilities {
  model: string;
  /** The file types the chat's model may be sent. */
  accept: string[];
  /** Whether the provider says so, rather than the model's name. */
  reported: boolean;
  maxBytes: number;
  /** Whether the assistant can draw pictures. */
  draws: boolean;
}

/** What the chat's model reads, or null when it can't be told. */
export async function chatCapabilities(model: string | null, provider: string | null = null): Promise<ChatCapabilities | null> {
  const query = new URLSearchParams({ ...(model ? { model } : {}), ...(provider ? { provider } : {}) }).toString();
  const response = await fetch(apiPath(`/ext/ai/chat/capabilities${query ? `?${query}` : ""}`), { cache: "no-store" }).catch(() => null);
  return response?.ok ? ((await response.json()) as ChatCapabilities) : null;
}

export interface Attachment { id: string; url: string; mediaType: string; name: string; bytes: number }

/** Keeps a file for the chat, for the signed-in person alone. */
export async function uploadAttachment(file: Blob, name: string, mediaType: string): Promise<Attachment> {
  const response = await fetch(apiPath(`/ext/ai/attachments?name=${encodeURIComponent(name)}`), { method: "POST", headers: { "content-type": mediaType }, body: file }).catch(() => null);
  const json = (await response?.json().catch(() => null)) as (Attachment & { error?: { message?: string } }) | null;
  if (!response?.ok || !json?.id) throw new Error(json?.error?.message ?? "The file couldn't be attached.");
  return json;
}

export async function deleteAttachment(id: string): Promise<void> {
  await fetch(apiPath(`/ext/ai/attachments/${encodeURIComponent(id)}`), { method: "DELETE" }).catch(() => null);
}

/** Copies a picture the assistant drew into the site's files, as the person, and gives its file id. */
export async function addToFiles(url: string, name: string): Promise<string> {
  const picture = await fetch(url, { cache: "no-store" }).catch(() => null);
  if (!picture?.ok) throw new Error("The picture couldn't be read.");
  const type = picture.headers.get("content-type") ?? "image/png";
  const response = await fetch(apiPath(`/files/upload?name=${encodeURIComponent(name)}`), { method: "POST", headers: { "content-type": type }, body: await picture.blob() }).catch(() => null);
  const json = (await response?.json().catch(() => null)) as { id?: string; error?: { message?: string } } | null;
  if (!response?.ok || !json?.id) throw new Error(json?.error?.message ?? "The picture couldn't be added to the files.");
  return json.id;
}
