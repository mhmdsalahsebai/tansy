#!/usr/bin/env node
/**
 * Fills the shop demo (demo-shop/) with a small bookstore for the storefront theme. Books come in
 * three formats: printed only (posted, with paperback and hardcover options on some), digital only
 * (a PDF, nothing to post) and both (the printed copy with its PDF). A Readers' Club plan opens the
 * digital editions of some of them in the library at /library, through the Subscriptions plugin.
 * Also categories, a sale, a sold-out book, low stock, shipping zones, the menu, the shop's and the
 * library's words, and orders in every state so the Shop overview has something to show.
 *
 * Every book, author and line in it is made up for the demo.
 *
 * It signs in as the demo's admin from a file whose lines are "URL: …", "Email: …" and
 * "Password: …", .demo-shop-admin (gitignored) unless another is named:
 *
 *   node scripts/demo-shop-content.mjs [admin-file]
 *
 * The Readers' Club charges through the Stripe price in STRIPE_CLUB_PRICE (a test price, price_…)
 * and STRIPE_CLUB_ANNUAL_PRICE, when set. Without them the plan shows but checkout can't start.
 *
 * The demo resets to its baseline every hour, so afterwards run the "Demo reset" workflow with
 * "baseline" for the shop demo, or the next reset puts back what this changed.
 *
 * Safe to run again: categories and books are matched by slug, zones, access and plans by name, and
 * only what is missing is added. Orders are added only while none has been paid. Covers and PDFs are
 * made here, so nothing is downloaded.
 */
import { readFileSync } from "node:fs";
import sharp from "sharp";

const file = readFileSync(new URL(`../${process.argv[2] ?? ".demo-shop-admin"}`, import.meta.url), "utf8");
const field = (name) => file.match(new RegExp(`^${name}:\\s*(.+)$`, "mi"))?.[1].trim();
const base = (field("URL") ?? "").replace(/\/(dashboard.*)?$/, "");
const email = field("Email");
const password = field("Password");
if (!base || !email || !password) throw new Error("The admin file needs URL, Email and Password lines.");

let cookie = "";
async function call(method, path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { origin: base, accept: "application/json", cookie, ...(body && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}), ...headers },
    body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
  });
  const set = response.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = [cookie, ...set.map((one) => one.split(";")[0])].filter(Boolean).join("; ");
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}
const list = async (slug, query = "") => (await call("GET", `/api/collections/${slug}/records?perPage=200${query}`)).items ?? [];
const create = (slug, data) => call("POST", `/api/collections/${slug}/records`, data);
const update = (slug, id, data) => call("PATCH", `/api/collections/${slug}/records/${id}`, data);

const richText = (...paragraphs) => ({ type: "doc", content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) });

/* -------------------------------------------------------------- pictures */

// Flat cut-outs on a transparent background, as the storefront theme prefers: it sets them on its own soft stage.
const shade = (hex, amount) => {
  const n = parseInt(hex.slice(1), 16);
  const channel = (shift) => Math.max(0, Math.min(255, ((n >> shift) & 255) + amount));
  return `rgb(${channel(16)} ${channel(8)} ${channel(0)})`;
};
const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A cover's face, width 440 by 640 from (0, 0): its title, a rule and its author. */
function cover(book, color) {
  const lines = book.cover ?? [book.title];
  const size = lines.some((line) => line.length > 9) ? 50 : 62;
  const top = 250 - ((lines.length - 1) * size * 1.1) / 2;
  return `
    <rect width="440" height="640" rx="10" fill="${color}"/>
    <rect x="28" y="28" width="384" height="584" rx="4" fill="none" stroke="#fff" stroke-opacity="0.35" stroke-width="3"/>
    ${lines.map((line, index) => `<text x="220" y="${top + index * size * 1.1}" font-family="Georgia, serif" font-size="${size}" text-anchor="middle" fill="#fff">${escape(line)}</text>`).join("")}
    <rect x="170" y="${top + lines.length * size * 1.1}" width="100" height="4" rx="2" fill="#fff" fill-opacity="0.6"/>
    <text x="220" y="560" font-family="Helvetica, Arial, sans-serif" font-size="24" letter-spacing="5" text-anchor="middle" fill="#fff" fill-opacity="0.85">${escape(book.author.toUpperCase())}</text>`;
}

