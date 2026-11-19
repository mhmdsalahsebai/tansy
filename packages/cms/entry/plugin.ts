export * from "../core/extend/define";
export type { AuthExtension } from "../core/auth/extensions";
export type { AccessControlOptions, AuthAccess } from "../core/auth/access";
export type { CaptchaAdapter, CaptchaAuthForm, CaptchaWidgetConfig, ExtensionCaptcha } from "../core/captcha/types";
export type { CspAdditions } from "../core/extend/csp";
export type { EveryPageInfo } from "../core/site/page";
export type { Segment, Translator } from "../core/i18n/segments";
export type { ScopeProvider, ScopeRequest } from "../core/scope/provider";
export type { ScopeLimits } from "../core/scope/limits";
export type { ScopeUsage } from "../core/scope/data";
export { mergeMessagesByLanguage, type Formatters, type MessageValues, type Messages, type Translate } from "../core/i18n/messages";
/**
 * Who a request is: `context.principal`. These are exported by name because a plugin that
 * ships compiled TypeScript has to be able to name them in its own .d.ts.
 */
export type { AnonymousPrincipal, ApiKeyPrincipal, AuthUser, Principal, UserPrincipal } from "../core/authz/principal";
export { siteWords, wordsIn, type SiteWords } from "../core/site/words";
/** Throw from a route handler for a refusal with its own status and code, such as `new HttpError(404, "NOT_FOUND", "No such tenant.")`. Its message reaches the caller. */
export { HttpError } from "../core/http/errors";
/** The CMS's API path, such as "/api/ext/blog/feed.xml" for "/ext/blog/feed.xml", for links a plugin writes into email or a feed. */
export { apiPath } from "../lib/paths";
/** The dashboard's path, such as "/dashboard/ext/tenants" for "/ext/tenants", for links a plugin writes into email. */
export { adminPath } from "../lib/paths";
/** Work to carry on after the response, such as starting a long run: kept alive on hosts that stop functions once they answer, with a deadline to stop by. */
export { afterResponse } from "../core/background/after-response";
