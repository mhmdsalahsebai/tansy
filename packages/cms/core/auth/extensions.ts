import type { BetterAuthPlugin } from "better-auth";
import type { AuditEvent } from "../audit";
import type { AuthSettings } from "./settings-schema";
import type { MailAdapter } from "../mail";
import type { CaptchaAdapter } from "../captcha/types";
import type { BlockUpgrades } from "../blocks/stream";
import type { FieldDefinition } from "../fields/define";
import type { SearchAdapter } from "../search/types";
import type { StorageConfig } from "../storage/types";
import type { BackupConfig } from "../backup/config";
import type { CspAdditions } from "../extend/csp";
import type { CmsPlugin, ExtensionContext } from "../extend/define";
import type { Translate } from "../i18n/messages";
import type { AdminTheme, ThemeManifest } from "../theme/define";
import type { Principal } from "../authz/principal";
import type { AuthAccess } from "./access";

export type EmailKind = "reset-password" | "password-changed" | "verify-email" | "two-factor-code" | "magic-link" | "email-code" | "mfa-disabled" | "sign-in-alert";

export interface EmailContent { subject: string; body: string }

export interface SignInEvent {
  user: { id: string; email: string; name: string };
  ipAddress: string | null;
  userAgent: string | null;
  /** Earlier successful sign-ins with a known address, newest first, as far back as the audit log goes. */
  previous: Array<{ ipAddress: string; at: Date }>;
  settings: AuthSettings;
  /** Emails this user, in the background. */
  sendEmail(content: EmailContent): void;
}

export interface GuardedRequest {
  surface: "api" | "page";
  principal: Principal;
  ip: string | null;
  method: string;
  path: string;
  headers: Headers;
}

/** The supported way to extend authentication without forking core/auth. It goes under a plugin's `auth`. */
export interface AuthExtension {
  /**
   * Extra better-auth plugins, built from the current dashboard settings and rebuilt when
   * they or the plugin's own settings change. `context` is the plugin's, for callbacks
   * such as a payment provider's webhook handler. Tables and columns these plugins declare
   * are kept in collections named with the plugin's prefix, created on startup. `access` gives
   * a plugin that checks roles core's roles as better-auth access control.
   */
  plugins?: (settings: AuthSettings, context: ExtensionContext, access: AuthAccess) => BetterAuthPlugin[] | Promise<BetterAuthPlugin[]>;
  /**
   * Paths of those better-auth plugins closed to direct HTTP, such as an endpoint that
   * trusts an id from the request body. The plugin's routes still reach them with
   * `context.auth.call`, after their own checks.
   */
  serverOnlyPaths?: string[];
  /**
   * Origins to trust besides the owner's list under Settings → Network, such as the verified
   * domains of a tenant's site, so people can sign in there and its pages can call the API.
   * Each must be a plain http(s) origin, such as "https://client.example", never a pattern.
   * Read again every 30 seconds, or at once after `context.auth.refreshTrustedOrigins()`.
   * Throwing trusts none of this plugin's origins until the next read.
   */
  trustedOrigins?: (context: ExtensionContext) => string[] | Promise<string[]>;
  /** Sign-in providers better-auth supports by name, listed under Settings, OAuth. */
  oauthProviders?: Array<{ id: string; label: string }>;
  /** Shows a component from the plugin's `authWidgets` on the sign-in, sign-up and reset forms. Props reach the browser, so never put secrets in them. */
  authWidget?: { id: string; props?: (settings: AuthSettings) => Record<string, unknown> };
  /**
   * Return a message to refuse a password, on every path that sets one. Throwing refuses it
   * too. `words.t` looks up the plugin's `messages` in the language of the person choosing
   * the password, by full key, such as `t("ext.pwned-passwords.breached")`.
   */
  checkPassword?: (password: string, settings: AuthSettings, words: { locale: string; t: Translate }) => string | void | Promise<string | void>;
  /** Called in the background after a session starts. Impersonation doesn't count. */
  onSignIn?: (event: SignInEvent) => void | Promise<void>;
  /** Changes an email's wording. Return only what should change. */
  emailContent?: (email: EmailContent & { kind: EmailKind; appName: string }, context: ExtensionContext) => Partial<EmailContent> | void | Promise<Partial<EmailContent> | void>;
  /** Return false to refuse a request that passed every normal check. It can only take access away. */
  guardRequest?: (request: GuardedRequest) => boolean | void | Promise<boolean | void>;
  /** Replace SMTP delivery, for example with an email API. */
  mail?: MailAdapter;
  /** A CAPTCHA for the sign-in forms it names and for every plugin's own forms, through `context.captcha`. The first ready one wins. */
  captcha?: CaptchaAdapter;
  /** Forward audit events to a SIEM. Must not throw for control flow. */
  onAudit?: (event: AuditEvent) => void | Promise<void>;
}

export interface CmsConfig {
  /** Custom field types, created with defineField. They appear in the dashboard automatically. */
  fields?: FieldDefinition[];
  /** Per block name and starting version, how to bring a stored block's value up one version. Applied on read. */
  blockUpgrades?: BlockUpgrades;
  /** Where uploaded files are kept. */
  storage?: StorageConfig;
  /** Archives of the database and uploads, made on a schedule or by `tansy backup`, and restored by `tansy restore`. */
  backups?: BackupConfig;
  /** Replaces the built-in database search with an outside engine. */
  search?: SearchAdapter;
  /** Plugins, created with definePlugin. They run as trusted server code. */
  plugins?: CmsPlugin[];
  /** Outside origins the site's own code needs, on top of what plugins declare. */
  csp?: CspAdditions;
  /** The public site's theme. Trusted code, like a plugin. For several themes in one build, use `themes` instead. */
  theme?: ThemeManifest;
  /**
   * Several themes in one build, the first being the default. A scope value, such as a tenant,
   * then picks its own under Site. Set this or `theme`, not both. Changing the list means a rebuild.
   */
  themes?: ThemeManifest[];
  /** The admin's colours and logo, as design tokens. */
  adminTheme?: AdminTheme;
  /** A headless site's preview route, such as https://example.com/api/preview. It receives ?token=. Without it, previews open in this app. */
  previewUrl?: string;
}

export const defineCms = (config: CmsConfig): CmsConfig => config;
