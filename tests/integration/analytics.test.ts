/**
 * The analytics plugin, installed the way a site owner would: on in tansy.config.ts and
 * nothing else. Every site page carries the tracker, page views are counted with nothing
 * personal kept, and only people with the plugin's read permission see the numbers.
 */
import { beforeAll, describe, expect, inject, it } from "vitest";

const base = inject("baseUrl");
const PASSWORD = "correct-horse-battery-staple-9431";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

interface Actor { id: string; cookie: string }
let root: Actor, member: Actor;

async function call(path: string, { method = "GET", body, as, headers = {} }: { method?: string; body?: unknown; as?: Actor | null; headers?: Record<string, string> } = {}) {
  const response = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: {
      ...(as ? { origin: base, cookie: as.cookie } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any -- API responses have many shapes
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json, text, headers: response.headers };
}

async function signIn(email: string): Promise<Actor> {
  const r = await call("/api/auth/sign-in/email", { method: "POST", body: { email, password: PASSWORD } });
  expect(r.status, r.text).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).filter((pair) => !pair.endsWith("=")).join("; ");
  return { id: r.json.user.id, cookie };
}

const hit = (body: Record<string, unknown>, ip: string, agent = FIREFOX) =>
  call("/api/ext/analytics/hit", { method: "POST", body: { referrer: null, width: 1280, ...body }, headers: { "user-agent": agent, "x-forwarded-for": ip, "cf-ipcountry": "NL" } });

beforeAll(async () => {
  root = await signIn("root@example.test");
  const created = await call("/api/users", { method: "POST", as: root, body: { name: "statsmember", email: "statsmember@example.test", password: PASSWORD, role: "user" } });
  expect(created.status, created.text).toBe(200);
  member = await signIn("statsmember@example.test");
});

describe("analytics plugin", () => {
  it("puts the tracker on site pages, and lets the page reach every installed provider", async () => {
    const page = await call("/blog");
    expect(page.status).toBe(200);
    expect(page.text).toContain("respectOptOut");
    // No provider is chosen, so no outside script is on the page, only what the policy allows.
    expect(page.text).not.toContain("plausible.io/js");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/connect-src[^;]*https:\/\/plausible\.io/);
    expect(csp).toMatch(/img-src[^;]*https:\/\/www\.google-analytics\.com/);
  });

  it("serves headless sites the same tracker settings, without any key", async () => {
    const tracker = await call("/api/ext/analytics/tracker");
    expect(tracker.status).toBe(200);
    expect(tracker.json).toEqual({ collect: true, provider: null, exclude: [], respectOptOut: true });
  });

  it("shows the numbers only to people with its read permission", async () => {
    expect((await call("/api/ext/analytics/report")).status).toBe(401);
    expect((await call("/api/ext/analytics/report", { as: member })).status).toBe(403);
    expect((await call("/api/ext/analytics/report?days=365", { as: root })).status).toBe(400);
  });

  it("counts people's page views, keeps nothing about them, and leaves programs out", async () => {
    const path = `/stats-${Date.now()}`;
    for (const ip of ["203.0.113.70", "203.0.113.70", "203.0.113.71"]) expect((await hit({ path: `${path}?utm_campaign=x`, referrer: "https://www.example.org/link" }, ip)).status).toBe(204);
    expect((await hit({ path }, "203.0.113.72", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).status).toBe(204);
    expect((await hit({ path: "https://evil.test/" }, "203.0.113.73")).status).toBe(204);
    expect((await hit({ path: 5 }, "203.0.113.73")).status).toBe(400);

    const report = await call("/api/ext/analytics/report?days=7", { as: root });
    expect(report.status, report.text).toBe(200);
    expect(report.json.source).toBe("cms");
    expect(report.json.report.days).toHaveLength(7);
    const pages = report.json.report.pages as Array<{ name: string; count: number }>;
    expect(pages.find((row) => row.name === path)).toEqual({ name: path, count: 3 });
    expect(report.json.report.referrers).toContainEqual({ name: "example.org", count: expect.any(Number) });
    expect(report.json.report.countries).toContainEqual({ name: "NL", count: expect.any(Number) });
    expect(report.text).not.toContain("203.0.113");
    expect(report.text).not.toContain("Firefox/140");
  });

  it("cuts off one address sending far more than a person would", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 62; i++) codes.push((await hit({ path: "/flood" }, "203.0.113.90")).status);
    expect(codes.slice(0, 60).every((code) => code === 204)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});
