import { defineTheme, type ThemeQuery } from "tansy/theme";
import { z } from "zod";
import schema from "./schema.json";

export interface MagazineOptions {
  /** Replaces the words under the home page's heading. Owners can also change them per language under Languages → Site text. */
  tagline?: string;
  showDates: boolean;
  /** Sign in and Register buttons in the header, for sites whose visitors have accounts, such as for comments. */
  accountLinks: boolean;
  /** The search box on the home page. It searches posts through the records API, as a visitor. */
  search: boolean;
  /** "auto" follows the visitor's light or dark setting. "light" always shows the light colours. */
  colorScheme: "auto" | "light";
}

const options = z.object({
  tagline: z.string().max(300).optional(),
  showDates: z.boolean(),
  accountLinks: z.boolean(),
  search: z.boolean(),
  colorScheme: z.enum(["auto", "light"]),
});

/** What a card shows. Kept short, as every list here is read on every visit. */
const CARD_FIELDS = "id,title,excerpt,publishedAt,cover,categories,readingMinutes,featured";
const CARD = { collection: "blog-posts", sort: "-publishedAt", fields: CARD_FIELDS, urls: "1" } as const satisfies ThemeQuery;
/** Thumbnails in the sidebar. */
const ROW = { collection: "blog-posts", sort: "-publishedAt", fields: "id,title,publishedAt,cover", urls: "1" } as const satisfies ThemeQuery;
const CATEGORIES: ThemeQuery = { collection: "blog-categories", perPage: 200, fields: "id,name", urls: "1" };
const PER_PAGE = 9;

/** The front page, at the site's root and at the blog's own address. */
const FRONT: Record<string, ThemeQuery> = {
  posts: { ...CARD, perPage: PER_PAGE, paged: true },
  featured: { ...ROW, filter: "featured = true", perPage: 3 },
  latest: { ...ROW, perPage: 4 },
  categories: CATEGORIES,
};

/** A category's or tag's page. `posts` replaces the blog plugin's list of the same name, to add covers. */
const archive = (filter: string): Record<string, ThemeQuery> => ({
  posts: { ...CARD, filter, perPage: PER_PAGE, paged: true },
  latest: { ...ROW, perPage: 4 },
  categories: CATEGORIES,
});

/**
 * A magazine look for the blog plugin: a hero with search, posts as image cards, and a sidebar
 * of featured and latest posts. The post page is built from the plugin's parts, so comments,
 * tags and related posts behave as they do on the plugin's own page.
 */
export const magazine = ({ tagline, showDates = true, accountLinks = true, search = true, colorScheme = "auto" }: Partial<MagazineOptions> = {}) => defineTheme<MagazineOptions>({
  name: "magazine",
  version: "0.1.0",
  apiVersion: 1,
  render: "@tansy/theme-magazine/render",
  requires: { plugins: ["blog"] },
  options: { schema: options, value: { tagline, showDates, accountLinks, search, colorScheme } },
  schema,
  tokens: {
    color: {
      page: "#ffffff",
      surface: "#f5f7fa",
      text: "#101828",
      muted: "#5d6779",
      border: "#e6e9ef",
      accent: "#2563eb",
      "on-accent": "#ffffff",
    },
    font: { body: "var(--magazine-font), system-ui, sans-serif" },
    size: { measure: "44rem", wide: "76rem" },
    space: { gutter: "1.25rem", gap: "1.5rem", section: "4rem" },
    radius: { card: "1rem", control: "0.625rem" },
    shadow: { card: "0 12px 32px rgba(16, 24, 40, 0.10)" },
  },
  singletons: ["site-menu"],
  queries: {
    home: FRONT,
    "blog-home": FRONT,
    "blog-posts": {
      // Beside the plugin's own lists, which its parts read: these carry covers for cards.
      moreCards: { ...CARD, filter: "tags ?= @record.tags && id != @record.id", perPage: 3 },
      latestCards: { ...CARD, filter: "id != @record.id", perPage: 3 },
    },
    "blog-categories": archive("categories ?= @record.id"),
    "blog-tags": archive("tags ?= @record.id"),
  },
});
