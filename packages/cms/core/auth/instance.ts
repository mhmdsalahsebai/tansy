import "server-only";
import { mailWords } from "../i18n/admin";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { admin, bearer, emailOTP, magicLink, twoFactor } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { authExtensions } from "../config";
import { emitEvent } from "../extend/events";
import { audit } from "../audit";
import { allStatements, scopedCollectionId, toStatements } from "../authz/permissions";
import { isLocalePermission } from "../i18n/permissions";
import { buildRoleMap, buildScopedRoleMap, loadRoles, permissionsForRole, type RoleMap } from "../authz/roles";
import { baseUrl, clientIp, trustedOrigins } from "../http/request";
import { refreshPluginOrigins } from "../http/plugin-origins";
import { authEmail, queueMail } from "../mail";
import { hashPassword, verifyPassword } from "../../lib/argon2";
import prisma from "../../lib/prisma";
import { isPostgres } from "../../lib/prisma/kind";
import { clearFailures, isLocked, recordFailure } from "./lockout";
import { ACCOUNT_CHANGING_PATHS, ACCOUNT_RECOVERY_PATHS, isSharedAccount, SHARED_ACCOUNT_MESSAGE, sharedAccounts } from "./shared-accounts";
import { currentRevision, loadAuthSettings, type AuthSettings } from "./settings";
import { SERVER_ONLY_PATHS } from "./server-only-paths";
import { composeEmail, oauthProviders, passwordProblem, runSignInHooks } from "./extension-hooks";
import type { EmailContent, EmailKind } from "./extensions";
import type { BetterAuthPlugin } from "better-auth";
import { routePluginModels } from "./plugin-adapter";
import { authAccess, type AuthAccess } from "./access";
import { ensurePluginCollections, planPluginModels, prismaModels, type PluginModel } from "./plugin-models";
import { apiPath } from "../../lib/paths";
import { checkAuthRequest } from "../captcha";

/**
 * Asks for the CAPTCHA's answer on the sign-in forms a plugin's `auth.captcha` guards. It
 * runs on the raw request, before better-auth routes it, as better-auth's own captcha does.
 */
function captchaGate(s: AuthSettings): BetterAuthPlugin {
  const base = apiPath("/auth");
  return {
    id: "cms-captcha",
    onRequest: async (request) => {
      if (request.method !== "POST") return;
      const pathname = new URL(request.url).pathname;
      const path = `/${(pathname.startsWith(base) ? pathname.slice(base.length) : pathname).replace(/\/{2,}/g, "/").replace(/^\/|\/$/g, "")}`;
      const refusal = await checkAuthRequest(path, request.headers.get("x-captcha-response"), clientIp(request.headers, s));
      if (!refusal) return;
      return { response: new Response(JSON.stringify({ code: refusal.code, message: refusal.message }), { status: refusal.status, headers: { "content-type": "application/json" } }) };
    },
  };
}

function disabledPaths(s: AuthSettings): string[] {
  return [
    ...SERVER_ONLY_PATHS,
    ...authExtensions().flatMap((e) => e.serverOnlyPaths ?? []),
    ...(s.methods.password ? [] : ["/sign-in/email", "/sign-up/email"]),
    ...(s.methods.magicLink ? [] : ["/sign-in/magic-link", "/magic-link/verify"]),
    ...(s.methods.emailOtp ? [] : ["/sign-in/email-otp"]),
    ...(s.methods.passkey ? [] : ["/passkey/generate-authenticate-options", "/passkey/verify-authentication", "/passkey/generate-register-options", "/passkey/verify-registration"]),
    ...(s.mfa.totp ? [] : ["/two-factor/enable", "/two-factor/get-totp-uri"]),
    ...(s.mfa.emailOtp ? [] : ["/two-factor/send-otp", "/two-factor/verify-otp"]),
  ];
}

/** better-auth only challenges 2FA on password sign-in; these paths would skip it. */
const SINGLE_FACTOR_PATHS = new Set(["/callback/:id", "/oauth2/callback/:id", "/magic-link/verify", "/sign-in/email-otp"]);

const PASSWORD_PATHS = new Set(["/sign-up/email", "/change-password", "/set-password", "/reset-password", "/email-otp/reset-password", "/admin/create-user", "/admin/set-user-password"]);

