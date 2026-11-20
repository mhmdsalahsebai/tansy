import { expect, test, type Browser, type Page } from "@playwright/test";

const EMAIL = "e2e-admin@example.test";
const PASSWORD = "plum-Harbor-kettle-93-lantern";
const PAGES = ["/dashboard", "/dashboard/collections", "/dashboard/blocks", "/dashboard/files", "/dashboard/schema", "/dashboard/webhooks", "/dashboard/redirects", "/dashboard/users", "/dashboard/roles", "/dashboard/audit", "/dashboard/logs", "/dashboard/settings", "/dashboard/extensions", "/dashboard/account"];

test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  await page.goto("/dashboard/auth/signin");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/dashboard(?!\/auth)/);
}

async function signedInPage(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page);
  return page;
}

const sameOrigin = (page: Page) => ({ origin: new URL(page.url()).origin });

let collectionId: number;

test("first-run setup creates the superadmin", async ({ page }) => {
  await page.goto(`/dashboard/auth/setup?token=${process.env.E2E_SETUP_TOKEN}`);
  await page.screenshot({ path: "test-results/screens/setup.png", fullPage: true });
  await page.getByLabel("Name").fill("E2E Admin");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create superadmin" }).click();
  await page.waitForURL(/\/signin/);
  await page.screenshot({ path: "test-results/screens/signin.png", fullPage: true });
});

test("a collection can be created in the dashboard", async ({ browser }) => {
  const page = await signedInPage(browser);
  await page.goto("/dashboard/collections/create");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Smoke posts");
  await page.getByRole("button", { name: "Create collection" }).click();
  await page.waitForURL((url) => url.pathname !== "/dashboard/collections/create");
  const listed = await page.request.get("/api/collections");
  expect(listed.ok()).toBe(true);
  const body = await listed.json() as Array<{ id: number; slug: string }> | { items: Array<{ id: number; slug: string }> };
  const created = (Array.isArray(body) ? body : body.items).find((c) => c.slug === "smoke-posts");
  expect(created).toBeTruthy();
  collectionId = created!.id;
  const fields = await page.request.put(`/api/collections/${collectionId}/fields`, { headers: sameOrigin(page), data: { fields: [{ name: "title", type: "text" }] } });
  expect(fields.ok(), await fields.text()).toBe(true);
  await page.context().close();
});

test("every dashboard page renders without errors", async ({ browser }) => {
  const page = await signedInPage(browser);
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`${page.url()}: ${error.message}`));
  page.on("response", (response) => { if (response.status() >= 500) problems.push(`${response.status()} ${response.url()}`); });
  // Pages beyond PAGES, which also drives the reference screenshots below.
  for (const path of [...PAGES, "/dashboard/trash", `/dashboard/collections/${collectionId}/schema`, `/dashboard/collections/${collectionId}/rules`, `/dashboard/collections/${collectionId}`, `/dashboard/collections/${collectionId}/import`]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: `test-results/screens/${path.replace(/\W+/g, "_")}.png`, fullPage: true });
  }
  expect(problems).toEqual([]);
  await page.context().close();
});


test("the shell stays mounted between pages, and a page loads only its own code", async ({ browser }) => {
  const page = await signedInPage(browser);
  const scripts = new Map<string, string>();
  page.on("response", async (response) => { if (response.url().includes(".js")) scripts.set(response.url(), await response.text().catch(() => "")); });
  const editorLoaded = () => [...scripts.values()].some((code) => code.includes("ProseMirror"));

  await page.goto("/dashboard/audit", { waitUntil: "networkidle" });
  expect(editorLoaded(), "the rich text editor's code should stay off a page that has no editor").toBe(false);
  await page.evaluate(() => { (window as unknown as { shell: Element | null }).shell = document.querySelector("nav"); });
  await page.getByRole("link", { name: "Roles", exact: true }).first().click();
  await page.waitForURL(/\/dashboard\/roles/);
  expect(await page.evaluate(() => (window as unknown as { shell?: Element | null }).shell?.isConnected), "navigating replaced the shell").toBe(true);

  scripts.clear();
  await page.goto(`/dashboard/collections/${collectionId}/content/new`, { waitUntil: "networkidle" });
  expect(editorLoaded(), "the record editor should load its own code").toBe(true);
  await page.context().close();
});

test("a second browser sees a new record live", async ({ browser }) => {
  const writer = await signedInPage(browser);
  const viewer = await signedInPage(browser);
  await viewer.goto(`/dashboard/collections/${collectionId}`);
  await viewer.waitForLoadState("networkidle");
  const created = await writer.request.post("/api/collections/smoke-posts/records", { headers: sameOrigin(writer), data: { title: "Arrives live", status: "draft" } });
  expect(created.ok(), await created.text()).toBe(true);
  await expect(viewer.getByText("Arrives live")).toBeVisible({ timeout: 15_000 });
  await writer.context().close();
  await viewer.context().close();
});

