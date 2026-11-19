import { defineTheme, type ThemeQuery } from "tansy/theme";
import { z } from "zod";
import schema from "./schema.json";

export interface AcademyOptions {
  /** Replaces the words under the front page's heading. Owners can also change them per language under Languages → Site text. */
  tagline?: string;
  /** "auto" follows the visitor's light or dark setting. "light" always shows the light colours. */
  colorScheme: "auto" | "light";
}

const options = z.object({
  tagline: z.string().max(300).optional(),
  colorScheme: z.enum(["auto", "light"]),
});

/**
 * Every course, for the catalogue and for what each plan opens. All fields, rather than a list,
 * so a course's "Included in" field comes too under whatever name the owner gave it, and a site
 * without the Payments plugin, which has no such field, reads the same.
 */
const COURSES: ThemeQuery = { collection: "lms-courses", sort: "-publishedAt", perPage: 200, urls: "1" };

/** Plans and what they open, from the Payments plugin. Public, for pricing pages. Without Payments, empty lists. */
const PLANS: Record<string, ThemeQuery> = {
  plans: { collection: "payments-plans", filter: 'status = "published"', perPage: 50, fields: "id,name,title,description,amount,annualAmount,currency,featured,includes" },
  access: { collection: "payments-access", filter: 'status = "published"', perPage: 200, fields: "id,name,description,collections" },
};

/** The pages the header links to, by their own addresses, so they follow the URL patterns the owner sets. */
const NAV: Record<string, ThemeQuery> = {
  pricingPage: { collection: "academy-pricing", perPage: 1, fields: "id", urls: "1" },
  myCoursesPage: { collection: "lms-my-courses", perPage: 1, fields: "id", urls: "1" },
};

/**
 * A school's site, for the LMS plugin: a front page with the catalogue and the plans, a course
 * page with what it covers and how to take it, and a pricing page. Plans come from the Payments
 * plugin when it's installed: each shows the courses it opens, worked out from the data, so a
 * plan or course added in the dashboard appears without touching the theme.
 */
export const academy = ({ tagline, colorScheme = "auto" }: Partial<AcademyOptions> = {}) => defineTheme<AcademyOptions>({
  name: "academy",
  version: "0.1.0",
  apiVersion: 1,
  render: "@tansy/theme-academy/render",
  requires: { plugins: ["lms"] },
  options: { schema: options, value: { tagline, colorScheme } },
  schema,
  tokens: {
    color: {
      page: "#f7f7fb",
      surface: "#ffffff",
      text: "#141428",
      muted: "#5d5f78",
      border: "#e3e4ef",
      accent: "#4f46e5",
      "on-accent": "#ffffff",
    },
    font: {
      body: "ui-sans-serif, system-ui, \"Segoe UI\", Roboto, \"Noto Sans Arabic\", sans-serif",
      heading: "ui-sans-serif, system-ui, \"Segoe UI\", Roboto, \"Noto Sans Arabic\", sans-serif",
    },
    size: { measure: "46rem", wide: "72rem" },
    space: { gutter: "1.25rem", gap: "1.5rem", section: "4.5rem" },
    radius: { card: "1rem", control: "0.625rem" },
    shadow: { card: "0 12px 32px rgba(20, 20, 40, 0.07)" },
  },
  singletons: ["site-menu"],
  queries: {
    home: { ...NAV, ...PLANS, courses: COURSES },
    "academy-pricing": { ...NAV, ...PLANS, courses: COURSES },
    // Beside the LMS's own lists, which its parts read.
    "lms-courses": NAV,
    "lms-lessons": NAV,
    "lms-my-courses": NAV,
    "lms-certificate": NAV,
    default: NAV,
  },
});
