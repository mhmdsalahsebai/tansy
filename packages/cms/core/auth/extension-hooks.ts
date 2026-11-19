import "server-only";
import { authExtensions as extensions } from "../config";
import type { Principal } from "../authz/principal";
import prisma from "../../lib/prisma";
import type { EmailContent, EmailKind, GuardedRequest } from "./extensions";
import type { AuthSettings } from "./settings-schema";

const context = (name: string) => import("../extend/hooks").then(({ extensionContext }) => extensionContext(`plugin:${name}`));

/** Providers some extension has registered. Settings for anything else are ignored. */
export const oauthProviders = () => extensions().flatMap((e) => e.oauthProviders ?? []);

export const authWidgets = (settings: AuthSettings) => extensions().flatMap((e) => (e.authWidget ? [{ id: e.authWidget.id, props: e.authWidget.props?.(settings) ?? {} }] : []));

/** The first refusal, as a message for the person choosing the password, in their interface language. */
export async function passwordProblem(password: string, settings: AuthSettings): Promise<string | null> {
  const checks = extensions().filter((extension) => extension.checkPassword);
  if (!checks.length) return null;
  // Imported here, as the i18n module reads the config this one is loaded by. Outside a
  // request, such as in a script, there's no person to ask, so the default language.
  const i18n = await import("../i18n/admin");
  const { locale, t } = await i18n.getT().catch(() => i18n.wordsIn(i18n.ADMIN_DEFAULT));
  for (const extension of checks) {
    const problem = await extension.checkPassword?.(password, settings, { locale, t });
    if (problem) return problem;
  }
  return null;
}

/** Extensions change the words only. Links and codes are added afterwards, so a template can't lose or alter one. Never fails: mail goes out as written. */
export async function composeEmail(kind: EmailKind, content: EmailContent, settings: AuthSettings): Promise<EmailContent> {
  let current = content;
  for (const extension of extensions()) {
    if (!extension.emailContent) continue;
    try {
      current = { ...current, ...(await extension.emailContent({ kind, ...current, appName: settings.general.appName }, await context(extension.name))) };
    } catch (error) {
      console.error(`[extension:${extension.name}] email content failed`, error);
    }
  }
  return current;
}

const SIGN_IN_ACTIONS = ["auth.sign_in", "auth.sign_in_oauth", "auth.sign_in_magic_link", "auth.sign_in_email_otp", "auth.sign_in_passkey", "auth.mfa_verified"];

export async function runSignInHooks(
  session: { userId: string; ipAddress?: string | null; userAgent?: string | null },
  settings: AuthSettings,
  sendEmail: (to: string, kind: EmailKind, content: EmailContent) => void,
) {
  const listening = extensions().filter((e) => e.onSignIn);
  if (!listening.length) return;
  const [user, previous] = await Promise.all([
    prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, email: true, name: true } }),
    prisma.auditLog.findMany({ where: { actorId: session.userId, outcome: "success", action: { in: SIGN_IN_ACTIONS }, ipAddress: { not: null } }, orderBy: { at: "desc" }, take: 50, select: { ipAddress: true, at: true } }),
  ]);
  if (!user) return;
  for (const extension of listening) {
    void Promise.resolve()
      .then(() => extension.onSignIn!({
        user,
        ipAddress: session.ipAddress ?? null,
        userAgent: session.userAgent ?? null,
        previous: previous.map((entry) => ({ ipAddress: entry.ipAddress!, at: entry.at })),
        settings,
        sendEmail: (content) => sendEmail(user.email, "sign-in-alert", content),
      }))
      .catch((error) => console.error(`[extension:${extension.name}] onSignIn failed`, error));
  }
}

/** Extensions can only refuse, never grant, as this runs after the normal checks. A guard that fails counts as a refusal. */
export async function requestAllowed(request: Omit<GuardedRequest, "principal"> & { principal: Principal }): Promise<boolean> {
  for (const extension of extensions()) {
    if (!extension.guardRequest) continue;
    try {
      if ((await extension.guardRequest(request)) === false) return false;
    } catch (error) {
      console.error(`[extension:${extension.name}] guardRequest failed; denying`, error);
      return false;
    }
  }
  return true;
}