test("a reference field is filled by searching for a record", async ({ browser }) => {
  const page = await signedInPage(browser);
  const headers = sameOrigin(page);
  const author = await page.request.post("/api/collections", { headers, data: { name: "Authors", slug: "authors", fields: [{ name: "name", type: "text" }] } });
  expect(author.ok(), await author.text()).toBe(true);
  const authors = await author.json() as { id: number };
  const book = await page.request.post("/api/collections", { headers, data: { name: "Books", slug: "books", fields: [{ name: "author", type: "reference", config: { collection: authors.id } }] } });
  expect(book.ok(), await book.text()).toBe(true);
  const books = await book.json() as { id: number };
  for (const name of ["Ada Lovelace", "Grace Hopper"]) {
    const created = await page.request.post("/api/collections/authors/records", { headers, data: { name, status: "published" } });
    expect(created.ok(), await created.text()).toBe(true);
  }
  await page.goto(`/dashboard/collections/${books.id}/content/new`);
  await page.getByPlaceholder("Search records…").fill("Grace");
  await page.getByRole("button", { name: /Grace Hopper/ }).click();
  await expect(page.getByText(/Grace Hopper \(#2\)/)).toBeVisible();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  // Creating a record keeps the editor open, at the new record's own address.
  await page.waitForURL(new RegExp(`/dashboard/collections/${books.id}/content/\\d+$`));
  const saved = await (await page.request.get("/api/collections/books/records")).json() as { items: Array<{ author: number }> };
  expect(saved.items[0].author).toBe(2);
  await page.context().close();
});

test("the CAPTCHA appears on the reset form and its answer is sent", async ({ page }) => {
  await page.route("**/turnstile/v0/api.js*", (route) => route.fulfill({ contentType: "text/javascript", body: 'window.turnstile = { render(element, options) { element.textContent = "widget shown"; options.callback("answer-from-widget"); return "1"; }, reset() {} };' }));
  await page.goto("/dashboard/auth/forgot-password");
  await expect(page.getByText("widget shown")).toBeVisible();
  await page.getByLabel("Email").fill(EMAIL);
  const sent = page.waitForRequest("**/api/auth/request-password-reset");
  await page.getByRole("button", { name: "Send reset link" }).click();
  expect((await sent).headers()["x-captcha-response"]).toBe("answer-from-widget");
  await expect(page.getByText(/a reset link is on its way/)).toBeVisible();
});

test("a record panel plugin shows unsaved values in a live preview", async ({ browser }) => {
  const page = await signedInPage(browser);
  await page.route("http://localhost:3459/**", (route) => route.fulfill({ contentType: "text/html", body: '<body><p id="out">waiting</p><script>addEventListener("message", (e) => { if (e.data.type === "cms:preview") document.getElementById("out").textContent = "title: " + e.data.values.title; });</script></body>' }));
  await page.goto(`/dashboard/collections/${collectionId}/content/new`);
  await page.getByRole("button", { name: "Show live preview" }).click();
  await page.getByLabel("title").fill("Typed but not saved");
  await expect(page.frameLocator('iframe[title="Live preview"]').getByText("title: Typed but not saved")).toBeVisible();
  await page.context().close();
});

/**
 * For checking a styling change. Set E2E_VISUAL=1, run once with --update-snapshots
 * before the change to make the references, and again after it to compare.
 */
test("pages match their reference screenshots", async ({ browser }) => {
  test.skip(!process.env.E2E_VISUAL, "Only when checking a styling change.");
  test.setTimeout(300_000);
  const page = await signedInPage(browser);
  const headers = sameOrigin(page);
  const block = await page.request.post("/api/block-types", { headers, data: { name: "hero", label: "Hero", icon: "photo", fields: [{ name: "heading", type: "text", config: { required: true } }, { name: "body", type: "rich_text" }, { name: "link", type: "url" }] } });
  expect(block.ok(), await block.text()).toBe(true);
  const blockId = (await block.json() as { id: number }).id;
  const made = await page.request.post("/api/collections", { headers, data: { name: "Articles", slug: "articles", fields: [{ name: "title", type: "text", config: { required: true, description: "Shown as the page heading" } }, { name: "summary", type: "rich_text" }, { name: "featured", type: "boolean" }, { name: "cover", type: "image" }, { name: "kind", type: "radio", config: { options: [{ label: "News", value: "news" }, { label: "Guide", value: "guide" }] } }, { name: "published_on", type: "date" }, { name: "body", type: "stream" }] } });
  expect(made.ok(), await made.text()).toBe(true);
  const articles = (await made.json() as { id: number }).id;
  const stored = await page.request.post("/api/collections/articles/records", { headers, data: { title: "First article", status: "published", kind: "news", body: [{ id: "block-one", type: "hero", v: 1, value: { heading: "Welcome", link: "https://example.com/" } }] } });
  expect(stored.ok(), await stored.text()).toBe(true);
  const record = (await stored.json() as { id: number }).id;

  const paths = [...PAGES, "/dashboard/collections/create", "/dashboard/collections/create-view", "/dashboard/blocks/new", `/dashboard/blocks/${blockId}`, "/dashboard/users/fields",
    `/dashboard/collections/${articles}`, `/dashboard/collections/${articles}/schema`, `/dashboard/collections/${articles}/rules`, `/dashboard/collections/${articles}/content/new`, `/dashboard/collections/${articles}/content/${record}`];
  // Their rows hold times and ids that change on every run.
  const changing = new Set(["/dashboard/audit", "/dashboard/logs"]);
  const compare = async (name: string, mask = false) => {
    for (const [label, size] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 375, height: 800 }]] as const) {
      await page.setViewportSize(size);
      await page.waitForTimeout(150);
      if (label === "phone") expect.soft(await page.evaluate(() => document.documentElement.scrollWidth), `${name} scrolls sideways on a phone`).toBeLessThanOrEqual(375);
      await expect.soft(page).toHaveScreenshot(`${name}-${label}.png`, { fullPage: true, animations: "disabled", maxDiffPixelRatio: 0.01, timeout: 20_000, mask: mask ? [page.locator("tbody")] : [] });
    }
  };
  for (const path of paths) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await compare(path.replace(/\W+/g, "_"), changing.has(path));
  }
  // Not compared with anything: these are for looking at the dark theme.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  for (const path of ["/dashboard", "/dashboard/settings", `/dashboard/collections/${articles}`, `/dashboard/collections/${articles}/content/${record}`, "/dashboard/blocks/new"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: `test-results/screens/dark${path.replace(/\W+/g, "_")}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "light" });

  await page.goto("/dashboard/blocks");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Delete" }).last().click();
  await compare("modal");

  const visitor = await (await browser.newContext()).newPage();
  for (const path of ["/dashboard/auth/signin", "/dashboard/auth/forgot-password"]) {
    await visitor.goto(path);
    await visitor.waitForLoadState("networkidle");
    await visitor.setViewportSize({ width: 1440, height: 900 });
    await expect.soft(visitor).toHaveScreenshot(`${path.slice(1)}-desktop.png`, { fullPage: true, animations: "disabled", maxDiffPixelRatio: 0.01 });
  }
  await visitor.context().close();
  await page.context().close();
});

