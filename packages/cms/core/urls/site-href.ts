import "server-only";
import { hrefFor } from "../i18n/routing";
import { currentBasePath } from "../scope/context";
import { withBasePath } from "./base-path";

/**
 * `hrefFor` as the site builds addresses: with the scope value's path prefix, such as one
 * tenant's "/acme", when this request is served under one. core/i18n/routing.ts stays free of
 * imports, because the dashboard and headless sites build addresses with it too, so the prefix
 * is added here instead. The dashboard's own addresses go through core/i18n/admin.ts and carry none.
 */
export const siteHrefFor = (localized: { path: string; host?: string }, secure = true) => withBasePath(currentBasePath(), hrefFor(localized, secure));

/** A stored site address, such as a redirect's target, with this request's prefix in front. */
export const siteHref = (path: string) => withBasePath(currentBasePath(), path);