const AUDITED_PATHS: Record<string, string> = {
  "/sign-in/email": "auth.sign_in",
  "/sign-up/email": "auth.sign_up",
  "/sign-out": "auth.sign_out",
  "/sign-in/magic-link": "auth.magic_link_requested",
  "/magic-link/verify": "auth.sign_in_magic_link",
  "/sign-in/email-otp": "auth.sign_in_email_otp",
  "/callback/:id": "auth.sign_in_oauth",
  "/passkey/verify-authentication": "auth.sign_in_passkey",
  "/passkey/verify-registration": "auth.passkey_added",
  "/passkey/delete-passkey": "auth.passkey_removed",
  "/request-password-reset": "auth.password_reset_requested",
  "/reset-password": "auth.password_reset",
  "/change-password": "auth.password_changed",
  "/verify-email": "auth.email_verified",
  "/two-factor/enable": "auth.mfa_enable_started",
  "/two-factor/disable": "auth.mfa_disabled",
  "/two-factor/verify-totp": "auth.mfa_verified",
  "/two-factor/verify-otp": "auth.mfa_verified",
  "/two-factor/verify-backup-code": "auth.mfa_backup_code_used",
  "/two-factor/generate-backup-codes": "auth.mfa_backup_codes_regenerated",
  "/revoke-session": "auth.session_revoked",
  "/revoke-sessions": "auth.sessions_revoked",
  "/revoke-other-sessions": "auth.sessions_revoked",
  "/admin/stop-impersonating": "auth.impersonation_stopped",
};

/** Each CMS plugin's better-auth plugins, built from the current settings with the plugin's own context. */
interface ExtensionPlugins { name: string; plugins: BetterAuthPlugin[] }

const extensionContextFor = (name: string) => import("../extend/hooks").then(({ extensionContext }) => extensionContext(`plugin:${name}`));

async function buildExtensionPlugins(s: AuthSettings, access: AuthAccess): Promise<ExtensionPlugins[]> {
  return Promise.all(authExtensions().map(async (e) => ({ name: e.name, plugins: e.plugins ? await e.plugins(s, await extensionContextFor(e.name), access) : [] })));
}

