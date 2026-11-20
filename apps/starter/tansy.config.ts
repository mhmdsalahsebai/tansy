import { emailTemplates } from "@tansy/example-email-templates";
import { ipAllowlist } from "@tansy/example-ip-allowlist";
import { livePreview } from "@tansy/example-live-preview";
import { passwordDenylist } from "@tansy/example-password-denylist";
import { planAccessExample } from "@tansy/example-plan-access";
import { workspacesExample } from "@tansy/example-workspaces";
import { multiTenant } from "@tansy/multi-tenant";
import { seoPlugin } from "@tansy/example-seo-plugin";
import { seo } from "@tansy/seo";
import { signInAlerts } from "@tansy/example-sign-in-alerts";
import { pwnedPasswords } from "@tansy/pwned-passwords";
import { socialSignIn } from "@tansy/social-sign-in";
import { blog as blogPlugin } from "@tansy/blog";
import { lms } from "@tansy/lms";
import { captcha } from "@tansy/captcha";
import { hcaptcha } from "@tansy/captcha-hcaptcha";
import { recaptcha } from "@tansy/captcha-recaptcha";
import { turnstile } from "@tansy/captcha-turnstile";
import { email } from "@tansy/email";
import { forms } from "@tansy/forms";
import { newsletter } from "@tansy/newsletter";
import { brevo } from "@tansy/email-brevo";
import { mailgun } from "@tansy/email-mailgun";
import { postmark } from "@tansy/email-postmark";
import { resend } from "@tansy/email-resend";
import { sendgrid } from "@tansy/email-sendgrid";
import { ses } from "@tansy/email-ses";
import { payments } from "@tansy/payments";
import { shop } from "@tansy/shop";
import { subscriptions } from "@tansy/subscriptions";
import { commet } from "@tansy/payments-commet";
import { creem } from "@tansy/payments-creem";
import { dodo } from "@tansy/payments-dodo";
import { polar } from "@tansy/payments-polar";
import { stripe } from "@tansy/payments-stripe";
import { ai } from "@tansy/ai";
import { consoleDestination, httpDestination, requestLogs, storageDestination } from "@tansy/request-logs";
import { logsOtlp, otlpDestination } from "@tansy/logs-otlp";
import { analytics } from "@tansy/analytics";
import { fathom } from "@tansy/analytics-fathom";
import { googleAnalytics } from "@tansy/analytics-google";
import { matomo } from "@tansy/analytics-matomo";
import { plausible } from "@tansy/analytics-plausible";
import { umami } from "@tansy/analytics-umami";
import { anthropic } from "@tansy/ai-anthropic";
import { deepseek } from "@tansy/ai-deepseek";
import { gateway } from "@tansy/ai-gateway";
import { google } from "@tansy/ai-google";
import { groq } from "@tansy/ai-groq";
import { mistral } from "@tansy/ai-mistral";
import { openai } from "@tansy/ai-openai";
import { openaiCompatible } from "@tansy/ai-openai-compatible";
import { opencode } from "@tansy/ai-opencode";
import { commandcode } from "@tansy/ai-commandcode";
import { openrouter } from "@tansy/ai-openrouter";
import { xai } from "@tansy/ai-xai";
import { algolia } from "@tansy/search-algolia";
import { meilisearch } from "@tansy/search-meilisearch";
import { typesense } from "@tansy/search-typesense";
import { bunnyStorage } from "@tansy/storage-bunny";
import { cloudinaryStorage } from "@tansy/storage-cloudinary";
import { uploadthingStorage } from "@tansy/storage-uploadthing";
import { vercelBlobStorage } from "@tansy/storage-vercel-blob";
import { academy } from "@tansy/theme-academy";
import { blank } from "@tansy/theme-blank";
import { blog } from "@tansy/theme-blog";
import { dispatch } from "@tansy/theme-dispatch";
import { halo } from "@tansy/theme-halo";
import { magazine } from "@tansy/theme-magazine";
import { storefront } from "@tansy/theme-storefront";
import { defineCms } from "tansy/config";
import { defineAdminTheme } from "tansy/theme";
import { localStorage } from "tansy/storage";
import { s3Storage } from "tansy/storage";

// An empty value means "not set", so `TANSY_SITE_URL=` in a .env file leaves the default below alone
// rather than handing a plugin an empty string. Hence `||` and not `??` throughout.
const env = process.env;