/** A printed book standing at a slight turn: the spine and the page edges show. */
const printed = (book, color, x, y, scale = 1) => `
  <g transform="translate(${x} ${y}) scale(${scale})">
    <path d="M440 12 L470 30 L470 652 L440 640 Z" fill="#f4efe4"/>
    <path d="M444 40 L466 54 M444 120 L466 134 M444 200 L466 214" stroke="#d9d0bd" stroke-width="2"/>
    <path d="M-36 20 L0 0 L0 640 L-36 652 Z" fill="${shade(color, -40)}"/>
    ${cover(book, color)}
  </g>`;

/** An e-reader showing the cover. */
const reader = (book, color, x, y, scale = 1) => `
  <g transform="translate(${x} ${y}) scale(${scale})">
    <rect x="-40" y="-50" width="520" height="760" rx="44" fill="#1f2125"/>
    <rect x="-30" y="-40" width="500" height="740" rx="36" fill="none" stroke="#3a3d43" stroke-width="3"/>
    ${cover(book, color)}
    <circle cx="220" cy="676" r="12" fill="#3a3d43"/>
  </g>`;

const shadow = (cx, rx) => `<ellipse cx="${cx}" cy="1070" rx="${rx}" ry="34" fill="#000" fill-opacity="0.12"/>`;

/** The cover, drawn as what the book is: a printed book, an e-reader, or both side by side. */
async function picture(name, book, color) {
  const art =
    book.format === "digital" ? shadow(600, 290) + reader(book, color, 380, 260)
    : book.format === "both" ? shadow(560, 380) + printed(book, color, 230, 250, 1.05) + reader(book, color, 690, 470, 0.72)
    : shadow(600, 280) + printed(book, color, 380, 260);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200">${art}</svg>`;
  const png = new Uint8Array(await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer());
  return (await call("POST", `/api/files/upload?name=${encodeURIComponent(name)}`, png, { "content-type": "image/png" })).id;
}