function createAuthInstance(s: AuthSettings, roleMap: RoleMap, extensions: ExtensionPlugins[] = [], models: PluginModel[] = []) {
  const ac = createAccessControl(allStatements());
  // better-auth checks only its own user and session statements, so per-collection grants stay on our side.
  const roles = Object.fromEntries([...roleMap].map(([name, permissions]) => [name, ac.newRole(toStatements([...permissions].filter((p) => scopedCollectionId(p) === null && !isLocalePermission(p))))]));
  const url = baseUrl();
  const appName = s.general.appName;
  // In the background, as awaiting it would reveal through timing whether an account exists.
  // Written in the recipient's chosen language, by key under `mail` in the catalogs. Email templates can still replace the text.
  type MailKey = "resetPassword" | "passwordReset" | "passwordChanged" | "verifyEmail" | "mfaDisabled" | "twoFactorCode" | "magicLink" | "emailCode";
  const mail = (kind: EmailKind, to: string, key: MailKey, link?: string, code?: string) => {
    void mailWords(to).then(async ({ locale, direction, t }) => {
      const content: EmailContent = await composeEmail(kind, { subject: t(`mail.${key}.subject`), body: t(`mail.${key}.body`) }, s);
      const action = link ? { label: t(`mail.${key}.action`), url: link } : undefined;
      queueMail({ ...authEmail(to, appName, content.subject, content.body, action, code, { locale, direction, ignoreNotice: t("mail.ignoreNotice") }), kind: `auth:${kind}` }, s);
    }).catch((error) => console.error("[mail] could not compose", error));
  };
  // Text a plugin already wrote, such as a sign-in alert: sent as it is, marked with the recipient's language.
  const mailWritten = (kind: EmailKind, to: string, content: EmailContent) => {
    void mailWords(to).then(async ({ locale, direction, t }) => {
      const composed = await composeEmail(kind, content, s);
      queueMail({ ...authEmail(to, appName, composed.subject, composed.body, undefined, undefined, { locale, direction, ignoreNotice: t("mail.ignoreNotice") }), kind: `auth:${kind}` }, s);
    }).catch((error) => console.error("[mail] could not compose", error));
  };

  const socialProviders = Object.fromEntries(
    oauthProviders().filter(({ id }) => s.oauth.providers[id]?.enabled).map(({ id }) => [
      id,
      { clientId: s.oauth.providers[id].clientId, clientSecret: s.oauth.providers[id].clientSecret, disableSignUp: !s.signUp.enabled },
    ]),
  );

  const extensionPlugins = extensions.flatMap((e) => e.plugins) as unknown as never[];
  const authRule = { window: s.rateLimit.authWindow, max: s.rateLimit.authMax };

  return betterAuth({
    appName,
    baseURL: url,
    basePath: apiPath("/auth"),
    secret: process.env.BETTER_AUTH_SECRET,
    // Models that plugins' better-auth plugins add are kept in collections. See plugin-models.ts.
    database: routePluginModels(models, async (name) => (await extensionContextFor(name)).system.records, prismaAdapter(prisma, { provider: isPostgres() ? "postgresql" : "sqlite" })),
    // A function, so origins plugins add later, such as a tenant's newly verified domain, count without a rebuild.
    trustedOrigins: async () => {
      await refreshPluginOrigins();
      return trustedOrigins(s);
    },
    disabledPaths: disabledPaths(s),
    telemetry: { enabled: false },

    emailAndPassword: {
      enabled: true,
      disableSignUp: !s.signUp.enabled,
      requireEmailVerification: s.emailVerification.required,
      autoSignIn: false,
      minPasswordLength: s.password.minLength,
      maxPasswordLength: s.password.maxLength,
      resetPasswordTokenExpiresIn: s.password.resetTokenTtl,
      revokeSessionsOnPasswordReset: s.password.revokeSessionsOnReset,
      password: { hash: hashPassword, verify: ({ hash, password }) => verifyPassword(hash, password) },
      sendResetPassword: async ({ user, url: link }) =>
        mail("reset-password", user.email, "resetPassword", link),
      onPasswordReset: async ({ user }) => {
        if (s.mail.securityAlerts) mail("password-changed", user.email, "passwordReset");
      },
    },
    emailVerification: {
      sendOnSignUp: s.emailVerification.required,
      sendOnSignIn: s.emailVerification.required,
      autoSignInAfterVerification: false,
      expiresIn: s.emailVerification.tokenTtl,
      sendVerificationEmail: async ({ user, url: link }) =>
        mail("verify-email", user.email, "verifyEmail", link),
    },
    socialProviders,
    account: {
      encryptOAuthTokens: true,
      accountLinking: { enabled: s.oauth.allowAccountLinking },
    },
    verification: { storeIdentifier: "hashed" },
    session: {
      expiresIn: s.session.idleTimeout,
      updateAge: s.session.refreshAfter,
      freshAge: s.session.freshFor,
      // Off so that revoking or banning takes effect on the very next request.
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: s.rateLimit.enabled,
      window: s.rateLimit.window,
      max: s.rateLimit.max,
      storage: "database",
      customRules: {
        "/sign-in/*": authRule,
        "/sign-up/*": authRule,
        "/request-password-reset": authRule,
        "/reset-password": authRule,
        "/email-otp/*": authRule,
        "/two-factor/*": authRule,
        "/magic-link/*": authRule,
      },
    },
    advanced: {
      useSecureCookies: url.startsWith("https://"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
      ipAddress: { ipAddressHeaders: s.network.ipHeaders, trustedProxies: s.network.trustedProxies },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const domain = user.email.split("@").pop()?.toLowerCase() ?? "";
            const { allowedDomains, blockedDomains } = s.signUp;
            if (blockedDomains.includes(domain) || (allowedDomains.length > 0 && !allowedDomains.includes(domain))) {
              throw new APIError("FORBIDDEN", { message: "This email domain is not allowed.", code: "EMAIL_DOMAIN_NOT_ALLOWED" });
            }
          },
          after: async (user) => {
            emitEvent("auth.afterSignUp", { user: { id: user.id, email: user.email } });
          },
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            if (!ctx || !SINGLE_FACTOR_PATHS.has(ctx.path)) return;
            const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { role: true, twoFactorEnabled: true, email: true } });
            const privileged = s.mfa.requireForDashboard && permissionsForRole(roleMap, user?.role).has("dashboard:access");
            if (user?.twoFactorEnabled || privileged) {
              await audit({ action: "auth.single_factor_blocked", outcome: "denied", actorId: session.userId, actorEmail: user?.email, metadata: { path: ctx.path } });
              throw new APIError("FORBIDDEN", { message: "Sign in with your password and second factor.", code: "SECOND_FACTOR_REQUIRED" });
            }
          },
          after: async (session) => {
            if ((session as { impersonatedBy?: string | null }).impersonatedBy) return;
            emitEvent("auth.afterSignIn", { user: { id: session.userId } });
            await runSignInHooks(session, s, (to, kind, content) => mailWritten(kind, to, content)).catch((error) => console.error("[extensions] sign-in hooks failed", error));
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (PASSWORD_PATHS.has(ctx.path)) {
          const password = ctx.body?.newPassword ?? ctx.body?.password;
          const problem = typeof password === "string" ? await passwordProblem(password, s) : null;
          if (problem) throw new APIError("BAD_REQUEST", { message: problem, code: "PASSWORD_REJECTED" });
        }
        if (sharedAccounts().size) {
          const named = typeof ctx.body?.email === "string" ? ctx.body.email : null;
          const shared = ACCOUNT_RECOVERY_PATHS.has(ctx.path)
            ? isSharedAccount(named)
            : ACCOUNT_CHANGING_PATHS.has(ctx.path) && isSharedAccount((await getSessionFromCtx(ctx))?.user.email);
          if (shared) throw new APIError("FORBIDDEN", { message: SHARED_ACCOUNT_MESSAGE, code: "SHARED_ACCOUNT" });
        }
        if (ctx.path !== "/sign-in/email" || !s.lockout.enabled) return;
        const email = typeof ctx.body?.email === "string" ? ctx.body.email : "";
        // Its password is handed out, so a lockout would only let one visitor shut out the rest.
        if (isSharedAccount(email)) return;
        // Applies to unknown emails too, so a lockout never confirms an account exists.
        if (email && (await isLocked(email))) {
          await audit({ action: "auth.sign_in_locked", outcome: "denied", actorEmail: email, ipAddress: ctx.request ? clientIp(ctx.request.headers, s) : null });
          throw new APIError("TOO_MANY_REQUESTS", { message: "Too many attempts. Try again later or reset your password.", code: "ACCOUNT_LOCKED" });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const action = AUDITED_PATHS[ctx.path];
        if (!action) return;
        const returned = ctx.context.returned;
        const failed = returned instanceof Error;
        const email = typeof ctx.body?.email === "string" ? ctx.body.email : undefined;
        const headers = ctx.request?.headers;

        let locked = false;
        if (ctx.path === "/sign-in/email" && email && s.lockout.enabled && !isSharedAccount(email)) {
          if (failed) locked = (await recordFailure(email, s.lockout)).locked;
          else await clearFailures(email);
        }

        const session = ctx.context.newSession ?? ctx.context.session;
        await audit({
          action,
          outcome: failed ? "failure" : "success",
          actorId: session?.user.id ?? null,
          actorEmail: session?.user.email ?? email ?? null,
          ipAddress: headers ? clientIp(headers, s) : null,
          userAgent: headers?.get("user-agent"),
          metadata: locked ? { locked } : undefined,
        });

        if (!failed && ctx.path === "/sign-out") emitEvent("auth.afterSignOut", { user: { id: session?.user.id ?? null } });

        if (!failed && s.mail.securityAlerts && session?.user.email) {
          if (ctx.path === "/change-password") mail("password-changed", session.user.email, "passwordChanged");
          if (ctx.path === "/two-factor/disable") mail("mfa-disabled", session.user.email, "mfaDisabled");
        }
      }),
    },
    plugins: [
      captchaGate(s),
      admin({
        ac,
        roles,
        defaultRole: s.signUp.defaultRole,
        adminRoles: [...roleMap].filter(([, p]) => p.has("dashboard:access")).map(([name]) => name),
        impersonationSessionDuration: s.session.impersonationDuration,
      }),
      twoFactor({
        issuer: appName,
        otpOptions: {
          storeOTP: "hashed",
          sendOTP: async ({ user, otp }) => mail("two-factor-code", user.email, "twoFactorCode", undefined, otp),
        },
        backupCodeOptions: { storeBackupCodes: "encrypted" },
      }),
      magicLink({
        disableSignUp: !s.signUp.enabled,
        expiresIn: 300,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url: link }) => mail("magic-link", email, "magicLink", link),
      }),
      emailOTP({
        disableSignUp: !s.signUp.enabled,
        otpLength: 8,
        expiresIn: 300,
        allowedAttempts: 3,
        storeOTP: "hashed",
        sendVerificationOTP: async ({ email, otp }) => mail("email-code", email, "emailCode", undefined, otp),
      }),
      passkey({
        rpID: new URL(url).hostname,
        rpName: appName,
        origin: new URL(url).origin,
        authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      }),
      apiKey({
        defaultPrefix: "cms_",
        requireName: true,
        rateLimit: { enabled: false },
        permissions: { defaultPermissions: {} },
        // Only core's own routes write it (every /api-key path is server-only): the scope value a key is bound to.
        enableMetadata: true,
      }),
      ...(s.methods.bearer ? [bearer({ requireSignature: true })] : []),
      ...extensionPlugins,
    ],
  });
}

