import { definePlugin } from "tansy/plugin";

/**
 * Sign-in through these providers, each configured under Settings, OAuth. Remove
 * this from tansy.config.ts to offer none. For one better-auth has no built-in
 * support for, add its generic OAuth plugin under `plugins`.
 */
export const socialSignIn = () => definePlugin({
  name: "social-sign-in",
  version: "0.1.0",
  apiVersion: 1,
  auth: {
    oauthProviders: [
      { id: "google", label: "Google" },
      { id: "github", label: "GitHub" },
      { id: "microsoft", label: "Microsoft" },
      { id: "gitlab", label: "GitLab" },
      { id: "discord", label: "Discord" },
      { id: "facebook", label: "Facebook" },
    ],
  },
});
