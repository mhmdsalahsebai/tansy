import { isPasswordCompromised } from "better-auth/plugins/haveibeenpwned";
import { definePlugin } from "tansy/plugin";
import { messages } from "./messages";

/**
 * Refuses passwords found in known breaches, using Have I Been Pwned. Only the
 * first 5 characters of a hash leave the server. Off unless registered, because
 * a fresh install shouldn't call an outside service. A failed lookup refuses the
 * password rather than letting it through unchecked.
 */
export const pwnedPasswords = () => definePlugin({
  name: "pwned-passwords",
  version: "0.1.0",
  apiVersion: 1,
  messages,
  auth: {
    checkPassword: async (password, _settings, { t }) => ((await isPasswordCompromised(password)) ? t("ext.pwned-passwords.breached") : undefined),
  },
});
