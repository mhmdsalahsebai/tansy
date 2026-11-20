import { beforeAll, describe, expect, inject, it } from "vitest";

let onlyOneServer: typeof import("@/core/content/locks").onlyOneServer;

beforeAll(async () => {
  process.env.DATABASE_URL = inject("databaseUrl");
  process.env.BETTER_AUTH_SECRET ??= "integration-secret-integration-secret";
  ({ onlyOneServer } = await import("@/core/content/locks"));
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("startup's one-time setup", () => {
  // Servers cold-starting together each created the same plugin collections, and all but one then failed for good.
  it("runs on one server at a time, and the next starts only once the first is done", async () => {
    const events: string[] = [];
    const server = (name: string) => onlyOneServer("cms:startup-test", async () => {
      events.push(`${name} start`);
      await pause(150);
      events.push(`${name} end`);
      return name;
    });
    const results = await Promise.all([server("a"), server("b"), server("c")]);
    expect(results).toEqual(["a", "b", "c"]);
    // Every start is followed by its own end before anything else begins.
    for (let index = 0; index < events.length; index += 2) {
      expect(events[index + 1]).toBe(events[index].replace("start", "end"));
    }
  });

  it("lets the next server in after a failure", async () => {
    await expect(onlyOneServer("cms:startup-test", async () => { throw new Error("broken plugin"); })).rejects.toThrow("broken plugin");
    await expect(onlyOneServer("cms:startup-test", async () => "ran")).resolves.toBe("ran");
  });
});
