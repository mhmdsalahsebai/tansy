// The shop demo: a bookstore on the published tansy packages from npm, with the storefront theme, the
// shop plugin, Payments and Subscriptions. Books are physical, digital or both, and a Readers' Club
// membership opens the digital editions of some of them in the library. Not part of the npm
// workspace. The general demo is in ../demo.
//
// Checkout runs in the payment provider's test mode: set STRIPE_SECRET_KEY to a test key (sk_test_…)
// and STRIPE_WEBHOOK_SECRET, and visitors pay with the card 4242 4242 4242 4242.
import { payments } from "@tansy/payments";
import { commet } from "@tansy/payments-commet";
import { creem } from "@tansy/payments-creem";
import { dodo } from "@tansy/payments-dodo";
import { polar } from "@tansy/payments-polar";
import { stripe } from "@tansy/payments-stripe";
import { shop } from "@tansy/shop";
import { subscriptions } from "@tansy/subscriptions";
import { vercelBlobStorage } from "@tansy/storage-vercel-blob";
import { storefront } from "@tansy/theme-storefront";
import { defineCms } from "tansy/config";
import { localStorage, s3Storage } from "tansy/storage";
import { defineAdminTheme } from "tansy/theme";

const env = process.env;
const siteUrl = env.TANSY_SITE_URL || env.BETTER_AUTH_URL || "http://localhost:3000";
const currency = env.TANSY_PAYMENTS_CURRENCY || "usd";

export default defineCms({
  theme: storefront({ tagline: env.TANSY_SITE_TAGLINE || "Books for long evenings", library: true }),
  adminTheme: defineAdminTheme({ name: "tansy", tokens: {}, logo: "/tansy-icon.png" }),
  plugins: [
    // Payments comes first: the shop sells its orders through it. Every provider is installed, so the
    // dashboard shows how a site picks one under Payments settings.
    payments({ siteUrl, currency, providers: [stripe(), polar(), dodo(), creem(), commet()] }),
    shop({ siteUrl, currency }),
    // Memberships: subscribing to the Readers' Club plan grants its access, which opens the library's
    // files. Digital editions only; printed books are still bought through the cart.
    subscriptions(),
  ],
  // Product pictures: any S3-compatible bucket with S3_BUCKET, Vercel Blob with BLOB_READ_WRITE_TOKEN,
  // and local disk when running it yourself.
  storage: {
    adapter: env.S3_BUCKET
      ? s3Storage({ endpoint: env.S3_ENDPOINT || "", bucket: env.S3_BUCKET, region: env.S3_REGION, accessKeyId: env.S3_ACCESS_KEY_ID || "", secretAccessKey: env.S3_SECRET_ACCESS_KEY || "", prefix: env.S3_PREFIX })
      : env.BLOB_READ_WRITE_TOKEN
        ? vercelBlobStorage({ token: env.BLOB_READ_WRITE_TOKEN, prefix: env.BLOB_PREFIX })
        : localStorage({ dir: env.UPLOADS_DIR || "data/uploads", allowInProduction: env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION === "true" }),
  },
});
