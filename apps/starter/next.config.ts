import path from "node:path";
import { withCms } from "tansy/next";

const root = path.join(__dirname, "../..");

// The addresses before sign-in moved under the admin path, for old bookmarks and emails already sent.
const MOVED = ["signin", "signup", "forgot-password", "reset-password", "setup", "two-factor"];

export default withCms({
  // Used by the Docker image.
  output: "standalone",
  outputFileTracingRoot: root,
  turbopack: { root },
  transpilePackages: ["@tansy/email-resend", "@tansy/email-postmark", "@tansy/email-sendgrid", "@tansy/email-mailgun", "@tansy/email-ses", "@tansy/email-brevo", "@tansy/payments-stripe", "@tansy/payments-polar", "@tansy/payments-dodo", "@tansy/payments-creem", "@tansy/payments-commet", "@tansy/pwned-passwords", "@tansy/seo", "@tansy/social-sign-in", "@tansy/example-captcha", "@tansy/example-email-templates", "@tansy/example-ip-allowlist", "@tansy/example-live-preview", "@tansy/example-password-denylist", "@tansy/example-seo-plugin", "@tansy/example-sign-in-alerts"],
  async redirects() {
    return [
      ...MOVED.map((page) => ({ source: `/${page}`, destination: `/dashboard/auth/${page}`, permanent: false })),
      { source: "/account", destination: "/dashboard/account", permanent: false },
    ];
  },
});
