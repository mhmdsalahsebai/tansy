import { defineTheme, type ThemeQuery } from "tansy/theme";
import { z } from "zod";
import schema from "./schema.json";

export interface HaloOptions {
  /** Shown under the name in the footer. Owners can also change the theme's words per language under Languages → Site text. */
  tagline?: string;
  showDates: boolean;
  /** "4 hours ago" rather than a date, worked out in the visitor's browser so a cached page stays true. */
  relativeDates: boolean;
  /** Sign in and Register links in the header, for sites whose visitors have accounts, such as for comments. */
  accountLinks: boolean;
  /** The search field in the header. It searches posts through the records API, as a visitor. */
  search: boolean;
  /** "auto" follows the visitor's light or dark setting. "light" always shows the light colours. */
  colorScheme: "auto" | "light";
}

const options = z.object({
  tagline: z.string().max(300).optional(),
  showDates: z.boolean(),
  relativeDates: z.boolean(),
  accountLinks: z.boolean(),
  search: z.boolean(),
  colorScheme: z.enum(["auto", "light"]),
});

/** What every story on a front page shows. Kept short, as these lists are read on every visit. */
const STORY_FIELDS = "id,title,excerpt,publishedAt,cover,categories,tags,readingMinutes";
const STORY = { collection: "blog-posts", sort: "-publishedAt", fields: STORY_FIELDS, urls: "1" } as const satisfies ThemeQuery;
/** Names and addresses, so a story's category and tags are links. */
const LOOKUPS: Record<string, ThemeQuery> = {
  categories: { collection: "blog-categories", perPage: 200, fields: "id,name", urls: "1" },
  tags: { collection: "blog-tags", perPage: 200, fields: "id,name", urls: "1" },
  // Where "View more" goes: the blog's own address, from its URL pattern.
  blogHome: { collection: "blog-home", perPage: 1, fields: "id", urls: "1" },
};

/**
 * The front page. The `pick*` lists are the stories an editor chose on the Front page record,
 * bound from its reference fields; on a site that hasn't made that record they return nothing.
 * `featured` and `recent` fill whatever an editor left empty.
 */
const FRONT: Record<string, ThemeQuery> = {
  pickLead: { ...STORY, filter: "id = @record.lead", perPage: 1 },
  pickRecommended: { ...STORY, filter: "id ?= @record.recommended", perPage: 5 },
  pickSpotlight: { ...STORY, filter: "id = @record.spotlight", perPage: 1 },
  pickTrending: { ...STORY, filter: "id ?= @record.trending", perPage: 7 },
  pickReaders: { ...STORY, filter: "id ?= @record.readersChoice", perPage: 9 },
  pickPopular: { ...STORY, filter: "id ?= @record.popular", perPage: 10 },
  featured: { ...STORY, filter: "featured = true", perPage: 10 },
  recent: { ...STORY, perPage: 30 },
  ...LOOKUPS,
};

/** Seven a page: the first leads, the other six fill the grid beside it. */
const PER_PAGE = 7;

/** A paged archive: the blog's home, a category, a tag. */
const archive = (filter?: string): Record<string, ThemeQuery> => ({
  posts: { ...STORY, ...(filter ? { filter } : {}), perPage: PER_PAGE, paged: true },
  ...LOOKUPS,
});

/**
 * A news front page for the blog plugin. The home page's sections are chosen by editors on a
 * Front page record and filled from featured and recent posts where they chose nothing; the
 * post page is built from the plugin's parts, so comments, tags and bylines behave as on the
 * plugin's own page.
 */
export const halo = ({ tagline, showDates = true, relativeDates = true, accountLinks = true, search = true, colorScheme = "auto" }: Partial<HaloOptions> = {}) => defineTheme<HaloOptions>({
  name: "halo",
  version: "0.1.1",
  apiVersion: 1,
  render: "@tansy/theme-halo/render",
  requires: { plugins: ["blog"] },
  options: { schema: options, value: { tagline, showDates, relativeDates, accountLinks, search, colorScheme } },
  schema,
  tokens: {
    color: {
      page: "#eef1f8",
      panel: "#ffffff",
      surface: "#e9edf6",
      text: "#0e1020",
      muted: "#5d6478",
      border: "#e1e5ef",
      accent: "#3450d1",
      "on-accent": "#ffffff",
      glow: "#a995ff",
      ink: "#10111a",
    },
    font: { body: "var(--halo-font), system-ui, sans-serif" },
    size: { wide: "86rem", aside: "22rem", measure: "42rem" },
    space: { gutter: "1rem", gap: "1rem", section: "3.5rem" },
    radius: { panel: "1.5rem", card: "0.875rem", control: "999px", field: "0.875rem" },
    shadow: { float: "0 18px 40px rgba(76, 64, 160, 0.14)" },
  },
  singletons: ["site-menu"],
  queries: {
    home: FRONT,
    "halo-front": FRONT,
    "blog-home": archive(),
    "blog-posts": {
      // Beside the plugin's own lists (categories, tags, comments), which its parts read.
      sideStories: { ...STORY, filter: "id != @record.id", perPage: 5 },
      moreStories: { ...STORY, filter: "tags ?= @record.tags && id != @record.id", perPage: 4 },
      blogHome: LOOKUPS.blogHome,
    },
    "blog-categories": archive("categories ?= @record.id"),
    "blog-tags": archive("tags ?= @record.id"),
  },
});
