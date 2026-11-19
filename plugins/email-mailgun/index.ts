import { callProvider, defineEmailProvider, idOf, mailbox, str, type EmailSettings } from "@tansy/email/provider";

const key = (settings: EmailSettings) => str(settings.mailgunApiKey);
/** A domain name, and nothing that could change the request's path. */
export const MAILGUN_DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const HOSTS: Record<string, string> = { us: "https://api.mailgun.net", eu: "https://api.eu.mailgun.net" };
const domain = (settings: EmailSettings) => str(settings.mailgunDomain).toLowerCase();

/** Mailgun, through its Messages API. */
export const mailgun = (fetcher: typeof fetch = fetch) => defineEmailProvider({
  id: "mailgun",
  label: "Mailgun",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        mailgunApiKey: {
          label: "مفتاح API لـ Mailgun",
          description: "مفتاح إرسال من Mailgun ← Sending ← Domain settings ← Sending API keys، أو المفتاح الخاص بحسابك."
        },
        mailgunDomain: {
          label: "نطاق الإرسال في Mailgun",
          description: "كما وُثّق في Mailgun، مثل mg.example.com."
        },
        mailgunRegion: {
          label: "منطقة Mailgun",
          description: "حيث أُنشئ النطاق.",
          options: { us: "الولايات المتحدة", eu: "الاتحاد الأوروبي" }
        }
      }
    }
  },
  settings: () => [
    { name: "mailgunApiKey", type: "secret", env: "MAILGUN_API_KEY", label: "Mailgun API key", description: "A sending key from Mailgun → Sending → Domain settings → Sending API keys, or your account's private key." },
    { name: "mailgunDomain", type: "text", default: "", maxLength: 253, label: "Mailgun sending domain", description: "As verified in Mailgun, such as mg.example.com." },
    { name: "mailgunRegion", type: "select", default: "us", label: "Mailgun region", description: "Where the domain was created.", options: [{ value: "us", label: "US" }, { value: "eu", label: "EU" }] },
  ],
  ready: (settings) => Boolean(key(settings)) && MAILGUN_DOMAIN.test(domain(settings)),
  async send(email, settings) {
    const host = HOSTS[str(settings.mailgunRegion)] ?? HOSTS.us;
    const form = new URLSearchParams({ from: mailbox(email.from), to: email.to, subject: email.subject, text: email.text, html: email.html });
    if (email.replyTo) form.set("h:Reply-To", email.replyTo);
    for (const [name, value] of Object.entries(email.headers)) form.set(`h:${name}`, value);
    const answer = await callProvider("Mailgun", `${host}/v3/${domain(settings)}/messages`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`api:${key(settings)}`).toString("base64")}` },
      body: form,
    }, fetcher);
    return { id: idOf(answer.id) };
  },
});
