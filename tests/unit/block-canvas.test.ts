import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminClientProvider, loadPreview } from "@/components/admin-client";
import type { EditorCatalog } from "@/components/fields/types";
import { canFrame, embedUrl } from "@/components/stream/embed";
import StreamEditor from "@/components/stream/StreamEditor";
import type { BlockProps } from "@/components/stream/StreamField";
import type { AdminClientPlugin, BlockEditorProps, SitePreview } from "@/core/extend/admin";

const fieldType = (type: string, input: string) => ({ type, label: type, input, configSchema: {} }) as EditorCatalog["fieldTypes"][number];
const blockType = (name: string, fields: Array<{ name: string; type: string }>) => ({ id: 1, name, label: name[0].toUpperCase() + name.slice(1), version: 1, fields });

const catalog: EditorCatalog = {
  fieldTypes: [fieldType("text", "text"), fieldType("url", "url")],
  blockTypes: [blockType("quote", [{ name: "text", type: "text" }]), blockType("note", [{ name: "body", type: "text" }]), blockType("video", [{ name: "url", type: "url" }, { name: "caption", type: "text" }])],
};

const SiteQuote = ({ value }: BlockProps) => createElement("blockquote", { className: "site-quote" }, String(value.text));

function NoteEditor({ Field }: BlockEditorProps) {
  return createElement("aside", { className: "plugin-note" }, createElement(Field, { name: "body", className: "plugin-note-text", placeholder: "Write a note" }));
}

const plugins: AdminClientPlugin[] = [{ name: "notes", blockEditors: [{ blocks: ["note"], component: NoteEditor }] }];

const site: SitePreview = { theme: null, renderers: { blocks: { quote: SiteQuote } }, tokens: { color: { accent: "#123456" } }, frames: ["https://www.youtube-nocookie.com"] };

async function render(blocks: unknown[], preview: SitePreview | null = site) {
  const sitePreview = preview ? async () => ({ default: preview }) : undefined;
  if (sitePreview) await loadPreview(sitePreview);
  return renderToString(createElement(AdminClientProvider, { plugins, enabled: ["notes"], sitePreview },
    createElement(StreamEditor, { value: blocks, onChange: () => {}, config: {}, catalog, issues: {}, path: "body", depth: 1 })));
}

const block = (type: string, value: Record<string, unknown>) => ({ id: `${type}-1`, type, v: 1, value });

describe("blocks on the canvas", () => {
  it("show as the site renders them while they aren't being edited", async () => {
    const html = await render([block("quote", { text: "Hello" })]);
    expect(html).toContain('class="site-quote"');
    expect(html).toContain("inert");
    expect(html).toContain('aria-label="Edit Quote"');
    expect(html).toContain("site-root");
    expect(html).toContain("--site-color-accent:#123456");
  });

  it("show their fields when the site's components aren't available", async () => {
    const html = await render([block("quote", { text: "Hello" })], null);
    expect(html).not.toContain("site-quote");
    expect(html).toContain("<textarea");
  });

  it("use a plugin's editor, with the CMS's controls placed in its markup", async () => {
    const html = await render([block("note", { body: "Remember" })]);
    expect(html).toMatch(/<aside class="plugin-note">[\s\S]*<textarea[^>]*class="[^"]*plugin-note-text/);
    expect(html).toContain("Remember");
    expect(html).toContain('placeholder="Write a note"');
  });

  it("embed a video link from the settings, only when the page may frame it", async () => {
    const youtube = block("video", { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(await render([youtube])).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(await render([youtube], { ...site, frames: [] })).not.toContain("<iframe");
  });
});

describe("embeds", () => {
  it("turn YouTube and Vimeo links into their players, and nothing else", () => {
    expect(embedUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(embedUrl("https://vimeo.com/123456")).toBe("https://player.vimeo.com/video/123456");
    expect(embedUrl("http://youtu.be/dQw4w9WgXcQ")).toBeNull();
    expect(embedUrl("https://youtube.com/watch?v=<script>")).toBeNull();
    expect(embedUrl("https://evil.test/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(embedUrl(42)).toBeNull();
  });

  it("frame only origins the policy lists", () => {
    expect(canFrame("https://player.vimeo.com/video/1", ["https://player.vimeo.com"])).toBe(true);
    expect(canFrame("https://player.vimeo.com/video/1", ["https://www.youtube-nocookie.com"])).toBe(false);
    expect(canFrame("https://player.vimeo.com/video/1", undefined)).toBe(false);
  });
});