// tansy sync lists these too, so an example's admin code is in the build whichever way it's set at run time.
const showing = (variable: string) => env[variable] === "true" || env.TANSY_SYNC === "true";

// The themes this build installs. TANSY_THEME picks one; TANSY_THEMES lists several, separated by
// commas, the first being the default, and a tenant then picks its own under Site.
const themeNames = (env.TANSY_THEMES || env.TANSY_THEME || "blank").split(",").map((name) => name.trim()).filter(Boolean);
const uses = (name: string) => themeNames.includes(name);

// A theme that is a site for a feature turns that feature's plugin on, whether it is the default or a theme a tenant may pick.
const blogging = showing("TANSY_PLUGIN_BLOG") || uses("blog") || uses("magazine") || uses("halo") || uses("dispatch");
// The dispatch theme is a newsletter's site, so it turns the newsletter on too.
const mailing = showing("TANSY_PLUGIN_NEWSLETTER") || uses("dispatch");
// The storefront theme needs the shop, which sells through Payments.
const selling = showing("TANSY_PLUGIN_SHOP") || uses("storefront");
// The academy theme is a school's site, so it turns the LMS on too.
const teaching = showing("TANSY_PLUGIN_LMS") || uses("academy");
const paying = showing("TANSY_PLUGIN_PAYMENTS") || selling;

const tagline = env.TANSY_SITE_TAGLINE;
const themesByName = {
  blog: () => blog({ tagline }),
  magazine: () => magazine({ tagline }),
  halo: () => halo({ tagline }),
  storefront: () => storefront({ tagline }),
  dispatch: () => dispatch({ tagline }),
  academy: () => academy({ tagline }),
  blank: () => blank(),
};
const installed = themeNames.map((name) => (themesByName[name as keyof typeof themesByName] ?? themesByName.blank)());