export type AuthInstance = ReturnType<typeof createAuthInstance>;

export interface AuthRuntime {
  auth: AuthInstance;
  settings: AuthSettings;
  roles: RoleMap;
  /** Roles a scope provider gives within one scope value. Never instance roles. */
  scopedRoles: RoleMap;
  revision: number;
  /** By CMS plugin, the paths of the better-auth endpoints its plugins added, each with its `auth.api` name. */
  extensionEndpoints: Map<string, Map<string, string>>;
  /** By CMS plugin, the `auth.api` names of every endpoint its plugins added, those with no path included. */
  extensionEndpointNames: Map<string, Set<string>>;
}

/** Which CMS plugin added each better-auth endpoint, so a plugin's routes can call only their own. */
function endpointsByPlugin(extensions: ExtensionPlugins[]) {
  return new Map(extensions.map(({ name, plugins }) => [name, new Map(plugins.flatMap((plugin) =>
    Object.entries(plugin.endpoints ?? {}).flatMap(([key, endpoint]) => {
      const path = (endpoint as { path?: unknown }).path;
      return typeof path === "string" ? [[path, key] as const] : [];
    })))]));
}

function endpointNamesByPlugin(extensions: ExtensionPlugins[]) {
  return new Map(extensions.map(({ name, plugins }) => [name, new Set(plugins.flatMap((plugin) => Object.keys(plugin.endpoints ?? {})))]));
}

