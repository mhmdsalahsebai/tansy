import { describe, expect, it } from "vitest";
import { detectSeparator, parseCsv } from "@/core/content/csv";
import { coerceImported } from "@/core/content/import";
import { HttpError } from "@/core/http/errors";

const field = (name: string, type: string, config: Record<string, unknown> | null = null) =>
  ({ id: 1, name, type, config, storage: null, collectionId: 1 }) as unknown as Parameters<typeof coerceImported>[0];

const problem = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof HttpError) return error.message;
    throw error;
  }
};

describe("reading a CSV file", () => {
  it("takes a header and rows by column name", () => {
    const { columns, rows, problems } = parseCsv("title,slug\nHello,hello\nWorld,world\n");
    expect(columns).toEqual(["title", "slug"]);
    expect(rows).toEqual([{ title: "Hello", slug: "hello" }, { title: "World", slug: "world" }]);
    expect(problems).toEqual([]);
  });

  it("keeps commas, newlines and quotes inside a quoted cell", () => {
    const { rows } = parseCsv('title,body\n"Hello, world","Line one\nLine two"\n"A ""quoted"" word",plain\n');
    expect(rows[0]).toEqual({ title: "Hello, world", body: "Line one\nLine two" });
    expect(rows[1]).toEqual({ title: 'A "quoted" word', body: "plain" });
  });

  it("reads semicolons and tabs, and skips the byte order mark and blank lines", () => {
    expect(detectSeparator("a;b;c\n1;2;3")).toBe(";");
    expect(parseCsv("﻿title;slug\nHello;hello\n\n").rows).toEqual([{ title: "Hello", slug: "hello" }]);
    expect(parseCsv("title\tslug\nHello\thello").rows).toEqual([{ title: "Hello", slug: "hello" }]);
    // A separator inside a quoted header cell doesn't decide it.
    expect(detectSeparator('"a,b";c\n1;2')).toBe(";");
  });

  it("reports a file it can't trust", () => {
    expect(parseCsv("").problems[0].message).toMatch(/empty/);
    expect(parseCsv('title,slug\n"never closed,x\n').problems.map((p) => p.message).join(" ")).toMatch(/never closed/);
    expect(parseCsv("title,title\na,b").problems[0].message).toMatch(/more than one column/);
    expect(parseCsv("title,\na,b").problems[0].message).toMatch(/no name/);
  });

  it("leaves out cells a short row doesn't have, so they aren't written as empty", () => {
    const { rows } = parseCsv("title,slug,body\nHello,hello\n");
    expect(rows[0]).toEqual({ title: "Hello", slug: "hello" });
    expect("body" in rows[0]).toBe(false);
  });
});

describe("a cell as the field's own kind of value", () => {
  it("reads numbers, booleans and dates", () => {
    expect(coerceImported(field("n", "number"), "42")).toBe(42);
    expect(coerceImported(field("n", "number"), "1.5")).toBe(1.5);
    expect(problem(() => coerceImported(field("n", "number"), "ten"))).toMatch(/isn't a number/);
    for (const yes of ["true", "1", "YES", "y", "on"]) expect(coerceImported(field("b", "boolean"), yes)).toBe(true);
    for (const no of ["false", "0", "No", "n", "off"]) expect(coerceImported(field("b", "boolean"), no)).toBe(false);
    expect(problem(() => coerceImported(field("b", "boolean"), "maybe"))).toMatch(/isn't true or false/);
    expect(coerceImported(field("d", "datetime"), "2026-03-04")).toBe("2026-03-04T00:00:00.000Z");
    expect(problem(() => coerceImported(field("d", "datetime"), "sometime"))).toMatch(/isn't a date/);
  });

  it("reads one or several record ids, and refuses anything else", () => {
    expect(coerceImported(field("author", "reference", { collection: 2 }), "7")).toBe(7);
    expect(coerceImported(field("tags", "reference", { collection: 2, allowMultiple: true }), "7, 9")).toEqual([7, 9]);
    expect(problem(() => coerceImported(field("author", "reference", { collection: 2 }), "x"))).toMatch(/isn't a record id/);
    expect(problem(() => coerceImported(field("author", "reference", { collection: 2 }), "0"))).toMatch(/isn't a record id/);
  });

  it("reads file ids as they are, one or several", () => {
    expect(coerceImported(field("cover", "image"), "abc123")).toBe("abc123");
    expect(coerceImported(field("shots", "gallery"), "abc, def")).toEqual(["abc", "def"]);
  });

  it("reads JSON, and says so when it can't", () => {
    expect(coerceImported(field("meta", "json"), '{"a":1}')).toEqual({ a: 1 });
    expect(problem(() => coerceImported(field("meta", "json"), "{a:1}"))).toMatch(/isn't valid JSON/);
  });

  it("treats an empty cell as no value, and passes typed values through", () => {
    expect(coerceImported(field("title", "text"), "")).toBeNull();
    expect(coerceImported(field("title", "text"), "   ")).toBeNull();
    expect(coerceImported(field("n", "number"), 42)).toBe(42);
    expect(coerceImported(field("meta", "json"), { a: 1 })).toEqual({ a: 1 });
    // Text keeps the spaces it was given: a title may want them.
    expect(coerceImported(field("title", "text"), " Hello ")).toBe(" Hello ");
  });
});
