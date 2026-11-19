import { callProvider, defineEmailProvider, idOf, mailbox, str, type EmailSettings, type OutgoingEmail } from "@tansy/email/provider";

const key = (settings: EmailSettings) => str(settings.resendApiKey);

const payload = (email: OutgoingEmail) => ({
  from: mailbox(email.from), to: [email.to], subject: email.subject, text: email.text, html: email.html,
  ...(email.replyTo ? { reply_to: email.replyTo } : {}),
  ...(Object.keys(email.headers).length ? { headers: email.headers } : {}),
});

/** Resend, through its REST API. */
export const resend = (fetcher: typeof fetch = fetch) => defineEmailProvider({
  id: "resend",
  label: "Resend",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        resendApiKey: {
          label: "مفتاح API لـ Resend",
          description: "من Resend ← API Keys، مع صلاحية الإرسال. يبدأ بـ re_. وثّق نطاق الإرسال تحت Domains أولًا."
        }
      }
    }
  },
  settings: () => [
    { name: "resendApiKey", type: "secret", env: "RESEND_API_KEY", label: "Resend API key", description: "From Resend → API Keys, with sending access. Starts with re_. Verify your sending domain under Domains first." },
  ],
  ready: (settings) => Boolean(key(settings)),
  async send(email, settings) {
    const answer = await callProvider("Resend", "https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key(settings)}`, "content-type": "application/json" },
      body: JSON.stringify(payload(email)),
    }, fetcher);
    return { id: idOf(answer.id) };
  },
  // Up to 100 in one call. Resend takes or refuses the whole batch.
  async sendBatch(emails, settings) {
    const answer = await callProvider("Resend", "https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { authorization: `Bearer ${key(settings)}`, "content-type": "application/json" },
      body: JSON.stringify(emails.map(payload)),
    }, fetcher);
    const data = Array.isArray(answer.data) ? (answer.data as Array<{ id?: unknown }>) : [];
    return emails.map((_, index) => ({ id: idOf(data[index]?.id) }));
  },
});
