/**
 * What plugins may add to the Content Security Policy. No server imports, as
 * proxy.ts loads this on every request.
 *
 * Scripts are deliberately absent. `script-src` uses 'strict-dynamic', so a script
 * a plugin's component inserts is trusted through the app's own nonce, and a host
 * list would be ignored anyway. Sources are exact origins, never keywords or
 * wildcards, so a plugin can't weaken the policy for the whole site.
 */
export interface CspAdditions {
  frame?: string[];
  connect?: string[];
  img?: string[];
}

const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

export function defineCsp(additions: CspAdditions): CspAdditions {
  for (const source of Object.values(additions).flat()) {
    if (!ORIGIN.test(source)) throw new Error(`Invalid Content Security Policy source "${source}". Use an origin such as https://example.com.`);
  }
  return additions;
}

const list = (values: string[] | undefined) => (values?.length ? ` ${values.join(" ")}` : "");

export function contentSecurityPolicy(nonce: string, isApi: boolean, additions: CspAdditions = {}, env: { dev: boolean; https: boolean }): string {
  if (isApi) return "default-src 'none'; frame-ancestors 'none'";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${env.dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${list(additions.img)}`,
    "font-src 'self'",
    `connect-src 'self'${env.dev ? " ws:" : ""}${list(additions.connect)}`,
    ...(additions.frame?.length ? [`frame-src${list(additions.frame)}`] : []),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(env.https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}
