import { defineTheme } from "tansy/theme";
import { z } from "zod";
import schema from "./schema.json";

export interface BlogOptions {
  /** Shown under the site's name. */
  tagline?: string;
  showDates: boolean;
}

const options = z.object({ tagline: z.string().max(200).optional(), showDates: z.boolean() });

/** The look of a blog: a header with a menu, a home page listing posts, its own post page, and plain pages. Archives come from the blog plugin, which this theme requires, and the post page is built from its parts. */
export const blog = ({ tagline, showDates = true }: { tagline?: string; showDates?: boolean } = {}) => defineTheme<BlogOptions>({
  name: "blog",
  version: "0.1.0",
  apiVersion: 1,
  render: "@tansy/theme-blog/render",
  requires: { plugins: ["blog"] },
  options: { schema: options, value: { tagline, showDates } },
  schema,
  tokens: {
    color: { page: "#fbfaf7", text: "#23262b", muted: "#676c75", border: "#e4e1d9", accent: "#2f6f5e", "on-accent": "#ffffff" },
    font: { body: 'var(--blog-font), system-ui, sans-serif' },
    size: { measure: "42rem" },
    space: { gap: "1.5rem", section: "3.5rem" },
    radius: { card: "0.5rem" },
  },
  singletons: ["site-menu"],
  queries: { home: { posts: { collection: "blog-posts", sort: "-publishedAt", perPage: 20, paged: true, fields: "id,title,excerpt,publishedAt", urls: "1" } } },
});
