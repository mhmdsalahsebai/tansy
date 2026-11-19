import { describe, expect, it } from "vitest";
import { fileTextColumns, fileTextIn, fileTextOverrides, ownFileText, type TextualFile } from "@/core/files/text";

const file = (over: Partial<TextualFile> = {}): TextualFile => ({ alt: "A cat", caption: "", credit: "Ada", text: null, ...over });

describe("a file's text in one language", () => {
  it("is the file's own words on a site with one language", () => {
    expect(fileTextIn(file())).toEqual({ alt: "A cat", caption: "", credit: "Ada" });
    expect(ownFileText(file())).toEqual({ alt: "A cat", caption: "", credit: "Ada" });
  });

  it("takes the language asked for, and falls back word by word", () => {
    const stored = file({ text: { fr: { alt: "Un chat" }, de: { credit: "Ada D." } } });
    expect(fileTextIn(stored, ["fr", "en"])).toEqual({ alt: "Un chat", caption: "", credit: "Ada" });
    // Each word follows the whole chain before the file's own words: de has no alt, fr does.
    expect(fileTextIn(stored, ["de", "fr", "en"])).toEqual({ alt: "Un chat", caption: "", credit: "Ada D." });
    expect(fileTextIn(stored, ["de", "en"])).toEqual({ alt: "A cat", caption: "", credit: "Ada D." });
    // A language with nothing of its own reads the next in the chain before the file's own words.
    expect(fileTextIn(stored, ["it", "fr", "en"]).alt).toBe("Un chat");
  });

  it("ignores anything that isn't words by language", () => {
    expect(fileTextOverrides("nonsense")).toEqual({});
    expect(fileTextOverrides(["fr"])).toEqual({});
    expect(fileTextOverrides({ fr: "Un chat" })).toEqual({});
    expect(fileTextOverrides({ fr: { alt: "Un chat", caption: "", other: 7 } })).toEqual({ fr: { alt: "Un chat" } });
  });
});

describe("writing a file's text", () => {
  it("puts the default language in the file's own columns", () => {
    expect(fileTextColumns(file(), "en", "en", { alt: "A grey cat" })).toEqual({ alt: "A grey cat" });
    // Only what was sent, so a write of one word leaves the others alone.
    expect(fileTextColumns(file(), "en", "en", { caption: "Asleep" })).toEqual({ caption: "Asleep" });
  });

  it("puts another language in the text column, beside the ones already there", () => {
    const stored = file({ text: { fr: { alt: "Un chat" } } });
    expect(fileTextColumns(stored, "de", "en", { alt: "Eine Katze" })).toEqual({ text: { fr: { alt: "Un chat" }, de: { alt: "Eine Katze" } } });
  });

  it("drops a word that is cleared, and a language left with none", () => {
    const stored = file({ text: { fr: { alt: "Un chat", caption: "Endormi" } } });
    expect(fileTextColumns(stored, "fr", "en", { alt: "" })).toEqual({ text: { fr: { caption: "Endormi" } } });
    expect(fileTextColumns(file({ text: { fr: { alt: "Un chat" } } }), "fr", "en", { alt: "" })).toEqual({ text: null });
  });
});
