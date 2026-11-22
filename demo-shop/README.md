# Shop demo

A live bookstore on the published tansy packages: the storefront theme, the shop plugin, Payments and
Subscriptions, filled with made-up books, live at <https://tansy-demo-shop.netlify.app>. Not part of
the npm workspace.

What a visitor can try:

- The storefront: genres, search, a sale price, a sold-out book, low stock, paperback and hardcover
  options, and on phones an app's feel: a tab bar, pictures that fly from card to page and zoom.
- Three formats: printed books are posted; digital editions skip the address and are downloadable
  once paid; books in both are posted and come with their PDF.
- A real checkout in Stripe's test mode with the card `4242 4242 4242 4242`, then the order on
  `/orders`.
- The Readers' Club at `/library`: a membership whose members read some books' digital editions for
  free. Only members can open those files. Printed books are still bought.
- English and Arabic: every book, shelf and page has an Arabic translation at `/ar`, right to left,
  with a language switcher in the header. Prices, stock and files are shared between the two.
- Shipping by zone: free in the US over $50, in Europe over $80, a flat rate everywhere else.
- In the dashboard: the Shop overview (orders, revenue, what to ship, low stock), orders in every
  state with Mark shipped and Mark delivered, products and their variants, Payments settings, the
  Readers' Club plan and its access, Library files, Languages and each record's translations, and
  Subscriptions, which gives free memberships.

## Running it yourself

```bash
cd demo-shop && npm install && npx tansy init && npx tansy migrate && npm run dev
```

Open the first-run link the server prints, create the admin, then write the admin file and fill the
store from the repository root:

```bash
printf 'URL: http://localhost:3000\nEmail: …\nPassword: …\n' > .demo-shop-admin-local
node scripts/demo-shop-content.mjs .demo-shop-admin-local
```

## Deploying

It runs on Netlify, deployed from this folder (the site's base directory) on every push to `main`,
with Postgres on Neon. `netlify.toml` runs the migrations on Neon's direct address before the build
and calls the background endpoint every five minutes from a scheduled function.

1. Environment on Netlify: `DATABASE_URL` (Neon's pooled address), `DATABASE_URL_UNPOOLED` (its
   direct one), `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `TANSY_SITE_URL`, `TANSY_ENCRYPTION_KEY`,
   `TANSY_BACKUP_KEY`, `CRON_SECRET`, `TANSY_BACKGROUND_SECONDS=8`, storage (`IMGBB_API_KEY` for the
   pictures, free on imgbb, with `BLOB_READ_WRITE_TOKEN` or `S3_*` for the digital editions),
   `TANSY_SHARED_ACCOUNTS=demo@example.com`, and Stripe **test** keys: `STRIPE_SECRET_KEY=sk_test_…`
   and `STRIPE_WEBHOOK_SECRET` for a webhook to `/api/auth/stripe/webhook`. Never live keys. For the
   Readers' Club, a test recurring price of $9 a month (and $90 a year) in Stripe, whose ids go in
   `STRIPE_CLUB_PRICE` and `STRIPE_CLUB_ANNUAL_PRICE` when running the script below.
2. Create the admin from the first-run link in the function log, or with `npx tansy superadmin
   <email>` against the same database. Put its URL, email and password in `.demo-shop-admin` at the
   repository root (gitignored), and run `node scripts/demo-shop-content.mjs`. Where the site can't
   be reached, run the app locally against the same database and storage and use its address.
3. Under Payments settings, choose Stripe and turn on test mode.
4. Create the shared account `demo@example.com` with the password `explore-tansy-shop` and a role
   of its own (see `docs/guides/production.md`, "Handing out a login"). The role needs
   `ext.shop:fulfill` and update on `shop-orders` for visitors to ship orders, and no `file:delete`,
   since the hourly reset puts back the database but not files.
5. Add Neon's direct address as the repository secret `DEMO_SHOP_DATABASE_URL`, then run the "Demo
   reset" workflow with `baseline` and demo `shop`. From then on it resets every hour.
