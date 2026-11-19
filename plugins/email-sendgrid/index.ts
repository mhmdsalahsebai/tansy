import { callProvider, defineEmailProvider, ProviderError, str, type EmailSettings } from "@tansy/email/provider";

const key = (settings: EmailSettings) => str(settings.sendgridApiKey);
const HOSTS: Record<string, string> = { global: "https://api.sendgrid.com", eu: "https://api.eu.sendgrid.com" };

/** Twilio SendGrid, through its v3 Mail Send API. */
export const sendgrid = (fetcher: typeof fetch = fetch) => defineEmailProvider({
  id: "sendgrid",
  label: "SendGrid",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        sendgridApiKey: {
          label: "مفتاح API لـ SendGrid",
          description: "من SendGrid ← Settings ← API Keys، مع صلاحية Mail Send. يبدأ بـ SG. وثّق نطاق الإرسال أولًا."
        },
        sendgridRegion: {
          label: "منطقة SendGrid",
          options: {
            global: "عالمية",
            eu: "الاتحاد الأوروبي (حساب فرعي إقليمي)"
          }
        }
      }
    }
  },
  settings: () => [
    { name: "sendgridApiKey", type: "secret", env: "SENDGRID_API_KEY", label: "SendGrid API key", description: "From SendGrid → Settings → API Keys, with Mail Send access. Starts with SG. Authenticate your sending domain first." },
    { name: "sendgridRegion", type: "select", default: "global", label: "SendGrid region", options: [{ value: "global", label: "Global" }, { value: "eu", label: "EU (regional subuser)" }] },
  ],
  ready: (settings) => Boolean(key(settings)),
  async send(email, settings) {
    const host = HOSTS[str(settings.sendgridRegion)] ?? HOSTS.global;
    // SendGrid answers 202 with no body, and gives the message's id only in a header.
    let id: string | null = null;
    const capture: typeof fetch = async (input, init) => {
      const response = await fetcher(input, init);
      id = response.headers.get("x-message-id");
      return response;
    };
    await callProvider("SendGrid", `${host}/v3/mail/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${key(settings)}`, "content-type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: email.to }] }],
        from: { email: email.from.address, ...(email.from.name ? { name: email.from.name } : {}) },
        ...(email.replyTo ? { reply_to: { email: email.replyTo } } : {}),
        subject: email.subject,
        content: [{ type: "text/plain", value: email.text }, { type: "text/html", value: email.html }],
        ...(Object.keys(email.headers).length ? { headers: email.headers } : {}),
      }),
    }, capture).catch((error: unknown) => {
      throw error instanceof ProviderError ? error : new ProviderError("SendGrid", null);
    });
    return { id: id ? String(id).slice(0, 255) : null };
  },
});
