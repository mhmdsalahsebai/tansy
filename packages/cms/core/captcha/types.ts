import type { ExtensionContext } from "../extend/define";

/** The sign-in forms a CAPTCHA can guard, by the name `AuthWidgetProps.form` uses. */
export type CaptchaAuthForm = "signin" | "signup" | "forgot-password";

/**
 * What a browser needs to show the CAPTCHA: everything here is public, so never put a
 * secret in it. Turnstile, hCaptcha and reCAPTCHA share one way of working: a script
 * defines a global with `render(element, options)` and `reset(id)`, and calls back with
 * an answer, which the server then checks with the provider.
 */
export interface CaptchaWidgetConfig {
  /** Which provider, such as "turnstile", for a site that styles each one. */
  provider: string;
  /** The provider's script, https only. `onload=` is added to it. */
  script: string;
  /** The global the script defines, such as "turnstile". Letters only. */
  global: string;
  siteKey: string;
  /** More render options, such as `{ theme: "light" }`. */
  options?: Record<string, string | number | boolean>;
}

/**
 * Checks that a person, not a script, filled in a form, under a plugin's `auth.captcha`,
 * such as @tansy/captcha. Core uses the first ready one on the sign-in forms it names,
 * and offers it to every plugin as `context.captcha`.
 */
export interface CaptchaAdapter {
  /** Whether it can check answers yet, such as once its keys are set. Always ready when left out. */
  ready?(context: ExtensionContext): boolean | Promise<boolean>;
  /** What the browser shows. Public. */
  widget(context: ExtensionContext): CaptchaWidgetConfig | Promise<CaptchaWidgetConfig>;
  /** Whether the provider accepts this answer. Each answer works once. Throwing counts as refusing. */
  verify(answer: string, request: { ip: string | null }, context: ExtensionContext): Promise<boolean>;
  /** Which of the sign-in forms ask for an answer. None when left out. */
  authForms?(context: ExtensionContext): CaptchaAuthForm[] | Promise<CaptchaAuthForm[]>;
}

/** What a plugin gets as `context.captcha`, whichever plugin supplies the CAPTCHA. */
export interface ExtensionCaptcha {
  /** What the browser shows, or null when no CAPTCHA is set up. A form then goes without one. */
  widget(): Promise<CaptchaWidgetConfig | null>;
  /** Whether the provider accepts this answer. False when no CAPTCHA is set up, or the provider can't be reached. */
  verify(answer: string, request: { ip: string | null }): Promise<boolean>;
}