test("a singleton stops offering new items once it has its record", async ({ browser }) => {
  const page = await signedInPage(browser);
  await page.goto("/dashboard/collections/create");
  await page.getByLabel("Type").selectOption("singleton");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Site settings");
  await page.getByLabel("URL pattern").fill("/settings-page");
  await page.getByRole("button", { name: "Create collection" }).click();
  await page.waitForURL((url) => url.pathname !== "/dashboard/collections/create");
  await expect(page.getByRole("link", { name: "New item" })).toBeVisible();
  const saved = await page.request.post("/api/collections/site-settings/records", { headers: sameOrigin(page), data: { status: "published" } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Site settings" })).toBeVisible();
  await expect(page.getByRole("link", { name: "New item" })).toHaveCount(0);
  await page.context().close();
});

test("a menu can be created without choosing fields", async ({ browser }) => {
  const page = await signedInPage(browser);
  await page.goto("/dashboard/collections/create");
  await page.getByLabel("Type").selectOption("menu");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Main menu");
  await expect(page.getByLabel("URL pattern")).toHaveCount(0);
  await page.getByRole("button", { name: "Create collection" }).click();
  await page.waitForURL((url) => url.pathname !== "/dashboard/collections/create");
  const collection = await (await page.request.get("/api/collections")).json() as Array<{ slug: string; type: string; fields: Array<{ name: string; config: unknown }> }>;
  const menu = collection.find((candidate) => candidate.slug === "main-menu");
  expect(menu).toMatchObject({ type: "singleton", fields: [{ name: "items", config: { allowedBlocks: ["menu_item"] } }] });
  await page.context().close();
});

test("publishing a changed address offers a redirect", async ({ browser }) => {
  const page = await signedInPage(browser);
  const headers = sameOrigin(page);
  const made = await page.request.post("/api/collections", { headers, data: { name: "Guides", slug: "guides", urlPattern: "/guides/:slug", fields: [{ name: "slug", type: "text", config: { unique: true } }] } });
  expect(made.ok(), await made.text()).toBe(true);
  const { id: guides } = await made.json() as { id: number };
  const stored = await page.request.post("/api/collections/guides/records", { headers, data: { slug: "old-name", status: "published" } });
  expect(stored.ok(), await stored.text()).toBe(true);
  const { id } = await stored.json() as { id: number };

  await page.goto(`/dashboard/collections/${guides}/content/${id}`);
  await page.getByLabel("slug").fill("new-name");
  await page.getByRole("button", { name: "Publish changes" }).click();
  await expect(page.getByText("address changed from /guides/old-name to /guides/new-name")).toBeVisible();
  await page.getByRole("button", { name: "Redirect the old address" }).click();
  await page.waitForURL((url) => url.pathname === `/dashboard/collections/${guides}`);

  const resolved = await (await page.request.get("/api/resolve?path=/guides/old-name")).json();
  expect(resolved).toEqual({ type: "redirect", to: "/guides/new-name", status: 301 });
  await page.context().close();
});
