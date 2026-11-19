/**
 * First-party plugins' settings in Arabic, with every provider installed: each setting, its
 * description and its choices have words in Arabic, whether the plugin or a provider package
 * ships them, and no word names a setting that isn't there. Providers' names, as choices of
 * `provider`, are brand names and stay as they are.
 */
import { describe, expect, it } from "vitest";
import type { CmsPlugin } from "@/core/extend/define";
import { messageProblems, type Messages } from "@/core/i18n/messages";
import { ai } from "../../plugins/ai/index";
import { anthropic } from "../../plugins/ai-anthropic/index";
import { deepseek } from "../../plugins/ai-deepseek/index";
import { gateway } from "../../plugins/ai-gateway/index";
import { google } from "../../plugins/ai-google/index";
import { groq } from "../../plugins/ai-groq/index";
import { mistral } from "../../plugins/ai-mistral/index";
import { openai } from "../../plugins/ai-openai/index";
import { openaiCompatible } from "../../plugins/ai-openai-compatible/index";
import { commandcode } from "../../plugins/ai-commandcode/index";
import { opencode } from "../../plugins/ai-opencode/index";
import { openrouter } from "../../plugins/ai-openrouter/index";
import { xai } from "../../plugins/ai-xai/index";
import { blog } from "../../plugins/blog/index";
import { captcha } from "../../plugins/captcha/index";
import { hcaptcha } from "../../plugins/captcha-hcaptcha/index";
import { recaptcha } from "../../plugins/captcha-recaptcha/index";
import { turnstile } from "../../plugins/captcha-turnstile/index";
import { email } from "../../plugins/email/index";
import { brevo } from "../../plugins/email-brevo/index";
import { mailgun } from "../../plugins/email-mailgun/index";
import { postmark } from "../../plugins/email-postmark/index";
import { resend } from "../../plugins/email-resend/index";
import { sendgrid } from "../../plugins/email-sendgrid/index";
import { ses } from "../../plugins/email-ses/index";
import { forms } from "../../plugins/forms/index";
import { lms } from "../../plugins/lms/index";
import { payments } from "../../plugins/payments/index";
import { commet } from "../../plugins/payments-commet/index";
import { creem } from "../../plugins/payments-creem/index";
import { dodo } from "../../plugins/payments-dodo/index";
import { polar } from "../../plugins/payments-polar/index";
import { stripe } from "../../plugins/payments-stripe/index";
import { shop } from "../../plugins/shop/index";

const SITE = "https://example.com";
const PLUGINS: CmsPlugin[] = [
  ai({ providers: [openai(), anthropic(), google(), gateway(), mistral(), xai(), groq(), deepseek(), openrouter(), opencode(), commandcode(), openaiCompatible()] }),
  blog({ siteUrl: SITE }),
  captcha({ providers: [turnstile(), hcaptcha(), recaptcha()] }),
  email({ providers: [resend(), postmark(), sendgrid(), mailgun(), ses(), brevo()] }),
  forms(),
  lms(),
  payments({ providers: [stripe(), polar(), dodo(), creem(), commet()], siteUrl: SITE }),
  shop({ siteUrl: SITE }),
];

type Words = { label?: string; description?: string; options?: Record<string, string> };

describe.each(PLUGINS.map((plugin) => [plugin.name, plugin] as const))("the %s plugin's settings", (_name, plugin) => {
  const fields = plugin.settings?.fields ?? [];
  const words = (((plugin.messages as Record<string, Messages> | undefined)?.ar?.settings ?? {}) as Record<string, Words>);

  it("all have words in Arabic", () => {
    const gaps = fields.flatMap((field) => {
      const own = Object.hasOwn(words, field.name) ? words[field.name] : undefined;
      const missing = [...(own?.label ? [] : [`${field.name}.label`]), ...(field.description && !own?.description ? [`${field.name}.description`] : [])];
      // A provider's choices are its brand name, the same in every language.
      const choices = field.name !== "provider" && "options" in field && Array.isArray(field.options) ? (field.options as Array<{ value: string }>) : [];
      return [...missing, ...choices.filter((choice) => !own?.options?.[choice.value]).map((choice) => `${field.name}.options.${choice.value}`)];
    });
    expect(gaps).toEqual([]);
  });

  it("are valid ICU once the providers' words are merged in", () => {
    for (const [locale, catalog] of Object.entries((plugin.messages ?? {}) as Record<string, Messages>)) expect(messageProblems(catalog), locale).toEqual([]);
  });

  it("name only settings that exist", () => {
    const names = new Set(fields.map((field) => field.name));
    expect(Object.keys(words).filter((name) => !names.has(name))).toEqual([]);
  });
});
