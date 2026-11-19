import { defineCaptchaProvider, siteVerify, str, type CaptchaSettings } from "@tansy/captcha/provider";

export interface HCaptchaOptions {
  /** The site key until one is saved in the settings. It's public. */
  siteKey?: string;
  /** For tests: where answers are checked instead of hCaptcha. */
  verifyUrl?: string;
  fetcher?: typeof fetch;
}

const secret = (settings: CaptchaSettings) => str(settings.hcaptchaSecret);
const siteKey = (settings: CaptchaSettings) => str(settings.hcaptchaSiteKey);

/** hCaptcha. */
export const hcaptcha = ({ siteKey: defaultKey = "", verifyUrl = "https://api.hcaptcha.com/siteverify", fetcher }: HCaptchaOptions = {}) => defineCaptchaProvider({
  id: "hcaptcha",
  label: "hCaptcha",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        hcaptchaSiteKey: {
          label: "مفتاح موقع hCaptcha",
          description: "من لوحة hCaptcha ← Sites. عام: يظهر لكل زائر."
        },
        hcaptchaSecret: {
          label: "سرّ hCaptcha",
          description: "من لوحة hCaptcha ← Account settings."
        }
      }
    }
  },
  settings: () => [
    { name: "hcaptchaSiteKey", type: "text", default: defaultKey, maxLength: 200, label: "hCaptcha site key", description: "From the hCaptcha dashboard → Sites. Public: it's shown to every visitor." },
    { name: "hcaptchaSecret", type: "secret", env: "HCAPTCHA_SECRET", label: "hCaptcha secret", description: "From the hCaptcha dashboard → Account settings." },
  ],
  ready: (settings) => Boolean(siteKey(settings) && secret(settings)),
  widget: (settings) => ({ script: "https://js.hcaptcha.com/1/api.js?render=explicit", global: "hcaptcha", siteKey: siteKey(settings) }),
  // The site key too, so an answer made for another site is refused.
  verify: (answer, { ip }, settings) => siteVerify(verifyUrl, { secret: secret(settings), response: answer, remoteip: ip, sitekey: siteKey(settings) }, fetcher),
  csp: { frame: ["https://newassets.hcaptcha.com", "https://hcaptcha.com"], connect: ["https://hcaptcha.com", "https://api.hcaptcha.com", "https://api2.hcaptcha.com"] },
});
