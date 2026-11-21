# Shop demo

A live online store on the published tansy packages: the storefront theme, the shop plugin and
Payments, filled with a small coffee and homeware store. One of the use-case demos next to the
general one in `../demo`. Not part of the npm workspace.

What a visitor can try:

- The storefront: categories, search, a sale price, a sold-out product, low stock on one variant,
  products with options (sizes, colours) whose pictures change with them.
- A real checkout in Stripe's test mode with the card `4242 4242 4242 4242`, then the order on
  `/orders`. The brewing guide is download-only: it skips the address and is downloadable once paid.
- Shipping by zone: free in the US over $75, in Europe over $120, a flat rate everywhere else.
- In the dashboard: the Shop overview (orders, revenue, what to ship, low stock), orders in every
  state with Mark shipped and Mark delivered, products and their variants, and Payments settings.

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

Like `../demo`: its own Vercel project and Postgres database, deployed from this folder.

1. Environment on Vercel: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
   `TANSY_ENCRYPTION_KEY`, `TANSY_BACKUP_KEY`, `CRON_SECRET`, storage (`S3_*` or
   `BLOB_READ_WRITE_TOKEN`), `TANSY_SHARED_ACCOUNTS=demo@example.com`, and Stripe **test** keys:
   `STRIPE_SECRET_KEY=sk_test_…` and `STRIPE_WEBHOOK_SECRET` for a webhook to
   `/api/auth/stripe/webhook`. Never live keys.
2. Create the admin from the first-run link, put its URL, email and password in `.demo-shop-admin`
   at the repository root (gitignored), and run `node scripts/demo-shop-content.mjs`.
3. Under Payments settings, choose Stripe and turn on test mode.
4. Create the shared account and its role as for the general demo (see
   `docs/guides/production.md`, "Handing out a login"). The role needs `ext.shop:fulfill` and
   update on `shop-orders` for visitors to ship orders, and no `file:delete`, since the hourly
   reset puts back the database but not files.
5. Add the database address as the repository secret `DEMO_SHOP_DATABASE_URL`, then run the
   "Demo reset" workflow with `baseline` and demo `shop`. From then on it resets every hour.
