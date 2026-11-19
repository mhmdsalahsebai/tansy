import { describe, expect, it } from "vitest";
import { trashExpiry, trashLabel } from "@/core/content/trash";
import type { CollectionWithFields } from "@/core/content/access";

const field = (id: number, name: string, type: string, config: Record<string, unknown> | null = null) => ({ id, name, type, config, storage: null, collectionId: 1 });
const collection = (fields: Array<ReturnType<typeof field>>) => ({ id: 1, fields } as unknown as CollectionWithFields);

describe("a trash entry's label", () => {
  it("is the first field with a one-line summary, as the grid shows it", () => {
    const posts = collection([field(1, "slug", "text"), field(2, "title", "text")]);
    expect(trashLabel(posts, { slug: "ada", title: "Ada" })).toBe("ada");
    expect(trashLabel(posts, { slug: "", title: "Ada" })).toBe("Ada");
  });

  it("leaves out hidden fields, which the list's readers may not be able to read", () => {
    const people = collection([field(1, "secret", "text", { hidden: true }), field(2, "name", "text")]);
    expect(trashLabel(people, { secret: "private", name: "Ada" })).toBe("Ada");
    expect(trashLabel(collection([field(1, "secret", "text", { hidden: true })]), { secret: "private" })).toBe("");
  });

  it("is bounded, so one long value can't fill the table", () => {
    // Plain text is cut to 120 as the grid cuts it, and any other summary to 200.
    expect(trashLabel(collection([field(1, "title", "text")]), { title: "x".repeat(500) }).length).toBe(120);
    expect(trashLabel(collection([field(1, "tags", "json")]), { tags: ["y".repeat(500)] }).length).toBeLessThanOrEqual(200);
  });
});

describe("retention", () => {
  it("counts whole days from the delete", () => {
    const from = Date.UTC(2026, 0, 1);
    expect(trashExpiry(30, from).toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });
});
