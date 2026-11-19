import { pluginOrigins } from "./plugin-origins";
import type { AuthSettings } from "../auth/settings-schema";

export function clientIp(headers: Headers, settings: AuthSettings): string | null {
  for (const name of settings.network.ipHeaders) {
    const value = headers.get(name);
    if (value) return value.split(",")[0].trim().slice(0, 64);
  }
  return null;
}

function originMatches(origin: string, pattern: string): boolean {
  if (pattern === origin) return true;
  if (!pattern.includes("*")) return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
  return new RegExp(`^${pattern.includes("://") ? "" : "https?://"}${escaped}$`).test(origin);
}

/** This app's own origin, the owner's list under Settings → Network, and what plugins trust (core/http/plugin-origins.ts). */
export function trustedOrigins(settings: AuthSettings): string[] {
  return [new URL(baseUrl()).origin, ...settings.network.trustedOrigins, ...pluginOrigins()];
}

/** This app's own origin, one an owner listed under trusted origins, or one a plugin trusts. */
export function isTrustedOrigin(origin: string, settings: AuthSettings): boolean {
  return trustedOrigins(settings).some((pattern) => originMatches(origin, pattern));
}

/**
 * Static on purpose: links in emails must never be derived from the Host
 * header (OWASP Forgot Password Cheat Sheet).
 */
export function baseUrl(): string {
  const url = process.env.BETTER_AUTH_URL;
  if (url) return url;
  if (process.env.NODE_ENV === "production") throw new Error("BETTER_AUTH_URL must be set in production");
  return "http://localhost:3000";
}

/** OWASP CSRF: Fetch Metadata first, Origin as the fallback. Missing both is rejected. */
export function isCrossSiteRequest(headers: Headers, settings: AuthSettings): boolean {
  const site = headers.get("sec-fetch-site");
  if (site === "cross-site") return true;
  const origin = headers.get("origin");
  if (origin && origin !== "null") return !isTrustedOrigin(origin, settings);
  return site !== "same-origin";
}
