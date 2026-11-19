import { defineCaptchaProvider, siteVerify, str, type CaptchaSettings } from "@tansy/captcha/provider";

export interface TurnstileOptions {
  /** The site key until one is saved in the settings. It's public. */
  siteKey?: string;
  /** For tests: where answers are checked instead of Cloudflare. */
  verifyUrl?: string;
  fetcher?: typeof fetch;
}

const secret = (settings: CaptchaSettings) => str(settings.turnstileSecretKey);
const siteKey = (settings: CaptchaSettings) => str(settings.turnstileSiteKey);

/** Cloudflare Turnstile. Usually needs no puzzle at all. */
export const turnstile = ({ siteKey: defaultKey = "", verifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify", fetcher }: TurnstileOptions = {}) => defineCaptchaProvider({
  id: "turnstile",
  label: "Cloudflare Turnstile",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        turnstileSiteKey: {
          label: "مفتاح موقع Turnstile",
          description: "من Cloudflare ← Turnstile، لعنصر يضم نطاق هذا الموقع. عام: يظهر لكل زائر."
        },
        turnstileSecretKey: {
          label: "المفتاح السري لـ Turnstile"
        }
      }
    }
  },
  settings: () => [
    { name: "turnstileSiteKey", type: "text", default: defaultKey, maxLength: 200, label: "Turnstile site key", description: "From Cloudflare → Turnstile, for a widget that lists this site's domain. Public: it's shown to every visitor." },
    { name: "turnstileSecretKey", type: "secret", env: "TURNSTILE_SECRET_KEY", label: "Turnstile secret key" },
  ],
  ready: (settings) => Boolean(siteKey(settings) && secret(settings)),
  widget: (settings) => ({ script: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", global: "turnstile", siteKey: siteKey(settings) }),
  verify: (answer, { ip }, settings) => siteVerify(verifyUrl, { secret: secret(settings), response: answer, remoteip: ip }, fetcher),
  csp: { frame: ["https://challenges.cloudflare.com"] },
});
