import type { CaptchaWidgetConfig, CspAdditions, Messages, PluginSettingField } from "tansy/plugin";

/**
 * What a CAPTCHA provider adapter implements, such as @tansy/captcha-turnstile. The
 * CAPTCHA plugin keeps what providers share: choosing one, which forms ask for it, and
 * handing it to core. An adapter only describes its widget and checks one answer. See
 * docs/plugins/captcha.md.
 */

/** The CAPTCHA plugin's own settings, and each installed provider's, by name. */
export interface CaptchaSettings {
  /** The id of the provider in use. */
  provider: string;
  signIn: boolean;
  signUp: boolean;
  passwordReset: boolean;
  [name: string]: unknown;
}

export interface CaptchaProvider {
  /** Lowercase letters and digits, such as "turnstile". Every setting's name starts with it. */
  id: string;
  label: string;
  /** Its keys on the CAPTCHA plugin's settings. */
  settings(): PluginSettingField[];
  /**
   * Its settings' words in other interface languages, by language code, as
   * `{ ar: { settings: { <name>: { label, description } } } }`. CAPTCHA adds them to its own
   * `messages`, and the setting's `label` and `description` cover any language missing.
   */
  messages?: Record<string, Messages>;
  /** Whether the keys it needs are set. */
  ready(settings: CaptchaSettings): boolean;
  /** What the browser shows. Public: never a secret. */
  widget(settings: CaptchaSettings): Omit<CaptchaWidgetConfig, "provider">;
  /** Asks the provider whether the answer is good. */
  verify(answer: string, request: { ip: string | null }, settings: CaptchaSettings): Promise<boolean>;
  /** The origins its widget frames and calls, added to the Content Security Policy. */
  csp: CspAdditions;
}

/** Types an adapter. */
export const defineCaptchaProvider = (provider: CaptchaProvider): CaptchaProvider => provider;

const TIMEOUT_MS = 10_000;

/**
 * The siteverify call Turnstile, hCaptcha and reCAPTCHA share: a form post of the secret
 * and the answer, answered with `{ success }`. Anything else, a redirect, a timeout or
 * an error status, refuses. What the provider says beyond `success` is never logged.
 */
export async function siteVerify(url: string, fields: Record<string, string | null | undefined>, fetcher: typeof fetch = fetch): Promise<boolean> {
  const body = new URLSearchParams(Object.entries(fields).flatMap(([name, value]) => (value ? [[name, value]] : [])));
  let response: Response;
  try {
    response = await fetcher(url, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    console.error(`[captcha] ${new URL(url).host} couldn't be reached`);
    return false;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    console.error(`[captcha] ${new URL(url).host} answered ${response.status}`);
    return false;
  }
  try {
    const answer = (await response.json()) as { success?: unknown };
    return answer?.success === true;
  } catch {
    return false;
  }
}

export const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
