import "server-only";
import { authExtensions } from "../config";
import type { ExtensionContext } from "../extend/define";
import type { CaptchaAdapter, CaptchaAuthForm, CaptchaWidgetConfig, ExtensionCaptcha } from "./types";

interface Active { name: string; adapter: CaptchaAdapter; context: ExtensionContext }

const pluginContext = (name: string) => import("../extend/hooks").then(({ extensionContext }) => extensionContext(`plugin:${name}`));

/** The first plugin CAPTCHA that's ready, or null. A readiness check that fails counts as not ready. */
export async function activeCaptcha(): Promise<Active | null> {
  for (const extension of authExtensions()) {
    if (!extension.captcha) continue;
    const context = await pluginContext(extension.name);
    const adapter = extension.captcha;
    const ready = await Promise.resolve(adapter.ready ? adapter.ready(context) : true).catch((error: unknown) => {
      console.error(`[captcha] ${extension.name}: readiness check failed`, error);
      return false;
    });
    if (ready) return { name: extension.name, adapter, context };
  }
  return null;
}

const HTTPS = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?\/[^\s"'<>]*$/i;
const GLOBAL = /^[a-z]{1,40}$/i;
const KEY = /^[\w.-]{1,200}$/;

/**
 * The adapter's widget, checked before it reaches a browser: an https script, a global
 * that's a plain name and a site key with no markup, so a misconfigured setting can't
 * become a script injection on every sign-in page. Null when anything is off.
 */
function checked(widget: CaptchaWidgetConfig, plugin: string): CaptchaWidgetConfig | null {
  const options = Object.fromEntries(Object.entries(widget.options ?? {}).filter(([name, value]) => /^[a-z][\w-]{0,40}$/i.test(name) && ["string", "number", "boolean"].includes(typeof value)));
  if (!HTTPS.test(widget.script) || !GLOBAL.test(widget.global) || !KEY.test(widget.siteKey) || !/^[a-z0-9-]{1,40}$/.test(widget.provider)) {
    console.error(`[captcha] ${plugin}: the widget's script, global, site key or provider isn't valid, so no CAPTCHA is shown.`);
    return null;
  }
  return { provider: widget.provider, script: widget.script, global: widget.global, siteKey: widget.siteKey, options };
}

async function widgetOf(active: Active) {
  try {
    return checked(await active.adapter.widget(active.context), active.name);
  } catch (error) {
    console.error(`[captcha] ${active.name}: widget failed`, error);
    return null;
  }
}

/** What the sign-in forms show, and on which of them, for /api/auth-config. */
export async function authCaptcha(): Promise<{ widget: CaptchaWidgetConfig; forms: CaptchaAuthForm[] } | null> {
  const active = await activeCaptcha();
  if (!active) return null;
  const [widget, forms] = await Promise.all([widgetOf(active), formsOf(active)]);
  return widget && forms.length ? { widget, forms } : null;
}

const FORMS = new Set<CaptchaAuthForm>(["signin", "signup", "forgot-password"]);

async function formsOf(active: Active): Promise<CaptchaAuthForm[]> {
  try {
    return [...new Set(await active.adapter.authForms?.(active.context) ?? [])].filter((form) => FORMS.has(form));
  } catch (error) {
    // Fails closed: every form asks for an answer rather than none.
    console.error(`[captcha] ${active.name}: authForms failed`, error);
    return [...FORMS];
  }
}

/** The better-auth endpoint each sign-in form posts to. */
export const AUTH_FORM_PATHS: Record<CaptchaAuthForm, string> = {
  signin: "/sign-in/email",
  signup: "/sign-up/email",
  "forgot-password": "/request-password-reset",
};

/** Whether the provider accepts the answer. Never throws: a failure refuses. */
async function verifyWith(active: Active, answer: string, ip: string | null) {
  if (!answer || answer.length > 4096) return false;
  try {
    return (await active.adapter.verify(answer, { ip }, active.context)) === true;
  } catch (error) {
    console.error(`[captcha] ${active.name}: verify failed`, error);
    return false;
  }
}

/**
 * Checks the answer on a sign-in form's request, when the CAPTCHA guards that form.
 * Null lets the request through. Runs before better-auth handles it, like better-auth's
 * own captcha plugin, so even an unknown path is checked.
 */
export async function checkAuthRequest(path: string, answer: string | null, ip: string | null): Promise<{ status: 400 | 403; code: string; message: string } | null> {
  const form = (Object.keys(AUTH_FORM_PATHS) as CaptchaAuthForm[]).find((key) => AUTH_FORM_PATHS[key] === path);
  if (!form) return null;
  const active = await activeCaptcha();
  if (!active || !(await formsOf(active)).includes(form)) return null;
  if (!answer) return { status: 400, code: "CAPTCHA_REQUIRED", message: "Complete the CAPTCHA and try again." };
  if (!(await verifyWith(active, answer, ip))) return { status: 403, code: "CAPTCHA_FAILED", message: "The CAPTCHA wasn't accepted. Try again." };
  return null;
}

/** `context.captcha` for plugins. Looks up the active CAPTCHA on every call, so a settings change applies at once. */
export const extensionCaptcha: ExtensionCaptcha = {
  async widget() {
    const active = await activeCaptcha();
    return active ? widgetOf(active) : null;
  },
  async verify(answer, { ip }) {
    const active = await activeCaptcha();
    return active ? verifyWith(active, answer, ip) : false;
  },
};
