import { defineCaptchaProvider, siteVerify, str, type CaptchaSettings } from "@tansy/captcha/provider";

export interface RecaptchaOptions {
  /** The site key until one is saved in the settings. It's public. */
  siteKey?: string;
  /** For tests: where answers are checked instead of Google. */
  verifyUrl?: string;
  fetcher?: typeof fetch;
}

const secret = (settings: CaptchaSettings) => str(settings.recaptchaSecretKey);
const siteKey = (settings: CaptchaSettings) => str(settings.recaptchaSiteKey);

/** Google reCAPTCHA v2, the "I'm not a robot" checkbox. v3's scores need no widget, so they'd need a different flow. */
export const recaptcha = ({ siteKey: defaultKey = "", verifyUrl = "https://www.google.com/recaptcha/api/siteverify", fetcher }: RecaptchaOptions = {}) => defineCaptchaProvider({
  id: "recaptcha",
  label: "Google reCAPTCHA v2",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        recaptchaSiteKey: {
          label: "مفتاح موقع reCAPTCHA",
          description: "من وحدة تحكم reCAPTCHA، لمفتاح v2 بمربع اختيار يضم نطاق هذا الموقع. عام: يظهر لكل زائر."
        },
        recaptchaSecretKey: {
          label: "المفتاح السري لـ reCAPTCHA"
        }
      }
    }
  },
  settings: () => [
    { name: "recaptchaSiteKey", type: "text", default: defaultKey, maxLength: 200, label: "reCAPTCHA site key", description: "From the reCAPTCHA admin console, for a v2 checkbox key that lists this site's domain. Public: it's shown to every visitor." },
    { name: "recaptchaSecretKey", type: "secret", env: "RECAPTCHA_SECRET_KEY", label: "reCAPTCHA secret key" },
  ],
  ready: (settings) => Boolean(siteKey(settings) && secret(settings)),
  widget: (settings) => ({ script: "https://www.google.com/recaptcha/api.js?render=explicit", global: "grecaptcha", siteKey: siteKey(settings) }),
  verify: (answer, { ip }, settings) => siteVerify(verifyUrl, { secret: secret(settings), response: answer, remoteip: ip }, fetcher),
  csp: { frame: ["https://www.google.com", "https://recaptcha.google.com"], connect: ["https://www.google.com"] },
});
