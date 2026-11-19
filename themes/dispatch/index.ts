import { defineTheme, type ThemeQuery } from "tansy/theme";
import { z } from "zod";
import schema from "./schema.json";

export interface DispatchOptions {
  /** Replaces the words under the masthead. Owners can also change them per language under Languages → Site text. */
  tagline?: string;
  showDates: boolean;
  /** The sign-up forms ask for a name as well as the address. */
  askName: boolean;
  /** "auto" follows the visitor's light or dark setting. "light" always shows the light colours. */
  colorScheme: "auto" | "light";
}

const options = z.object({
  tagline: z.string().max(300).optional(),
  showDates: z.boolean(),
  askName: z.boolean(),
  colorScheme: z.enum(["auto", "light"]),
});

/** What an issue in a list shows. Kept short, as every list here is read on every visit. */
const ISSUE = { collection: "blog-posts", sort: "-publishedAt", fields: "id,title,excerpt,publishedAt,readingMinutes", urls: "1" } as const satisfies ThemeQuery;
const PER_PAGE = 12;
/** The newsletter's page, for its address, which the owner can change. Every page reads it, for the header's Subscribe button. */
const NEWSLETTER: ThemeQuery = { collection: "newsletter-page", perPage: 1, fields: "id", urls: "1" };

/** The front page, at the site's root and at the blog's own address. `posts` replaces the blog plugin's list of the same name. */
const FRONT: Record<string, ThemeQuery> = { newsletter: NEWSLETTER, posts: { ...ISSUE, perPage: PER_PAGE, paged: true } };

const archive = (filter: string): Record<string, ThemeQuery> => ({ newsletter: NEWSLETTER, posts: { ...ISSUE, filter, perPage: PER_PAGE, paged: true } });

/**
 * A newsletter look, for the newsletter plugin with the blog plugin's posts as its issues: a
 * masthead with the sign-up form, issues numbered newest first, an issue page made for reading
 * that ends with the form again, and the newsletter's own page for confirming and unsubscribing.
 * The forms are the newsletter plugin's parts, so they behave as on its own page.
 */
export const dispatch = ({ tagline, showDates = true, askName = false, colorScheme = "auto" }: Partial<DispatchOptions> = {}) => defineTheme<DispatchOptions>({
  name: "dispatch",
  version: "0.1.0",
  apiVersion: 1,
  render: "@tansy/theme-dispatch/render",
  requires: { plugins: ["newsletter", "blog"] },
  options: { schema: options, value: { tagline, showDates, askName, colorScheme } },
  schema,
  tokens: {
    color: {
      page: "#fbf8f3",
      surface: "#f3ede3",
      text: "#1f1c18",
      muted: "#6e665b",
      border: "#e4dccf",
      accent: "#c2410c",
      "on-accent": "#ffffff",
    },
    font: {
      body: "var(--dispatch-font), system-ui, sans-serif",
      heading: "ui-serif, Georgia, Cambria, \"Times New Roman\", serif",
    },
    size: { measure: "40rem", wide: "64rem" },
    space: { gutter: "1.25rem", gap: "1.5rem", section: "4rem" },
    radius: { card: "1rem", control: "0.625rem" },
    shadow: { card: "0 10px 30px rgba(31, 28, 24, 0.08)" },
  },
  singletons: ["site-menu"],
  queries: {
    home: FRONT,
    "blog-home": FRONT,
    "blog-categories": archive("categories ?= @record.id"),
    "blog-tags": archive("tags ?= @record.id"),
    // Beside the blog plugin's own lists, which its parts read.
    "blog-posts": { newsletter: NEWSLETTER },
    default: { newsletter: NEWSLETTER },
  },
});
