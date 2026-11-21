import { z } from "zod";
import { definePlugin, mergeMessagesByLanguage, type CaptchaAuthForm, type CspAdditions, type ExtensionContext, type PluginSettingField } from "tansy/plugin";
import { messages } from "./messages";
import type { CaptchaProvider, CaptchaSettings } from "./provider";

export type { CaptchaProvider } from "./provider";

export interface CaptchaOptions {
  /**
   * The providers the site can use, each from its own package, such as `turnstile()`
   * from @tansy/captcha-turnstile. Owners choose one under Extensions → CAPTCHA.
   */
  providers: CaptchaProvider[];
  /** Which of them is used until changed in the settings. The first when left out. */
  provider?: string;
  /** The sign-in forms that ask for it until changed in the settings. All three when left out. */
  authForms?: CaptchaAuthForm[];
}

const PROVIDER_ID = /^[a-z][a-z0-9]{0,19}$/;
const FORMS = ["signin", "signup", "forgot-password"] as const;

const optionsSchema = z.strictObject({
  providers: z.array(z.object({ id: z.string().regex(PROVIDER_ID, "A provider's id is lowercase letters and digits."), label: z.string().min(1) }).loose()).min(1, "Add at least one provider, such as turnstile() from @tansy/captcha-turnstile."),
  provider: z.string(),
  authForms: z.array(z.enum(FORMS)),
}).superRefine((value, issues) => {
  const ids = value.providers.map((provider) => provider.id);
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice) issues.addIssue({ code: "custom", path: ["providers"], message: `The provider "${twice}" is listed twice.` });
  if (!ids.includes(value.provider)) issues.addIssue({ code: "custom", path: ["provider"], message: `"${value.provider}" isn't one of the providers listed.` });
});

const settingsOf = async (context: ExtensionContext) => (await context.settings.get()) as unknown as CaptchaSettings;

const sharedSettings = (value: { provider: string; authForms: CaptchaAuthForm[] }, providers: CaptchaProvider[]): PluginSettingField[] => [
  { name: "provider", type: "select", default: value.provider, label: "Provider", description: "Who checks that a person is filling in the form. Fill in that provider's keys below. Until they're set, forms go without a CAPTCHA.", options: providers.map((provider) => ({ value: provider.id, label: provider.label })) },
  { name: "signIn", type: "boolean", default: value.authForms.includes("signin"), label: "Ask on sign-in", description: "Slows down password guessing. Lockout after failed attempts applies either way." },
  { name: "signUp", type: "boolean", default: value.authForms.includes("signup"), label: "Ask on sign-up", description: "Keeps scripts from creating accounts." },
  { name: "passwordReset", type: "boolean", default: value.authForms.includes("forgot-password"), label: "Ask on password reset", description: "Keeps scripts from sending reset emails to people who didn't ask." },
];

/** Every setting's name starts with its provider's id, so two providers can't claim one. */
function providerSettings(providers: CaptchaProvider[]) {
  return providers.flatMap((provider) => provider.settings().map((field) => {
    if (!field.name.startsWith(provider.id)) throw new Error(`CAPTCHA provider "${provider.id}": the setting "${field.name}" must start with "${provider.id}".`);
    return field;
  }));
}

/** Every installed provider's origins, as the provider can change without a rebuild. */
function cspOf(providers: CaptchaProvider[]): CspAdditions {
  const all = (key: keyof CspAdditions) => [...new Set(providers.flatMap((provider) => provider.csp[key] ?? []))];
  return { frame: all("frame"), connect: all("connect"), img: all("img") };
}

/**
 * Checks that a person, not a script, is filling in a form: the sign-in forms chosen in
 * the settings, and any plugin's own forms through `context.captcha`, such as Forms. One
 * adapter package per provider. See docs/plugins/captcha.md.
 */
export function captcha(options: CaptchaOptions) {
  const value = optionsSchema.parse({ provider: options.providers?.[0]?.id, authForms: [...FORMS], ...Object.fromEntries(Object.entries(options).filter(([, option]) => option !== undefined)) });
  const providers = options.providers;
  const byId = new Map(providers.map((provider) => [provider.id, provider]));

  /** The provider in use, once its keys are set. */
  const current = async (context: ExtensionContext) => {
    const settings = await settingsOf(context);
    const provider = byId.get(settings.provider);
    return provider?.ready(settings) ? { provider, settings } : null;
  };

  return definePlugin({
    name: "captcha",
    version: "0.1.1",
    apiVersion: 1,
    requires: { cms: "^0.1.1" },
    options: { schema: optionsSchema, value },
    messages: mergeMessagesByLanguage(messages, ...providers.map((provider) => provider.messages)),
    settings: { fields: [...sharedSettings(value, providers), ...providerSettings(providers)] },
    csp: cspOf(providers),
    auth: {
      captcha: {
        ready: async (context) => (await current(context)) !== null,
        async widget(context) {
          const active = await current(context);
          if (!active) throw new Error("[captcha] The provider isn't set up.");
          return { provider: active.provider.id, ...active.provider.widget(active.settings) };
        },
        async verify(answer, request, context) {
          const active = await current(context);
          return active ? active.provider.verify(answer, request, active.settings) : false;
        },
        async authForms(context) {
          const settings = await settingsOf(context);
          return FORMS.filter((form) => ({ signin: settings.signIn, signup: settings.signUp, "forgot-password": settings.passwordReset })[form] === true);
        },
      },
    },
  });
}
