import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThemedPage } from "@/components/site/ThemedPage";
import { mergeRenderers, pluginRenderers } from "@/components/stream/StreamField";
import { EMPTY_LIST, loadSitePage, type ResolvedAddress, type SiteReader, type SiteTheme } from "@/core/site/page";
import type { SiteList, SiteRecord } from "tansy/theme";
import { assertThemeManifest } from "@/core/theme/define";
import { tokensProblem } from "@/core/theme/tokens";
import lmsRenderers, { coursePlans } from "../../plugins/lms/render";
import { academy } from "../../themes/academy/index";
import academyComponents, { planCards } from "../../themes/academy/render";

// The LMS's client parts read the address's query, which a page outside Next.js has none of.
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

const plugins = mergeRenderers([pluginRenderers("lms", lmsRenderers)]);
const theme = (options?: Parameters<typeof academy>[0]) => ({ manifest: academy(options), components: academyComponents }) as unknown as SiteTheme;

const SOME = 4;
const EVERY = 5;
const ARTICLES = 1;
const courses = [
  { id: 1, title: "Picked <course>", summary: "In the Basic plan", access: "paid", included: [SOME], level: "beginner", byline: "Ada", recordPath: "/courses/picked" },
  { id: 2, title: "Free course", summary: "For everyone", access: "free", included: null, recordPath: "/courses/free" },
  { id: 3, title: "Invite only", summary: "Staff enroll", access: "enrollment", included: [], recordPath: "/courses/invite" },
];
const plans = [
  { id: 6, name: "all-access", title: "All access", description: "Everything", amount: 29, annualAmount: 290, currency: "usd", featured: true, includes: [EVERY] },
  { id: 5, name: "basic", title: "Basic", description: "A few", amount: 9, currency: "usd", includes: [SOME] },
  // Opens articles, not courses, so it isn't for this site's pricing.
  { id: 1, name: "pro", includes: [ARTICLES] },
];
const access = [
  { id: ARTICLES, name: "Premium articles", collections: [] },
  { id: SOME, name: "Starter courses", collections: [] },
  { id: EVERY, name: "All courses", collections: ["lms-courses"] },
];
const outline = [
  { id: 11, title: "Lesson one", course: 1, section: null, position: 1, preview: true, durationMinutes: 5 },
  { id: 12, title: "Lesson two", course: 1, section: null, position: 2, preview: false, durationMinutes: 10 },
];

const list = (rows: unknown[]): SiteList => ({ page: 1, perPage: 200, totalPages: 1, totalItems: rows.length, items: rows as SiteRecord[] });

function lists(collection: string, entitlements: unknown[]) {
  if (collection === "lms-courses") return list(courses);
  if (collection === "payments-plans") return list(plans);
  if (collection === "payments-access") return list(access);
  if (collection === "payments-entitlements") return list(entitlements);
  if (collection === "academy-pricing") return list([{ id: 1, recordPath: "/plans" }]);
  if (collection === "lms-my-courses") return list([{ id: 1, recordPath: "/my-courses" }]);
  if (collection === "lms-outline") return list(outline);
  return EMPTY_LIST;
}

function reader(pages: Record<string, ResolvedAddress>, entitlements: unknown[] = []): SiteReader {
  const source: SiteReader = {
    resolve: async (at) => pages[at] ?? null,
    list: vi.fn(async (collection: string) => lists(collection, entitlements)) as SiteReader["list"],
    get: async () => null,
    singleton: async () => null,
    branding: async () => ({ name: "The School", logoUrl: "" }),
    preview: async () => null,
    fileUrl: (id, thumb) => `/f/${id}${thumb ? `?thumb=${thumb}` : ""}`,
  };
  return { ...source, viewer: async () => source };
}

async function render(site: SiteTheme, source: SiteReader, at: string) {
  const loaded = await loadSitePage(site, source, at, { renderers: plugins });
  if (loaded.type !== "page") throw new Error(`Expected a page at ${at}, got ${loaded.type}`);
  return { page: loaded, html: renderToStaticMarkup(createElement(ThemedPage, { theme: site, page: loaded, renderers: plugins }) as never) };
}

const coursePage: ResolvedAddress = { type: "record", collection: "lms-courses", path: "/courses/picked", record: courses[0] };

describe("academy theme", () => {
  it("validates its own tokens and options, and needs the LMS plugin", () => {
    expect(tokensProblem(academy().tokens!)).toBeNull();
    expect(() => academy({ colorScheme: "dark" as never })).toThrow();
    expect(() => assertThemeManifest(academy(), [])).toThrow(/"lms" plugin/);
    expect(() => assertThemeManifest(academy(), ["lms"])).not.toThrow();
  });

  it("works out what each plan opens from the data, cheapest first, leaving out plans that open no course", () => {
    const cards = planCards({ courses: list(courses), plans: list(plans), access: list(access) });
    expect(cards.map((card) => card.name)).toEqual(["basic", "all-access"]);
    expect(cards[0]).toMatchObject({ title: "Basic", everything: false, courses: [expect.objectContaining({ id: 1 })] });
    expect(cards[1]).toMatchObject({ title: "All access", everything: true, featured: true });
    expect(cards[1].courses).toHaveLength(3);
  });

  it("shows the catalogue and the plans on the front page", async () => {
    const { html } = await render(theme(), reader({}), "/");
    expect(html).toContain('data-theme="academy"');
    expect(html).toContain("Picked &lt;course&gt;");
    expect(html).toContain('class="ac-course-link" href="/courses/picked"');
    expect(html).toContain("In 2 plans");
    expect(html).toContain("In 1 plan");
    expect(html).toContain("Free");
    expect(html).toContain("$9.00 a month");
    expect(html).toContain("or $290.00 a year");
    expect(html).toContain("Every course, 3 today, and each new one");
    expect(html).toContain("Subscribe to Basic");
    expect(html).not.toContain("Subscribe to pro");
    // The header follows the pages' own addresses.
    expect(html).toContain('href="/plans"');
    expect(html).toContain('href="/my-courses"');
  });

  it("leaves the plans out on a site without them", async () => {
    const source = reader({});
    source.list = vi.fn(async (collection: string) => (collection.startsWith("payments-") ? EMPTY_LIST : lists(collection, []))) as SiteReader["list"];
    const { html } = await render(theme(), source, "/");
    expect(html).toContain("Picked &lt;course&gt;");
    expect(html).not.toContain('id="plans"');
    expect(html).not.toContain("See plans");
  });

  it("offers the plans that include a course on its page, beside buying it", async () => {
    const { page, html } = await render(theme(), reader({ "/courses/picked": coursePage }), "/courses/picked");
    expect(page).toMatchObject({ template: "lms-courses", source: "theme" });
    expect(html).toContain("Or take it with a plan");
    expect(html).toContain("Subscribe to Basic");
    expect(html).toContain("Subscribe to All access");
    expect(html).toContain("Lesson two");
    expect(html).not.toContain("Start with your plan");
  });

  it("lets someone whose plan covers the course start it", async () => {
    const { html } = await render(theme(), reader({ "/courses/picked": coursePage }, [{ access: [SOME] }]), "/courses/picked");
    expect(html).toContain("Start with your plan");
    expect(html).not.toContain("Subscribe to Basic");
    expect(coursePlans(courses[2], { plans: list(plans), access: list(access), entitlements: list([{ access: ["lms-courses"] }]) }).covered).toBe(true);
    expect(coursePlans(courses[2], { plans: list(plans), access: list(access), entitlements: list([{ access: [SOME] }]) }).covered).toBe(false);
  });
});
