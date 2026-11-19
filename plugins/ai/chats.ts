import { createHash } from "node:crypto";
import type { UIMessage } from "ai";
import type { PluginStore } from "tansy/plugin";
import { attachmentIds, attachmentStore } from "./attachments";

/**
 * Each person's assistant conversations, in the plugin's store: a JSON value per chat,
 * under a key only that person's id leads to. Nobody else's chats can be named, read
 * or deleted, whatever permissions they hold.
 */

/** A chat id as the browser makes it. */
export const CHAT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Kept per person. Saving one more drops the least recently used. */
export const MAX_CHATS = 100;

/** Below the store's 256 KiB a value. A longer chat keeps its most recent messages. */
const MAX_BYTES = 240 * 1024;

const TITLE_LENGTH = 80;

export interface ChatSummary { id: string; title: string; updatedAt: string }
export interface StoredChat extends ChatSummary { messages: UIMessage[] }

/** The person's id as a store key: ids from sign-in providers can hold any character. */
const owner = (userId: string) => createHash("sha256").update(userId).digest("hex").slice(0, 32);
const chatKey = (userId: string, id: string) => `chat/${owner(userId)}/${id}`;
const metaKey = (userId: string, id: string) => `meta/${owner(userId)}/${id}`;

/** The first thing the person asked, on one line. */
export function titleOf(messages: UIMessage[]): string {
  const first = messages.find((message) => message.role === "user");
  const text = first?.parts.map((part) => (part.type === "text" ? part.text : "")).join(" ").replace(/\s+/g, " ").trim() ?? "";
  return text.length > TITLE_LENGTH ? `${text.slice(0, TITLE_LENGTH - 1)}…` : text || "New chat";
}

/**
 * The whole conversation after a turn. The browser sends only its latest messages, so the
 * stored ones before them are kept. Anything stored from where they start is replaced by
 * the turn's messages, which also drops an answer the person asked to try again.
 */
export function mergeHistory(stored: UIMessage[], finished: UIMessage[]): UIMessage[] {
  const start = finished.length ? stored.findIndex((message) => message.id === finished[0].id) : -1;
  return start > 0 ? [...stored.slice(0, start), ...finished] : finished;
}

/** Drops the oldest messages until the chat fits in one stored value. */
export function fitted(messages: UIMessage[]): UIMessage[] {
  let kept = messages;
  while (kept.length > 1 && Buffer.byteLength(JSON.stringify(kept)) > MAX_BYTES) kept = kept.slice(Math.max(1, Math.floor(kept.length / 10)));
  return Buffer.byteLength(JSON.stringify(kept)) > MAX_BYTES ? [] : kept;
}

const isChat = (value: unknown): value is StoredChat => Boolean(value && typeof value === "object" && Array.isArray((value as StoredChat).messages));

export function chatStore(store: PluginStore) {
  async function list(userId: string): Promise<ChatSummary[]> {
    const rows = await store.list(`meta/${owner(userId)}/`);
    return rows
      .map(({ key, value }) => ({ id: key.slice(key.lastIndexOf("/") + 1), ...(value as Omit<ChatSummary, "id">) }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async function get(userId: string, id: string): Promise<StoredChat | null> {
    const value = await store.get(chatKey(userId, id));
    return isChat(value) ? { ...value, id } : null;
  }

  /** Deletes a chat with the files attached to it and the pictures drawn in it. */
  async function remove(userId: string, id: string) {
    const chat = await get(userId, id);
    const files = attachmentStore(store);
    for (const attachment of attachmentIds(chat?.messages)) await files.remove(userId, attachment);
    await store.delete(chatKey(userId, id));
    await store.delete(metaKey(userId, id));
  }

  /** Saves a turn of the conversation. */
  async function save(userId: string, id: string, finished: UIMessage[]) {
    const previous = await get(userId, id);
    const messages = fitted(mergeHistory(previous?.messages ?? [], finished));
    if (!messages.length) return;
    const summary = { title: previous?.title ?? titleOf(messages), updatedAt: new Date().toISOString() };
    await store.set(chatKey(userId, id), { ...summary, messages });
    await store.set(metaKey(userId, id), summary);
    if (!previous) {
      const all = await list(userId);
      for (const old of all.slice(MAX_CHATS)) await remove(userId, old.id);
    }
  }

  return { list, get, save, remove };
}