/** A one-page PDF, written by hand so nothing needs installing: the digital edition buyers and members download. */
function editionPdf(book) {
  const lines = [book.title, `by ${book.author}`, "", ...book.opening, "", "This is the Tansy bookstore demo's digital edition.", "The book and its author are made up for the demo."];
  const text = lines.map((line, index) => `BT /F1 ${index ? 13 : 24} Tf 72 ${730 - index * 26} Td (${line.replace(/[()\\]/g, "\\$&")}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const at = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

/* --------------------------------------------------------------- content */

const CATEGORIES = [
  ["fiction", "Fiction", "Novels to get lost in, from family sagas to small, strange towns."],
  ["mystery", "Mystery", "Locked rooms, cold cases and detectives who don't sleep."],
  ["science-fiction", "Science fiction", "Far stations, near futures and machines with opinions."],
  ["cookery", "Cookery", "Books for the kitchen counter, splashes welcome."],
  ["essays", "Essays & poetry", "Short pieces for the bus, the bath and the last ten minutes before sleep."],
  ["children", "Children's", "Picture books and first chapters, for reading aloud."],
];

const CLUB = "Readers' Club library";

/**
 * Each book: slug, title, author, summary, price, compare-at price, stock, categories, format
 * (physical, digital or both), cover colour and lines, variants [title, price, stock], whether the
 * Readers' Club opens its digital edition, and the first lines of that edition. Physical books are
 * posted; digital ones have a PDF and no address; both are posted and come with the PDF. Stock left
 * empty isn't counted.
 */
const BOOKS = [
  // Printed only.
  { slug: "the-lantern-keeper", title: "The Lantern Keeper", author: "Mara Ellison", summary: "A lighthouse, a missing brother and forty winters of letters nobody posted. In paperback and a cloth hardcover.", price: 16, categories: ["fiction"], format: "physical", color: "#2f4858", cover: ["The Lantern", "Keeper"], variants: [["Paperback", 16, 30], ["Hardcover", 28, 8]] },
  { slug: "salt-and-saffron", title: "Salt and Saffron", author: "Idris Haddad", summary: "Ninety recipes from a family kitchen on the coast, in a lay-flat hardcover. On sale this month.", price: 32, compareAtPrice: 40, stock: 12, categories: ["cookery"], format: "physical", color: "#b5523b", cover: ["Salt and", "Saffron"] },
  { slug: "small-hours", title: "Small Hours", author: "June Okafor", summary: "Poems written between midnight and dawn. The first printing is gone; shows how a sold-out book looks.", price: 14, stock: 0, categories: ["essays"], format: "physical", color: "#5b4b8a" },
  { slug: "the-fox-who-counted-stars", title: "The Fox Who Counted Stars", author: "Pip Larsen", summary: "A picture book about a fox who can't sleep until every star is counted. Only a few left.", price: 12, stock: 3, categories: ["children"], format: "physical", color: "#d17a22", cover: ["The Fox Who", "Counted", "Stars"] },
  // Digital only.
  { slug: "signal-at-kepler-station", title: "Signal at Kepler Station", author: "R. T. Vance", summary: "Six people, one station and a message that arrives a day before it was sent. A digital edition, yours to download the moment you've paid, and free for Readers' Club members.", price: 7, categories: ["science-fiction"], format: "digital", color: "#1d3557", cover: ["Signal at", "Kepler", "Station"], club: true, opening: ["The message came in at 04:12, station time,", "which was strange, because nobody had sent it yet."] },
  { slug: "seven-doors-in-lisbon", title: "Seven Doors in Lisbon", author: "Ana Corvo", summary: "An inspector, a tram line and seven doors that open onto the same room. Digital, and in the Readers' Club.", price: 6, categories: ["mystery"], format: "digital", color: "#7a3e48", cover: ["Seven Doors", "in Lisbon"], club: true, opening: ["Inspector Reis counted the doors twice.", "Seven, and every one of them was locked from inside."] },
  { slug: "notes-on-slow-reading", title: "Notes on Slow Reading", author: "Theo Marchetti", summary: "Twelve short essays on reading less, and better. Digital, and in the Readers' Club.", price: 5, categories: ["essays"], format: "digital", color: "#3f6b4f", cover: ["Notes on", "Slow", "Reading"], club: true, opening: ["Begin with one page. Read it twice.", "The second time, notice what you missed the first."] },
  { slug: "the-clockwork-orchard", title: "The Clockwork Orchard", author: "Lena Hart", summary: "Brass trees, a gardener who winds them, and the year they stop. Digital only, bought on its own.", price: 8, categories: ["science-fiction"], format: "digital", color: "#8a6f2f", cover: ["The", "Clockwork", "Orchard"], opening: ["Every morning Ilse wound the trees, one key each,", "until the morning one of them wound itself."] },
  // Printed, with the digital edition.
  { slug: "the-glass-archive", title: "The Glass Archive", author: "Noor Bakri", summary: "A librarian finds a book that records what happens in the library, an hour before it does. Posted in paperback with its PDF; Readers' Club members read the PDF for free.", price: 18, categories: ["mystery"], format: "both", color: "#2a6f75", cover: ["The Glass", "Archive"], club: true, opening: ["The entry for 3 p.m. read: Mira will drop the lamp.", "It was 2 p.m., and Mira was holding the lamp."] },
  { slug: "winter-in-valdane", title: "Winter in Valdane", author: "Elise Brandt", summary: "A snowed-in village and the family who runs its only inn. Paperback or hardcover, each with the PDF, which is also in the Readers' Club.", price: 17, categories: ["fiction"], format: "both", color: "#4a5a7a", cover: ["Winter in", "Valdane"], club: true, variants: [["Paperback", 17, 24], ["Hardcover", 30, 6]], opening: ["The snow came on the ninth of December", "and did not leave Valdane until the spring."] },
  { slug: "rivers-remember", title: "Rivers Remember", author: "Sami Oduya", summary: "Poems about the rivers of one long walk, in paperback with its PDF.", price: 15, stock: 20, categories: ["essays"], format: "both", color: "#2f6690", cover: ["Rivers", "Remember"], opening: ["The river does not forget the rain,", "it only carries it somewhere else."] },
  { slug: "atlas-of-invented-cities", title: "Atlas of Invented Cities", author: "Ines Varga", summary: "Thirty cities that never were, drawn and described. A large hardcover with its PDF, on sale.", price: 36, compareAtPrice: 45, stock: 9, categories: ["fiction"], format: "both", color: "#9c4f2e", cover: ["Atlas of", "Invented", "Cities"], opening: ["Merrow is built on the backs of sleeping whales.", "Its people speak softly, and move house often."] },
];

const ZONES = [
  { name: "United States", countries: ["US"], rate: 5, freeOver: 50 },
  { name: "Europe", countries: ["GB", "IE", "FR", "DE", "NL", "BE", "ES", "IT", "PT", "AT", "DK", "SE", "FI", "NO", "PL"], rate: 9, freeOver: 80 },
  { name: "Everywhere", countries: ["*"], rate: 15, freeOver: null },
];

/* ------------------------------------------------------------------- run */

console.log(`Signing in to ${base} as ${email}…`);
const signedIn = await call("POST", "/api/auth/sign-in/email", { email, password });
if (signedIn?.twoFactorRedirect) throw new Error("This account asks for a second factor. Turn it off for the demo admin.");

// The site's name and a deep red accent, which the storefront's buttons and chips take.
const { settings } = await call("GET", "/api/settings/auth");
if (settings.general.appName !== "Tansy Books") {
  await call("PUT", "/api/settings/auth", { ...settings, general: { ...settings.general, appName: "Tansy Books", accentColor: "#7a3e48" } });
  console.log("Site: named Tansy Books.");
}

// The shop's words.
const [store] = await list("shop-store");
if (store) {
  await update("shop-store", store.id, {
    title: "Tansy Books",
    intro: richText("Printed books, digital editions and both together, and a Readers' Club that opens some of them for free. A demo store: pay with Stripe's test card 4242 4242 4242 4242, any future date and any CVC."),
  });
  console.log("Shop page: words set.");
}
const [cart] = await list("shop-cart");
if (cart) await update("shop-cart", cart.id, { title: "Your basket", intro: richText("This is a demo: nothing is charged and nothing is sent. Use the test card 4242 4242 4242 4242.") });
const [account] = await list("shop-account");
if (account) await update("shop-account", account.id, { title: "Your orders", intro: richText("Orders you've placed, their tracking, and your digital editions once paid.") });

// Shipping zones by name. The shop's own "Everywhere" zone is kept and given a rate.
const zones = new Map((await list("shop-shipping-zones")).map((zone) => [zone.name, zone]));
for (const zone of ZONES) {
  const existing = zones.get(zone.name);
  if (existing) await update("shop-shipping-zones", existing.id, zone);
  else await create("shop-shipping-zones", zone);
  console.log(`Shipping zone: ${zone.name}`);
}

// The membership: an access the Readers' Club plan includes. Subscribing grants it, and the
// library's files open to whoever holds it.
let [club] = await list("payments-access", `&filter=${encodeURIComponent(`name = "${CLUB}"`)}`);
club ??= await create("payments-access", { name: CLUB, description: "The digital editions of the books marked Readers' Club, to read and download.", status: "published" });
const [plan] = await list("payments-plans", `&filter=${encodeURIComponent('name = "club"')}`);
const planData = {
  name: "club",
  priceId: process.env.STRIPE_CLUB_PRICE || "price_readers_club_monthly",
  annualPriceId: process.env.STRIPE_CLUB_ANNUAL_PRICE || "price_readers_club_yearly",
  title: "Readers' Club",
  description: "Read every Readers' Club book's digital edition for free while you're a member. Cancel any time.",
  amount: 9,
  annualAmount: 90,
  featured: true,
  includes: [club.id],
  status: "published",
};
if (plan) await update("payments-plans", plan.id, planData);
else await create("payments-plans", planData);
console.log("Membership: Readers' Club.");

// Categories by slug.
const categoryIds = new Map((await list("shop-categories", "&fields=id,slug")).map((category) => [category.slug, category.id]));
for (const [slug, name, description] of CATEGORIES) {
  if (categoryIds.has(slug)) continue;
  const created = await create("shop-categories", { slug, name, description, status: "published" });
  categoryIds.set(slug, created.id);
  console.log(`Category: ${name}`);
}

// Books and their variants by slug. A digital edition is the product's download, and for a book in
// the Readers' Club also a library file, which only members can open.
const productIds = new Map((await list("shop-products", "&fields=id,slug")).map((product) => [product.slug, product.id]));
for (const book of BOOKS) {
  if (productIds.has(book.slug)) continue;
  const images = [await picture(`${book.slug}.png`, book, book.color)];
  const download = book.format === "physical"
    ? undefined
    : (await call("POST", `/api/files/upload?name=${encodeURIComponent(`${book.slug}.pdf`)}`, editionPdf(book), { "content-type": "application/pdf" })).id;
  const created = await create("shop-products", {
    title: book.title,
    slug: book.slug,
    summary: `${book.author}. ${book.summary}`,
    price: book.price,
    ...(book.compareAtPrice ? { compareAtPrice: book.compareAtPrice } : {}),
    ...(book.stock !== undefined ? { stock: book.stock } : {}),
    sku: book.slug.toUpperCase().replace(/-/g, "").slice(0, 10),
    shipping: book.format !== "digital",
    format: book.format,
    images,
    categories: book.categories.map((slug) => categoryIds.get(slug)),
    ...(download ? { download } : {}),
    ...(book.club ? { membership: [club.id] } : {}),
    status: "published",
  });
  productIds.set(book.slug, created.id);
  for (const [position, [title, price, stock]] of (book.variants ?? []).entries()) {
    await create("shop-variants", { product: created.id, title, price, stock, position, sku: `${created.sku ?? ""}-${position + 1}`, status: "published" });
  }
  if (book.club && download) await create("library-files", { product: created.id, label: "PDF", file: download, included: [club.id], status: "published" });
  console.log(`Book: ${book.title} (${book.format}${book.club ? ", Readers' Club" : ""})`);
}

// The library's words.
const libraryData = {
  title: "The library",
  intro: richText("Join the Readers' Club and read the digital edition of every book marked for it, free while you're a member. Printed books are still bought from the shop, and digital editions not in the club can be bought on their own."),
  status: "published",
};
const [library] = await list("library");
if (library) await update("library", library.id, libraryData);
else await create("library", libraryData);
console.log("Library page: words set.");

// The menu: the shop, three shelves, the library and the orders page.
const [menu] = await list("site-menu");
const menuVersion = (await call("GET", "/api/block-types")).find?.((type) => type.name === "menu_item")?.version ?? 1;
const link = (id, label, url) => ({ id, type: "menu_item", v: menuVersion, value: { label, url } });
const items = [link("shop", "Shop", "/shop"), link("fiction", "Fiction", "/shop/category/fiction"), link("mystery", "Mystery", "/shop/category/mystery"), link("science-fiction", "Science fiction", "/shop/category/science-fiction"), link("library", "Library", "/library"), link("orders", "Orders", "/orders")];
if (menu) await update("site-menu", menu.id, { items, status: "published" });
else await create("site-menu", { items, status: "published" });
console.log("Menu: set.");

// Orders in every state, placed through the shop's own checkout route as the admin, then moved on
// as staff would. Only while none has been paid, so a second run adds no more.
if ((await list("shop-orders", `&fields=id&filter=${encodeURIComponent('state != "pending" && state != "cancelled"')}`)).length === 0) {
  const variantsOf = async (slug) => list("shop-variants", `&filter=${encodeURIComponent(`product = ${productIds.get(slug)}`)}&fields=id,title&sort=position`);
  const lantern = await variantsOf("the-lantern-keeper");
  const valdane = await variantsOf("winter-in-valdane");
  const line = (slug, quantity = 1, variant) => ({ product: productIds.get(slug), quantity, ...(variant ? { variant: variant.id } : {}) });
  const address = (name, line1, city, postalCode, region) => ({ name, line1, city, postalCode, ...(region ? { region } : {}) });
  const ORDERS = [
    { items: [line("the-lantern-keeper", 1, lantern[1]), line("salt-and-saffron")], country: "US", address: address("Ada Example", "12 Reading Lane", "Portland", "97201", "OR"), then: ["paid", "shipped", "delivered"] },
    { items: [line("winter-in-valdane", 1, valdane[0]), line("rivers-remember")], country: "GB", address: address("Sam Sample", "4 Chapter Row", "Bristol", "BS1 4DJ"), then: ["paid", "shipped"] },
    { items: [line("atlas-of-invented-cities"), line("the-fox-who-counted-stars", 2)], country: "DE", address: address("Kim Muster", "Buchweg 8", "Berlin", "10115"), then: ["paid"] },
    { items: [line("the-clockwork-orchard"), line("seven-doors-in-lisbon")], then: ["paid"] },
    { items: [line("the-glass-archive"), line("the-lantern-keeper", 1, lantern[0])], country: "US", address: address("Lee Placeholder", "88 Margin Ave", "Austin", "73301", "TX"), then: ["paid"] },
    { items: [line("salt-and-saffron")], country: "CA", address: address("Jo Testcase", "21 Spine St", "Toronto", "M5V 2T6", "ON"), then: [] },
  ];
  for (const { then, ...order } of ORDERS) {
    const { order: created } = await call("POST", "/api/ext/shop/orders", order);
    for (const state of then) {
      if (state === "paid") await update("shop-orders", created.id, { state });
      else await call("POST", `/api/ext/shop/orders/${created.id}/status`, { state, ...(state === "shipped" ? { trackingUrl: "https://example.com/track/TANSY123" } : {}) });
    }
    console.log(`Order ${created.id}: ${then.at(-1) ?? "pending"}`);
  }
} else console.log("Orders: already there.");

console.log("Done.");
