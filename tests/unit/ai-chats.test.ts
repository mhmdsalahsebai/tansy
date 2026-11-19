import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { PluginStore } from "@/core/extend/define";
import { chatStore, fitted, MAX_CHATS, mergeHistory, titleOf } from "../../plugins/ai/chats";

const say = (id: string, role: "user" | "assistant", text: string): UIMessage => ({ id, role, parts: [{ type: "text", text }] });

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

describe("saved chats", () => {
  it("keep the stored messages before the window the browser sent", () => {
    const stored = [say("1", "user", "a"), say("2", "assistant", "b"), say("3", "user", "c"), say("4", "assistant", "d")];
    expect(mergeHistory(stored, [say("3", "user", "c"), say("4", "assistant", "d"), say("5", "user", "e"), say("6", "assistant", "f")]).map((m) => m.id)).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("drop an answer the person asked to try again", () => {
    const stored = [say("1", "user", "a"), say("2", "assistant", "old")];
    expect(mergeHistory(stored, [say("1", "user", "a"), say("9", "assistant", "new")]).map((m) => m.id)).toEqual(["1", "9"]);
  });

  it("are titled by the first question, on one line", () => {
    expect(titleOf([say("1", "user", "  Draft\na post ")])).toBe("Draft a post");
    expect(titleOf([say("1", "user", "x".repeat(200))])).toHaveLength(80);
  });

  it("keep the most recent messages of a chat too long to store", () => {
    const messages = Array.from({ length: 40 }, (_, i) => say(String(i), i % 2 ? "assistant" : "user", "y".repeat(10_000)));
    const kept = fitted(messages);
    expect(kept.length).toBeLessThan(40);
    expect(kept.at(-1)!.id).toBe("39");
  });

  it("belong to one person, who alone can list, read and delete them", async () => {
    const store = memoryStore();
    const chats = chatStore(store);
    await chats.save("alice", "c1", [say("1", "user", "Hello"), say("2", "assistant", "Hi")]);
    expect(await chats.list("alice")).toMatchObject([{ id: "c1", title: "Hello" }]);
    expect(await chats.list("bob")).toEqual([]);
    expect(await chats.get("bob", "c1")).toBeNull();
    await chats.remove("bob", "c1");
    expect((await chats.get("alice", "c1"))?.messages).toHaveLength(2);
    expect(store.keys().every((key) => !key.includes("alice"))).toBe(true);
    await chats.remove("alice", "c1");
    expect(await chats.list("alice")).toEqual([]);
  });

  it("keep each person's most recent chats", async () => {
    const chats = chatStore(memoryStore());
    for (let i = 0; i <= MAX_CHATS; i++) await chats.save("alice", `c${i}`, [say("1", "user", `chat ${i}`)]);
    const list = await chats.list("alice");
    expect(list).toHaveLength(MAX_CHATS);
  });
});
