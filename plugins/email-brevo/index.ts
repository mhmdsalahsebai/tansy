import { callProvider, defineEmailProvider, idOf, str, type EmailSettings } from "@tansy/email/provider";

const key = (settings: EmailSettings) => str(settings.brevoApiKey);

/** Brevo, formerly Sendinblue, through its transactional email API. */
export const brevo = (fetcher: typeof fetch = fetch) => defineEmailProvider({
  id: "brevo",
  label: "Brevo",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        brevoApiKey: {
          label: "مفتاح API لـ Brevo",
          description: "من Brevo ← SMTP & API ← API Keys. يبدأ بـ xkeysib-. أضف المرسل تحت Senders, Domains & Dedicated IPs أولًا."
        }
      }
    }
  },
  settings: () => [
    { name: "brevoApiKey", type: "secret", env: "BREVO_API_KEY", label: "Brevo API key", description: "From Brevo → SMTP & API → API Keys. Starts with xkeysib-. Add your sender under Senders, Domains & Dedicated IPs first." },
  ],
  ready: (settings) => Boolean(key(settings)),
  async send(email, settings) {
    const answer = await callProvider("Brevo", "https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": key(settings), "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { email: email.from.address, ...(email.from.name ? { name: email.from.name } : {}) },
        to: [{ email: email.to }],
        ...(email.replyTo ? { replyTo: { email: email.replyTo } } : {}),
        subject: email.subject, textContent: email.text, htmlContent: email.html,
        ...(Object.keys(email.headers).length ? { headers: email.headers } : {}),
      }),
    }, fetcher);
    return { id: idOf(answer.messageId) };
  },
});
