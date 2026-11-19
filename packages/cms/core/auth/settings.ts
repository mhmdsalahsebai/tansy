import "server-only";
import type { Prisma } from "../../generated/client-sqlite";
import prisma from "../../lib/prisma";
import { HttpError } from "../http/errors";
import { activeMailer } from "../mail";
import { decryptSecret, encryptSecret } from "./secrets";
import { authSettingsSchema, SECRET_MASK, type AuthSettings } from "./settings-schema";

export { authSettingsSchema, SECRET_MASK, type AuthSettings };

export const AUTH_SETTINGS_KEY = "auth";

function mapSecrets(settings: AuthSettings, transform: (value: string) => string): AuthSettings {
  const next = structuredClone(settings);
  next.mail.password = next.mail.password && transform(next.mail.password);
  for (const provider of Object.values(next.oauth.providers)) {
    provider.clientSecret = provider.clientSecret && transform(provider.clientSecret);
  }
  return next;
}

export async function loadAuthSettings(): Promise<{ settings: AuthSettings; revision: number }> {
  const row = await prisma.appSetting.findUnique({ where: { key: AUTH_SETTINGS_KEY } });
  const parsed = authSettingsSchema.parse(row?.value ?? {});
  return { settings: mapSecrets(parsed, decryptSecret), revision: row?.version ?? 0 };
}

export async function currentRevision(): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: AUTH_SETTINGS_KEY }, select: { version: true } });
  return row?.version ?? 0;
}

/** Secrets never leave the server: the dashboard only learns whether one is set. */
export function maskSettings(settings: AuthSettings): AuthSettings {
  return mapSecrets(settings, () => SECRET_MASK);
}

function restoreMasked(incoming: AuthSettings, current: AuthSettings): AuthSettings {
  const next = structuredClone(incoming);
  if (next.mail.password === SECRET_MASK) next.mail.password = current.mail.password;
  for (const [id, provider] of Object.entries(next.oauth.providers)) {
    if (provider.clientSecret === SECRET_MASK) provider.clientSecret = current.oauth.providers[id]?.clientSecret ?? "";
  }
  return next;
}

export function validateSettingsInvariants(
  settings: AuthSettings,
  roles: Map<string, Set<string>>,
  env: { production: boolean; pluginMail?: boolean } = { production: process.env.NODE_ENV === "production" },
): Array<{ path: string; message: string }> {
  const problems: Array<{ path: string; message: string }> = [];
  const add = (path: string, message: string) => problems.push({ path, message });

  if (settings.password.minLength > settings.password.maxLength) {
    add("password.minLength", "Minimum length cannot exceed maximum length.");
  }
  if (settings.session.refreshAfter >= settings.session.idleTimeout) {
    add("session.refreshAfter", "Refresh interval must be shorter than the idle timeout.");
  }
  if (settings.session.absoluteTimeout < settings.session.idleTimeout) {
    add("session.absoluteTimeout", "Absolute timeout cannot be shorter than the idle timeout.");
  }
  const defaultRole = roles.get(settings.signUp.defaultRole);
  if (!defaultRole) add("signUp.defaultRole", "Role does not exist.");
  else if (defaultRole.has("dashboard:access")) {
    add("signUp.defaultRole", "The default role for new accounts cannot have dashboard access.");
  }
  if (settings.mfa.requireForDashboard && !settings.mfa.totp) {
    add("mfa.totp", "Authenticator apps must stay enabled while MFA is required for the dashboard.");
  }
  if (!settings.methods.password && !settings.methods.passkey) {
    add("methods.password", "Keep password or passkey sign-in enabled, or administrators can be locked out.");
  }
  for (const [id, provider] of Object.entries(settings.oauth.providers)) {
    if (provider.enabled && (!provider.clientId || !provider.clientSecret)) {
      add(`oauth.providers.${id}`, "Client ID and client secret are required to enable this provider.");
    }
  }
  const needsMail = settings.methods.magicLink || settings.methods.emailOtp || settings.emailVerification.required || settings.mfa.emailOtp;
  if (needsMail && env.production && !settings.mail.host && !env.pluginMail) {
    add("mail.host", "Set up email first, with SMTP here or an email plugin: an enabled feature needs to send email.");
  }
  if (settings.mail.host && !settings.mail.fromAddress) add("mail.fromAddress", "Sender address is required with SMTP.");
  return problems;
}

export async function saveAuthSettings(input: AuthSettings, roles: Map<string, Set<string>>, actorId: string) {
  const { settings: current } = await loadAuthSettings();
  const merged = restoreMasked(input, current);
  const mailer = await activeMailer(merged);
  const problems = validateSettingsInvariants(merged, roles, { production: process.env.NODE_ENV === "production", pluginMail: mailer?.kind === "plugin" });
  if (problems.length) throw new HttpError(400, "VALIDATION_FAILED", "Some settings are invalid.", problems);
  const value = mapSecrets(merged, encryptSecret) as unknown as Prisma.InputJsonValue;
  await prisma.appSetting.upsert({
    where: { key: AUTH_SETTINGS_KEY },
    create: { key: AUTH_SETTINGS_KEY, value, updatedById: actorId },
    update: { value, version: { increment: 1 }, updatedById: actorId },
  });
}

/** Rebuilds the auth runtime on every instance. Called after role changes, and settings of plugins that add better-auth plugins. */
export async function bumpAuthRevision() {
  await prisma.appSetting.upsert({
    where: { key: AUTH_SETTINGS_KEY },
    create: { key: AUTH_SETTINGS_KEY, value: {} },
    update: { version: { increment: 1 } },
  });
}
