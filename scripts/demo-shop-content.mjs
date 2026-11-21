#!/usr/bin/env node
/**
 * Fills the shop demo (demo-shop/) with a small coffee and homeware store for the storefront theme:
 * categories, products with pictures, variants, stock, a sale, a sold-out item, a download-only
 * guide, shipping zones, the menu, the shop's words, and orders in every state so the Shop
 * overview has something to show. It signs in as the demo's admin from a file whose lines are
 * "URL: …", "Email: …" and "Password: …", .demo-shop-admin (gitignored) unless another is named:
 *
 *   node scripts/demo-shop-content.mjs [admin-file]
 *
 * The demo resets to its baseline every hour, so afterwards run the "Demo reset" workflow with
 * "baseline" for the shop demo, or the next reset puts back what this changed.
 *
 * Safe to run again: categories and products are matched by slug, zones by name, and only what is
 * missing is added. Orders are added only while none has been paid. Pictures are drawn here with
 * sharp, so nothing is downloaded.
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
const shadow = `<ellipse cx="600" cy="1060" rx="330" ry="38" fill="#000" fill-opacity="0.12"/>`;

const DRAW = {
  bag: (color, label) => `
    <path d="M330 300 L870 300 L900 1040 L300 1040 Z" fill="${color}"/>
    <path d="M330 300 L870 300 L860 220 L340 220 Z" fill="${shade(color, -30)}"/>
    <path d="M300 1040 L330 300 L360 300 L340 1040 Z" fill="${shade(color, 18)}"/>
    <rect x="420" y="520" width="360" height="300" rx="24" fill="#fbf7ef"/>
    <text x="600" y="655" font-family="Georgia, serif" font-size="64" text-anchor="middle" fill="#2b2420">${label}</text>
    <rect x="500" y="700" width="200" height="6" rx="3" fill="#2b2420" fill-opacity="0.4"/>
    <text x="600" y="770" font-family="Helvetica, Arial, sans-serif" font-size="30" letter-spacing="6" text-anchor="middle" fill="#2b2420" fill-opacity="0.7">COFFEE</text>`,
  tin: (color, label) => `
    <rect x="380" y="330" width="440" height="700" rx="30" fill="${color}"/>
    <ellipse cx="600" cy="330" rx="220" ry="46" fill="${shade(color, 30)}"/>
    <rect x="380" y="560" width="440" height="220" fill="#f3e9d2"/>
    <text x="600" y="690" font-family="Georgia, serif" font-size="70" text-anchor="middle" fill="#2b2420">${label}</text>`,
  dripper: (color) => `
    <path d="M330 380 L870 380 L700 820 L500 820 Z" fill="${color}"/>
    <path d="M330 380 L870 380 L860 420 L340 420 Z" fill="${shade(color, -25)}"/>
    <path d="M870 450 C1010 450 1010 640 820 640" fill="none" stroke="${color}" stroke-width="44" stroke-linecap="round"/>
    <rect x="390" y="820" width="420" height="50" rx="20" fill="${shade(color, -20)}"/>
    <path d="M560 870 L640 870 L620 1000 L580 1000 Z" fill="${shade(color, -35)}"/>`,
  kettle: (color) => `
    <path d="M360 560 Q360 450 600 450 Q840 450 840 560 L870 1000 L330 1000 Z" fill="${color}"/>
    <path d="M360 640 C210 640 200 470 120 380" fill="none" stroke="${color}" stroke-width="30" stroke-linecap="round"/>
    <path d="M840 560 C1020 560 1020 860 860 900" fill="none" stroke="${shade(color, -30)}" stroke-width="46" stroke-linecap="round"/>
    <ellipse cx="600" cy="452" rx="150" ry="30" fill="${shade(color, -25)}"/>
    <rect x="565" y="390" width="70" height="50" rx="20" fill="${shade(color, -40)}"/>
    <rect x="400" y="560" width="30" height="380" rx="15" fill="#fff" fill-opacity="0.18"/>`,
  carafe: () => `
    <path d="M470 300 L730 300 L730 420 Q900 520 900 760 Q900 1020 600 1020 Q300 1020 300 760 Q300 520 470 420 Z" fill="#cfe3ea" fill-opacity="0.75" stroke="#8fb3bf" stroke-width="10"/>
    <path d="M318 760 Q318 1004 600 1004 Q882 1004 882 760 Z" fill="#5a3a26" fill-opacity="0.85"/>
    <rect x="470" y="420" width="260" height="70" fill="#7a5a3c"/>
    <rect x="370" y="560" width="26" height="300" rx="13" fill="#fff" fill-opacity="0.5"/>`,
  mug: (color) => `
    <path d="M330 420 L800 420 L780 1000 Q780 1030 750 1030 L380 1030 Q350 1030 350 1000 Z" fill="${color}"/>
    <ellipse cx="565" cy="420" rx="235" ry="46" fill="${shade(color, -30)}"/>
    <ellipse cx="565" cy="428" rx="205" ry="32" fill="#3d2618"/>
    <path d="M795 540 C1000 540 1000 860 785 860" fill="none" stroke="${color}" stroke-width="60" stroke-linecap="round"/>
    <rect x="390" y="500" width="34" height="440" rx="17" fill="#fff" fill-opacity="0.22"/>`,
  cups: (color) => `
    <ellipse cx="420" cy="900" rx="230" ry="44" fill="${shade(color, -20)}"/>
    <path d="M280 640 L560 640 L530 880 L310 880 Z" fill="${color}"/>
    <ellipse cx="420" cy="640" rx="140" ry="28" fill="#3d2618"/>
    <ellipse cx="800" cy="980" rx="230" ry="44" fill="${shade(color, -20)}"/>
    <path d="M660 720 L940 720 L910 960 L690 960 Z" fill="${color}"/>
    <ellipse cx="800" cy="720" rx="140" ry="28" fill="#3d2618"/>`,
  apron: (color) => `
    <path d="M460 260 L740 260 L760 470 Q900 480 920 520 L880 1040 L320 1040 L280 520 Q300 480 440 470 Z" fill="${color}"/>
    <path d="M460 260 Q600 120 740 260" fill="none" stroke="${shade(color, -30)}" stroke-width="24"/>
    <path d="M300 540 L120 700 M900 540 L1080 700" stroke="${shade(color, -30)}" stroke-width="22" stroke-linecap="round"/>
    <rect x="460" y="660" width="280" height="200" rx="16" fill="${shade(color, -18)}"/>`,
  tote: (color) => `
    <path d="M440 420 Q440 200 600 200 Q760 200 760 420" fill="none" stroke="${shade(color, -40)}" stroke-width="30"/>
    <rect x="300" y="400" width="600" height="640" rx="20" fill="${color}"/>
    <circle cx="600" cy="700" r="110" fill="none" stroke="#2b2420" stroke-width="14"/>
    <path d="M540 700 Q600 620 660 700 Q600 780 540 700" fill="#2b2420"/>`,
  guide: (color) => `
    <rect x="360" y="230" width="520" height="780" rx="18" fill="${shade(color, -40)}"/>
    <rect x="320" y="200" width="520" height="780" rx="18" fill="${color}"/>
    <rect x="380" y="290" width="400" height="10" rx="5" fill="#fff" fill-opacity="0.7"/>
    <text x="580" y="440" font-family="Georgia, serif" font-size="76" text-anchor="middle" fill="#fff">Brew</text>
    <text x="580" y="530" font-family="Georgia, serif" font-size="76" text-anchor="middle" fill="#fff">better</text>
    <path d="M480 640 L680 640 L620 800 L540 800 Z" fill="#fff" fill-opacity="0.85"/>`,
};

async function picture(name, shape, color, label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200">${shadow}${DRAW[shape](color, label)}</svg>`;
  const png = new Uint8Array(await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer());
  return (await call("POST", `/api/files/upload?name=${encodeURIComponent(name)}`, png, { "content-type": "image/png" })).id;
}

/** A one-page PDF, written by hand so nothing needs installing. What buyers of the guide download. */
function guidePdf() {
  const lines = ["Brew better at home", "", "1. Weigh: 15 g of coffee to 250 g of water.", "2. Grind medium-fine, like table salt.", "3. Water just off the boil, 94 C.", "4. Bloom 30 seconds, then pour in slow circles.", "5. Aim for a 3 minute brew. Adjust the grind, not the dose.", "", "Thanks for supporting the Tansy shop demo."];
  const text = lines.map((line, index) => `BT /F1 ${index ? 14 : 22} Tf 72 ${740 - index * 28} Td (${line.replace(/[()\\]/g, "\\$&")}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
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
  ["coffee", "Coffee", "Single origins and blends, roasted every Monday and shipped within the week."],
  ["brewing", "Brewing", "Drippers, kettles and carafes for a better cup at home."],
  ["ceramics", "Ceramics", "Mugs and cups thrown and glazed by hand, so no two are quite the same."],
  ["goods", "Goods", "Aprons, totes and the other things a café runs on."],
  ["guides", "Guides", "Downloads you get the moment you've paid. Nothing to ship."],
];

/**
 * Each product: slug, title, summary, price, compare-at price, stock, categories, picture
 * [shape, colour, label], and variants [title, price, stock, colour]. A variant's colour redraws
 * the picture for it. Stock left empty isn't counted.
 */
const PRODUCTS = [
  { slug: "ethiopia-guji", title: "Ethiopia Guji", summary: "Washed, bright and floral: bergamot, peach and black tea. Our everyday pour-over.", price: 19, categories: ["coffee"], picture: ["bag", "#c9a227", "Guji"], variants: [["250 g", 19, 40], ["1 kg", 62, 12]] },
  { slug: "colombia-huila", title: "Colombia Huila", summary: "Round and sweet, with red apple, caramel and a cocoa finish. Good every way you brew it.", price: 17, categories: ["coffee"], picture: ["bag", "#b5523b", "Huila"], variants: [["250 g", 17, 55], ["1 kg", 56, 20]] },
  { slug: "house-espresso", title: "House espresso", summary: "Our blend for espresso and milk drinks: chocolate, hazelnut, a little dried fruit. On sale this month.", price: 15, compareAtPrice: 18, categories: ["coffee"], picture: ["bag", "#3f4a3c", "House"], variants: [["250 g", 15, 80], ["1 kg", 49, 30]] },
  { slug: "panama-geisha-lot", title: "Panama Geisha, lot 7", summary: "Jasmine, mango and honey. Sixty tins a year, and this year's are gone. Shows how a sold-out product looks.", price: 48, stock: 0, categories: ["coffee"], picture: ["tin", "#7d6aa8", "Geisha"] },
  { slug: "ceramic-dripper", title: "Ceramic dripper", summary: "A cone dripper with deep ribs for an even draw. Takes size 02 filters.", price: 32, stock: 14, categories: ["brewing"], picture: ["dripper", "#e8e1d4"] },
  { slug: "gooseneck-kettle", title: "Gooseneck kettle", summary: "A slow, steady pour for pour-over. 0.9 litres, for gas, electric and induction.", price: 74, categories: ["brewing"], picture: ["kettle", "#2d2d2d"], variants: [["Matte black", 74, 9, "#2d2d2d"], ["Brushed steel", 79, 6, "#a7adb2"]] },
  { slug: "glass-carafe", title: "Glass carafe", summary: "Heat-proof borosilicate with a walnut collar. Holds 600 ml, enough for two mugs.", price: 38, stock: 22, categories: ["brewing"], picture: ["carafe", ""] },
  { slug: "stoneware-mug", title: "Stoneware mug", summary: "Wheel-thrown, 350 ml, with a handle you can get three fingers through. Only a few slate ones left.", price: 26, categories: ["ceramics"], picture: ["mug", "#d8c3a5"], variants: [["Sand", 26, 18, "#d8c3a5"], ["Slate", 26, 3, "#5d6873"], ["Moss", 28, 11, "#7d8b5a"]] },
  { slug: "espresso-cup-pair", title: "Espresso cups, pair", summary: "Two 90 ml cups with saucers in a speckled white glaze.", price: 34, stock: 16, categories: ["ceramics"], picture: ["cups", "#efe9df"] },
  { slug: "linen-apron", title: "Linen apron", summary: "Heavy washed linen with a deep pocket and long ties. The one our baristas wear.", price: 45, categories: ["goods"], picture: ["apron", "#8a6f55"], variants: [["S / M", 45, 10], ["L / XL", 45, 7]] },
  { slug: "canvas-tote", title: "Canvas tote", summary: "Sturdy cotton canvas that fits a kilo of beans and a carafe, with room to spare.", price: 22, categories: ["goods"], picture: ["tote", "#e6dcc8"] },
  { slug: "brew-better-guide", title: "Brew better: the home guide", summary: "Our one-page brewing guide as a PDF, yours on the orders page the moment you've paid. A download-only product: no address, no shipping.", price: 6, shipping: false, categories: ["guides"], picture: ["guide", "#b5523b"], download: true },
];

const ZONES = [
  { name: "United States", countries: ["US"], rate: 6, freeOver: 75 },
  { name: "Europe", countries: ["GB", "IE", "FR", "DE", "NL", "BE", "ES", "IT", "PT", "AT", "DK", "SE", "FI", "NO", "PL"], rate: 12, freeOver: 120 },
  { name: "Everywhere", countries: ["*"], rate: 20, freeOver: null },
];

/* ------------------------------------------------------------------- run */

console.log(`Signing in to ${base} as ${email}…`);
const signedIn = await call("POST", "/api/auth/sign-in/email", { email, password });
if (signedIn?.twoFactorRedirect) throw new Error("This account asks for a second factor. Turn it off for the demo admin.");

// The site's name and a coffee-brown accent, which the storefront's buttons and chips take.
const { settings } = await call("GET", "/api/settings/auth");
if (settings.general.appName !== "Tansy Coffee Co.") {
  await call("PUT", "/api/settings/auth", { ...settings, general: { ...settings.general, appName: "Tansy Coffee Co.", accentColor: "#9a5b34" } });
  console.log("Site: named Tansy Coffee Co.");
}

// The shop's words.
const [store] = await list("shop-store");
if (store) {
  await update("shop-store", store.id, {
    title: "Tansy Coffee Co.",
    intro: richText("Small-batch coffee, the gear to brew it and the cups to drink it from. A demo store: pay with Stripe's test card 4242 4242 4242 4242, any future date and any CVC."),
  });
  console.log("Shop page: words set.");
}
const [cart] = await list("shop-cart");
if (cart) await update("shop-cart", cart.id, { title: "Your cart", intro: richText("This is a demo: nothing is charged and nothing is sent. Use the test card 4242 4242 4242 4242.") });
const [account] = await list("shop-account");
if (account) await update("shop-account", account.id, { title: "Your orders", intro: richText("Orders you've placed, their tracking, and downloads once paid.") });

// Shipping zones by name. The shop's own "Everywhere" zone is kept and given a rate.
const zones = new Map((await list("shop-shipping-zones")).map((zone) => [zone.name, zone]));
for (const zone of ZONES) {
  const existing = zones.get(zone.name);
  if (existing) await update("shop-shipping-zones", existing.id, zone);
  else await create("shop-shipping-zones", zone);
  console.log(`Shipping zone: ${zone.name}`);
}

// Categories by slug.
const categoryIds = new Map((await list("shop-categories", "&fields=id,slug")).map((category) => [category.slug, category.id]));
for (const [slug, name, description] of CATEGORIES) {
  if (categoryIds.has(slug)) continue;
  const created = await create("shop-categories", { slug, name, description, status: "published" });
  categoryIds.set(slug, created.id);
  console.log(`Category: ${name}`);
}

// Products and their variants by slug.
const productIds = new Map((await list("shop-products", "&fields=id,slug")).map((product) => [product.slug, product.id]));
for (const product of PRODUCTS) {
  if (productIds.has(product.slug)) continue;
  const [shape, color, label] = product.picture;
  const images = [await picture(`${product.slug}.png`, shape, color, label)];
  const download = product.download
    ? (await call("POST", `/api/files/upload?name=${encodeURIComponent(`${product.slug}.pdf`)}`, guidePdf(), { "content-type": "application/pdf" })).id
    : undefined;
  const created = await create("shop-products", {
    title: product.title,
    slug: product.slug,
    summary: product.summary,
    price: product.price,
    ...(product.compareAtPrice ? { compareAtPrice: product.compareAtPrice } : {}),
    ...(product.stock !== undefined ? { stock: product.stock } : {}),
    sku: product.slug.toUpperCase().replace(/-/g, "").slice(0, 10),
    shipping: product.shipping ?? true,
    images,
    categories: product.categories.map((slug) => categoryIds.get(slug)),
    ...(download ? { download } : {}),
    status: "published",
  });
  productIds.set(product.slug, created.id);
  for (const [position, [title, price, stock, variantColor]] of (product.variants ?? []).entries()) {
    const image = variantColor ? await picture(`${product.slug}-${title.toLowerCase().replace(/\W+/g, "-")}.png`, shape, variantColor, label) : undefined;
    await create("shop-variants", { product: created.id, title, price, stock, position, sku: `${created.sku ?? ""}-${position + 1}`, ...(image ? { image } : {}), status: "published" });
  }
  console.log(`Product: ${product.title}${product.variants ? ` (${product.variants.length} variants)` : ""}`);
}

// The menu: the shop, two categories and the orders page.
const [menu] = await list("site-menu");
const menuVersion = (await call("GET", "/api/block-types")).find?.((type) => type.name === "menu_item")?.version ?? 1;
const link = (id, label, url) => ({ id, type: "menu_item", v: menuVersion, value: { label, url } });
const items = [link("shop", "Shop", "/shop"), link("coffee", "Coffee", "/shop/category/coffee"), link("brewing", "Brewing", "/shop/category/brewing"), link("ceramics", "Ceramics", "/shop/category/ceramics"), link("orders", "Orders", "/orders")];
if (menu) await update("site-menu", menu.id, { items, status: "published" });
else await create("site-menu", { items, status: "published" });
console.log("Menu: set.");

// Orders in every state, placed through the shop's own checkout route as the admin, then moved on
// as staff would. Only while none has been paid, so a second run adds no more.
if ((await list("shop-orders", `&fields=id&filter=${encodeURIComponent('state != "pending" && state != "cancelled"')}`)).length === 0) {
  const variantsOf = async (slug) => list("shop-variants", `&filter=${encodeURIComponent(`product = ${productIds.get(slug)}`)}&fields=id,title`);
  const [guji] = await variantsOf("ethiopia-guji");
  const mugs = await variantsOf("stoneware-mug");
  const [espresso] = await variantsOf("house-espresso");
  const kettles = await variantsOf("gooseneck-kettle");
  const address = (name, line1, city, postalCode, region) => ({ name, line1, city, postalCode, ...(region ? { region } : {}) });
  const ORDERS = [
    { items: [{ product: productIds.get("ethiopia-guji"), variant: guji.id, quantity: 2 }, { product: productIds.get("ceramic-dripper"), quantity: 1 }], country: "US", address: address("Ada Example", "12 Roast Lane", "Portland", "97201", "OR"), then: ["paid", "shipped", "delivered"] },
    { items: [{ product: productIds.get("gooseneck-kettle"), variant: kettles[1].id, quantity: 1 }], country: "GB", address: address("Sam Sample", "4 Kettle Row", "Bristol", "BS1 4DJ"), then: ["paid", "shipped"] },
    { items: [{ product: productIds.get("stoneware-mug"), variant: mugs[0].id, quantity: 2 }, { product: productIds.get("stoneware-mug"), variant: mugs[2].id, quantity: 2 }], country: "DE", address: address("Kim Muster", "Bohnenweg 8", "Berlin", "10115"), then: ["paid"] },
    { items: [{ product: productIds.get("brew-better-guide"), quantity: 1 }], then: ["paid"] },
    { items: [{ product: productIds.get("house-espresso"), variant: espresso.id, quantity: 3 }, { product: productIds.get("canvas-tote"), quantity: 1 }], country: "US", address: address("Lee Placeholder", "88 Crema Ave", "Austin", "73301", "TX"), then: ["paid"] },
    { items: [{ product: productIds.get("glass-carafe"), quantity: 1 }], country: "CA", address: address("Jo Testcase", "21 Pour St", "Toronto", "M5V 2T6", "ON"), then: [] },
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
