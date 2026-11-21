import { isIP } from "node:net";
import { definePlugin } from "tansy/plugin";

const REPEAT_WINDOW_MS = 10 * 60_000;
const MAX_REMEMBERED = 10_000;

/** A network rather than one address, or every mobile reconnect would raise an alert. */
export function networkOf(ip: string): string {
  if (isIP(ip) === 4) return ip.split(".").slice(0, 3).join(".");
  return ip.toLowerCase().split(":").slice(0, 3).join(":");
}

const recent = new Map<string, number>();

/** Example of `onSignIn`: emails someone the first time they sign in from a new network. A first-ever sign-in has nothing to compare with, so it stays quiet. */
export const signInAlerts = () => definePlugin({
  name: "sign-in-alerts",
  version: "0.1.1",
  apiVersion: 1,
  auth: {
    onSignIn: ({ user, ipAddress, userAgent, previous, settings, sendEmail }) => {
      if (!settings.mail.securityAlerts || !ipAddress || !previous.length) return;
      const network = networkOf(ipAddress);
      if (previous.some((entry) => networkOf(entry.ipAddress) === network)) return;
      // A password step and a second factor are two sessions, but one sign-in.
      const key = `${user.id}|${network}`;
      const now = Date.now();
      if (now - (recent.get(key) ?? 0) < REPEAT_WINDOW_MS) return;
      if (recent.size >= MAX_REMEMBERED) recent.clear();
      recent.set(key, now);
      sendEmail({ subject: "New sign-in to your account", body: `Your account was just used to sign in from ${ipAddress}${userAgent ? ` (${userAgent.slice(0, 200)})` : ""}. If this wasn't you, reset your password now.` });
    },
  },
});