export default defineCms({
  // The public site. The themes come with the build, so changing the list means rebuilding; which
  // of them a site is served in is a setting, so a tenant can change that without one.
  ...(installed.length > 1 ? { themes: installed } : { theme: installed[0] }),
  previewUrl: env.TANSY_PREVIEW_URL,
  // Tansy's own mark on the dashboard and sign-in pages, from public/. A logo set under Settings replaces it.
  adminTheme: defineAdminTheme({ name: "tansy", tokens: {}, logo: "/tansy-icon.png" }),
  // Features are plugins. Remove a line to remove the feature. See docs/EXTENDING.md.
  plugins: [
    socialSignIn(),
    ...(blogging ? [blogPlugin({ siteUrl: env.TANSY_SITE_URL || env.BETTER_AUTH_URL || "http://localhost:3000", comments: env.TANSY_BLOG_COMMENTS === "open" || env.TANSY_BLOG_COMMENTS === "off" ? env.TANSY_BLOG_COMMENTS : "moderated", notify: env.TANSY_BLOG_NOTIFY || undefined })] : []),
    // Before the LMS, so on a new site the LMS finds Payments and gives courses their "Included in" field for plans.
    ...(paying ? [payments({ siteUrl: env.TANSY_SITE_URL || env.BETTER_AUTH_URL || "http://localhost:3000", currency: env.TANSY_PAYMENTS_CURRENCY || undefined, providers: [stripe(), polar(), dodo(), creem(), commet()] })] : []),
    ...(teaching ? [lms({ passingScore: Number(env.TANSY_LMS_PASSING_SCORE) || undefined })] : []),
    // Every provider, to try them all. A site lists only the ones it may use, and installs only their packages.
    ...(showing("TANSY_PLUGIN_EMAIL") ? [email({ providers: [resend(), postmark(), sendgrid(), mailgun(), ses(), brevo()] })] : []),
    // A CAPTCHA on sign-in and on plugins' own forms. Every provider, to try them all. TANSY_CAPTCHA_FORMS
    // lists the sign-in forms that ask for it at first (signin,signup,forgot-password), all of them when unset.
    ...(showing("TANSY_PLUGIN_CAPTCHA") ? [captcha({
      providers: [
        turnstile({ siteKey: env.TURNSTILE_SITE_KEY, verifyUrl: env.TANSY_CAPTCHA_VERIFY_URL }),
        hcaptcha({ siteKey: env.HCAPTCHA_SITE_KEY, verifyUrl: env.TANSY_CAPTCHA_VERIFY_URL }),
        recaptcha({ siteKey: env.RECAPTCHA_SITE_KEY, verifyUrl: env.TANSY_CAPTCHA_VERIFY_URL }),
      ],
      authForms: env.TANSY_CAPTCHA_FORMS === undefined ? undefined : env.TANSY_CAPTCHA_FORMS.split(",").filter(Boolean) as Array<"signin" | "signup" | "forgot-password">,
    })] : []),
    // Contact forms and other forms visitors fill in, kept as submissions and emailed to TANSY_FORMS_NOTIFY.
    ...(showing("TANSY_PLUGIN_FORMS") ? [forms({ notify: env.TANSY_FORMS_NOTIFY || undefined })] : []),
    // Subscribers who confirm by email, and campaigns sent in batches through the site's email. Any published post can become one.
    ...(mailing ? [newsletter({ siteUrl: env.TANSY_SITE_URL || env.BETTER_AUTH_URL || "http://localhost:3000", perMinute: Number(env.TANSY_NEWSLETTER_PER_MINUTE) || undefined })] : []),
    // The shop sells through Payments, so it needs TANSY_PLUGIN_PAYMENTS too.
    ...(selling ? [shop({ siteUrl: env.TANSY_SITE_URL || env.BETTER_AUTH_URL || "http://localhost:3000", currency: env.TANSY_PAYMENTS_CURRENCY || undefined })] : []),
    // Runs subscriptions from one section of the dashboard. Needs TANSY_PLUGIN_PAYMENTS too.
    ...(showing("TANSY_PLUGIN_SUBSCRIPTIONS") ? [subscriptions()] : []),
    // An assistant on the Vercel AI SDK. Every provider, to try them all: a site lists only the ones it may use.
    ...(showing("TANSY_PLUGIN_AI") ? [ai({ providers: [openai(), anthropic(), google(), gateway(), mistral(), xai(), groq(), deepseek(), openrouter(), opencode(), commandcode(), openaiCompatible()], provider: env.TANSY_AI_PROVIDER || undefined })] : []),
    // Page views counted here with no cookies, and optionally sent to an outside service. Every provider, to try
    // them all: a site lists only the ones it may use. Self-hosted Plausible, Umami or Matomo take their address here,
    // because the Content Security Policy is built with it.
    ...(showing("TANSY_PLUGIN_ANALYTICS") ? [analytics({
      providers: [
        plausible({ host: env.PLAUSIBLE_HOST || undefined }),
        umami({ host: env.UMAMI_HOST || undefined }),
        googleAnalytics(),
        fathom(),
        ...(env.MATOMO_URL ? [matomo({ url: env.MATOMO_URL })] : []),
      ],
      provider: "none",
    })] : []),
    // A log of every API request, kept in the database and shown on the dashboard. REQUEST_LOGS_S3_BUCKET also
    // writes them to a bucket as JSON lines (with the S3_* credentials unless REQUEST_LOGS_S3_* are set),
    // REQUEST_LOGS_HTTP_URL posts them to a log service, REQUEST_LOGS_CONSOLE=true prints them for the host to collect,
    // and REQUEST_LOGS_OTLP=true sends them over OpenTelemetry to the OTEL_EXPORTER_OTLP_* address.
    ...(showing("TANSY_PLUGIN_REQUEST_LOGS") ? [requestLogs({
      destinations: [
        ...(env.REQUEST_LOGS_S3_BUCKET ? [storageDestination(s3Storage({
          name: "request-logs",
          endpoint: env.REQUEST_LOGS_S3_ENDPOINT || env.S3_ENDPOINT || "",
          bucket: env.REQUEST_LOGS_S3_BUCKET,
          region: env.REQUEST_LOGS_S3_REGION || env.S3_REGION,
          accessKeyId: env.REQUEST_LOGS_S3_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID || "",
          secretAccessKey: env.REQUEST_LOGS_S3_SECRET_ACCESS_KEY || env.S3_SECRET_ACCESS_KEY || "",
        }), { prefix: env.REQUEST_LOGS_S3_PREFIX || "request-logs", label: `S3 (${env.REQUEST_LOGS_S3_BUCKET})` })] : []),
        ...(env.REQUEST_LOGS_HTTP_URL ? [httpDestination({ url: env.REQUEST_LOGS_HTTP_URL, headers: env.REQUEST_LOGS_HTTP_TOKEN ? { authorization: `Bearer ${env.REQUEST_LOGS_HTTP_TOKEN}` } : undefined })] : []),
        ...(env.REQUEST_LOGS_CONSOLE === "true" ? [consoleDestination()] : []),
        ...(env.REQUEST_LOGS_OTLP === "true" ? [otlpDestination()] : []),
      ],
    })] : []),
    // A copy of the audit log over OpenTelemetry, to the OTEL_EXPORTER_OTLP_* address. Not under TANSY_SYNC,
    // as it needs that address and adds nothing to sync.
    ...(env.TANSY_PLUGIN_LOGS_OTLP === "true" ? [logsOtlp()] : []),
    // Many sites or customers in one instance, each a tenant with its own records and members. Only one plugin
    // can split records like this, so it can't run beside the workspaces example below.
    ...(showing("TANSY_PLUGIN_MULTI_TENANT") ? [multiTenant({ siteUrl: env.TANSY_SITE_URL || env.BETTER_AUTH_URL || "http://localhost:3000", scopeNewCollections: env.TANSY_MULTI_TENANT_SCOPE_NEW !== "false", dnsServers: env.TANSY_MULTI_TENANT_DNS_SERVERS ? env.TANSY_MULTI_TENANT_DNS_SERVERS.split(",") : undefined })] : []),
    livePreview({ url: env.NEXT_PUBLIC_TANSY_PREVIEW_URL }),
    ...(env.TANSY_PWNED_PASSWORDS === "true" ? [pwnedPasswords()] : []),
    ...(env.TANSY_SEO_COLLECTIONS ? [seo({ siteUrl: env.TANSY_SITE_URL || env.BETTER_AUTH_URL || "", collections: env.TANSY_SEO_COLLECTIONS.split(",") })] : []),
    // Examples, off unless their variable is set.
    ...(showing("TANSY_EXAMPLE_SEO") ? [seoPlugin({ siteUrl: env.BETTER_AUTH_URL || "", collections: (env.TANSY_EXAMPLE_SEO_COLLECTIONS || "posts").split(",") })] : []),
    ...(env.TANSY_EXAMPLE_DENIED_PASSWORDS ? [passwordDenylist(env.TANSY_EXAMPLE_DENIED_PASSWORDS.split(","))] : []),
    ...(env.TANSY_EXAMPLE_SIGN_IN_ALERTS === "true" ? [signInAlerts()] : []),
    ...(env.TANSY_EXAMPLE_EMAIL_TEMPLATES === "true" ? [emailTemplates()] : []),
    // Needs TANSY_PLUGIN_PAYMENTS, which is listed above it.
    ...(showing("TANSY_EXAMPLE_PLAN_ACCESS") ? [planAccessExample()] : []),
    ...(env.TANSY_EXAMPLE_WORKSPACES ? [workspacesExample(env.TANSY_EXAMPLE_WORKSPACES)] : []),
    ...(env.TANSY_EXAMPLE_IP_ALLOWLIST ? [ipAllowlist(env.TANSY_EXAMPLE_IP_ALLOWLIST.split(","), { allowUnknown: env.TANSY_EXAMPLE_IP_ALLOW_UNKNOWN === "true" })] : []),
  ],
  // Uploaded files. S3_BUCKET selects any S3-compatible service: AWS, R2, B2, MinIO and others.
  // CLOUDINARY_CLOUD_NAME, BUNNY_STORAGE_ZONE, BLOB_READ_WRITE_TOKEN or UPLOADTHING_TOKEN picks a provider plugin.
  // Without any, files stay on local disk, which is refused in production unless explicitly allowed.
  // For another provider, pass any object implementing StorageAdapter. See docs/guides/storage.md.
  storage: {
    adapter: env.S3_BUCKET
      ? s3Storage({ endpoint: env.S3_ENDPOINT || "", bucket: env.S3_BUCKET, region: env.S3_REGION, accessKeyId: env.S3_ACCESS_KEY_ID || "", secretAccessKey: env.S3_SECRET_ACCESS_KEY || "", prefix: env.S3_PREFIX })
      : env.CLOUDINARY_CLOUD_NAME
        ? cloudinaryStorage({ cloudName: env.CLOUDINARY_CLOUD_NAME, apiKey: env.CLOUDINARY_API_KEY || "", apiSecret: env.CLOUDINARY_API_SECRET || "", prefix: env.CLOUDINARY_PREFIX })
        : env.BUNNY_STORAGE_ZONE
          ? bunnyStorage({
            storageZone: env.BUNNY_STORAGE_ZONE,
            accessKey: env.BUNNY_STORAGE_PASSWORD || "",
            region: (env.BUNNY_STORAGE_REGION || undefined) as Parameters<typeof bunnyStorage>[0]["region"],
            cdn: env.BUNNY_CDN_URL ? { url: env.BUNNY_CDN_URL, tokenKey: env.BUNNY_CDN_TOKEN_KEY || "" } : undefined,
            prefix: env.BUNNY_PREFIX,
          })
          : env.BLOB_READ_WRITE_TOKEN
            ? vercelBlobStorage({ token: env.BLOB_READ_WRITE_TOKEN, prefix: env.BLOB_PREFIX })
            : env.UPLOADTHING_TOKEN
              ? uploadthingStorage({ token: env.UPLOADTHING_TOKEN, prefix: env.UPLOADTHING_PREFIX })
              : localStorage({ dir: env.UPLOADS_DIR || "data/uploads", allowInProduction: env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION === "true" }),
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES) || undefined,
  },
  // Bunny's CDN serves thumbnails straight to the browser, so the dashboard's images may come from it.
  csp: env.BUNNY_CDN_URL ? { img: [new URL(env.BUNNY_CDN_URL).origin] } : undefined,
  // Backups of the database and uploads, encrypted with TANSY_BACKUP_KEY. `tansy backup` makes one by hand,
  // TANSY_BACKUP_SCHEDULE (cron, UTC) on a schedule, and `tansy restore` puts one back. TANSY_BACKUP_S3_BUCKET
  // sends them to a bucket, with the S3_* credentials unless TANSY_BACKUP_S3_* are set. Otherwise they go to
  // TANSY_BACKUP_DIR, which should be another disk: a backup on the server's own disk is lost with it.
  backups: env.TANSY_BACKUP_S3_BUCKET || env.TANSY_BACKUP_DIR || env.TANSY_BACKUP_SCHEDULE
    ? {
      adapter: env.TANSY_BACKUP_S3_BUCKET
        ? s3Storage({
          name: "backups",
          endpoint: env.TANSY_BACKUP_S3_ENDPOINT || env.S3_ENDPOINT || "",
          bucket: env.TANSY_BACKUP_S3_BUCKET,
          region: env.TANSY_BACKUP_S3_REGION || env.S3_REGION,
          accessKeyId: env.TANSY_BACKUP_S3_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID || "",
          secretAccessKey: env.TANSY_BACKUP_S3_SECRET_ACCESS_KEY || env.S3_SECRET_ACCESS_KEY || "",
          prefix: env.TANSY_BACKUP_S3_PREFIX || "backups",
        })
        : localStorage({ dir: env.TANSY_BACKUP_DIR || "data/backups", allowInProduction: true }),
      schedule: env.TANSY_BACKUP_SCHEDULE || undefined,
      keep: Number(env.TANSY_BACKUP_KEEP) || undefined,
      files: env.TANSY_BACKUP_FILES !== "false",
    }
    : undefined,
  // Search runs in the database unless an outside engine is set: MEILISEARCH_HOST, TYPESENSE_HOST or
  // ALGOLIA_APP_ID picks one. Changing engine reindexes every collection into the new one at the next start.
  search: env.MEILISEARCH_HOST
    ? meilisearch({ host: env.MEILISEARCH_HOST, apiKey: env.MEILISEARCH_API_KEY, index: env.MEILISEARCH_INDEX || undefined })
    : env.TYPESENSE_HOST
      ? typesense({ host: env.TYPESENSE_HOST, apiKey: env.TYPESENSE_API_KEY || "", collection: env.TYPESENSE_COLLECTION || undefined })
      : env.ALGOLIA_APP_ID
        ? algolia({ appId: env.ALGOLIA_APP_ID, apiKey: env.ALGOLIA_API_KEY || "", index: env.ALGOLIA_INDEX || undefined })
        : undefined,
  // Custom field types. Each one appears in the dashboard with a generated config form:
  //
  // fields: [
  //   defineField({
  //     type: "slug",
  //     admin: { label: "Slug", description: "URL-safe text", input: "text" },
  //     config: { maxLength: z.number().int().positive().optional() },
  //     value: ({ maxLength }) => z.string().regex(/^[a-z0-9-]+$/).max(maxLength ?? 120),
  //     storage: () => ({ sql: "text" }),
  //   }),
  // ],
  //
  // Bring old stored blocks up to date on read, one version at a time. Blocks with
  // no path to the current version stay as stored, and the editor offers to update them.
  //
  // blockUpgrades: {
  //   gallery: { 1: (value) => ({ ...value, images: [value.image] }) },
  // },
});
