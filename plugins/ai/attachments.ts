import { createHash, randomBytes } from "node:crypto";
import type { PluginStore } from "tansy/plugin";
import { MAX_DRAWN_BYTES } from "./media";

/**
 * Files each person attached to their chats, and pictures the assistant drew for them, in the
 * plugin's store under a key only that person's id leads to. Kept in pieces, as a stored value
 * is at most 256 KiB, and served back only to their owner.
 */

export const ATTACHMENT_ID = /^[a-z0-9]{20}$/;

/** Kept per person. Adding one more drops the oldest. */
export const MAX_KEPT = 300;

const CHUNK = 180 * 1024;

export interface AttachmentMeta { mediaType: string; name: string; bytes: number; chunks: number; createdAt: string; drawn?: boolean }

/** The person's id as a store key: ids from sign-in providers can hold any character. */
const owner = (userId: string) => createHash("sha256").update(`attachment:${userId}`).digest("hex").slice(0, 32);
const metaKey = (userId: string, id: string) => `attmeta/${owner(userId)}/${id}`;
const chunkKey = (userId: string, id: string, index: number) => `att/${owner(userId)}/${id}/${index}`;

const newId = () => Array.from(randomBytes(20), (byte) => "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36]).join("");

/** The attachment ids a chat's messages point at. */
export const attachmentIds = (value: unknown) => [...new Set([...JSON.stringify(value ?? null).matchAll(/\/ext\/ai\/attachments\/([a-z0-9]{20})/g)].map((match) => match[1]))];

/** The id in an address the chat gave out, such as "/api/ext/ai/attachments/<id>", or null for any other address. */
export function attachmentIdOf(url: string): string | null {
  const match = /^\/[\w/-]*\/ext\/ai\/attachments\/([a-z0-9]{20})$/.exec(url);
  return match ? match[1] : null;
}

export function attachmentStore(store: PluginStore) {
  async function meta(userId: string, id: string): Promise<AttachmentMeta | null> {
    if (!ATTACHMENT_ID.test(id)) return null;
    const value = (await store.get(metaKey(userId, id))) as AttachmentMeta | null;
    return value && typeof value.chunks === "number" ? value : null;
  }

  async function get(userId: string, id: string): Promise<(AttachmentMeta & { data: Buffer }) | null> {
    const found = await meta(userId, id);
    if (!found) return null;
    const parts: string[] = [];
    for (let index = 0; index < found.chunks; index++) parts.push(String((await store.get(chunkKey(userId, id, index))) ?? ""));
    return { ...found, data: Buffer.from(parts.join(""), "base64") };
  }

  async function remove(userId: string, id: string) {
    const found = await meta(userId, id);
    if (!found) return;
    for (let index = 0; index < found.chunks; index++) await store.delete(chunkKey(userId, id, index));
    await store.delete(metaKey(userId, id));
  }

  async function put(userId: string, file: { data: Uint8Array; mediaType: string; name: string; drawn?: boolean }): Promise<string> {
    if (file.data.byteLength > MAX_DRAWN_BYTES) throw new Error("The file is too large to keep.");
    const id = newId();
    const text = Buffer.from(file.data).toString("base64");
    const chunks = Math.ceil(text.length / CHUNK);
    for (let index = 0; index < chunks; index++) await store.set(chunkKey(userId, id, index), text.slice(index * CHUNK, (index + 1) * CHUNK));
    await store.set(metaKey(userId, id), { mediaType: file.mediaType, name: file.name.slice(0, 120), bytes: file.data.byteLength, chunks, createdAt: new Date().toISOString(), ...(file.drawn ? { drawn: true } : {}) } satisfies AttachmentMeta);
    const all = await store.list(`attmeta/${owner(userId)}/`);
    if (all.length > MAX_KEPT) {
      const oldest = all.map(({ key, value }) => ({ id: key.slice(key.lastIndexOf("/") + 1), at: String((value as AttachmentMeta).createdAt) })).sort((a, b) => a.at.localeCompare(b.at));
      for (const old of oldest.slice(0, all.length - MAX_KEPT)) await remove(userId, old.id);
    }
    return id;
  }

  return { meta, get, put, remove };
}