async function build(): Promise<AuthRuntime> {
  const [{ settings, revision }, roles] = await Promise.all([loadAuthSettings(), loadRoles()]);
  const roleMap = buildRoleMap(roles);
  const scopedRoles = buildScopedRoleMap(roles);
  const extensions = await buildExtensionPlugins(settings, authAccess(roleMap, scopedRoles));
  const models = planPluginModels(extensions, prismaModels());
  await ensurePluginCollections(models);
  return { auth: createAuthInstance(settings, roleMap, extensions, models), settings, roles: roleMap, scopedRoles, revision, extensionEndpoints: endpointsByPlugin(extensions), extensionEndpointNames: endpointNamesByPlugin(extensions) };
}

/** Short enough that dashboard changes reach every instance within seconds. */
const REVISION_CHECK_MS = 2000;

let cache: { promise: Promise<AuthRuntime>; checkedAt: number } | undefined;

/**
 * The only way to obtain a better-auth instance. It is rebuilt whenever
 * dashboard settings or roles change, because better-auth's options are fixed
 * at creation.
 */
export async function getRuntime(): Promise<AuthRuntime> {
  if (!cache) {
    cache = { promise: build(), checkedAt: Date.now() };
    cache.promise.catch(() => { cache = undefined; });
    return cache.promise;
  }
  if (Date.now() - cache.checkedAt > REVISION_CHECK_MS) {
    cache.checkedAt = Date.now();
    const [runtime, revision] = await Promise.all([cache.promise, currentRevision()]);
    if (runtime.revision !== revision) {
      cache = { promise: build(), checkedAt: Date.now() };
      cache.promise.catch(() => { cache = undefined; });
    }
  }
  return cache.promise;
}

export function invalidateRuntime() {
  cache = undefined;
}
