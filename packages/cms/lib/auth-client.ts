import { apiKeyClient } from "@better-auth/api-key/client";
import { passkeyClient } from "@better-auth/passkey/client";
import { adminClient, emailOTPClient, magicLinkClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { apiPath, authPath } from "./paths";

// No baseURL: requests stay on the origin that served the page.
export const authClient = createAuthClient({
  basePath: apiPath("/auth"),
  plugins: [
    adminClient(),
    twoFactorClient({
      onTwoFactorRedirect() {
        const next = new URLSearchParams(window.location.search).get("next") ?? "/";
        window.location.href = authPath(`two-factor?next=${encodeURIComponent(next)}`);
      },
    }),
    magicLinkClient(),
    emailOTPClient(),
    passkeyClient(),
    apiKeyClient(),
  ],
});

/** Only same-site relative paths, so `next` can't be used as an open redirect. */
export function safeNext(value: string | null | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/";
}
