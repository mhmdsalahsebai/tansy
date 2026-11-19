import { callProvider, defineEmailProvider, idOf, mailbox, str, type EmailSettings, type OutgoingEmail, ProviderError } from "@tansy/email/provider";

const token = (settings: EmailSettings) => str(settings.postmarkServerToken);
const STREAM = /^[a-z0-9-]{1,30}$/;

/** Mail to many goes through the broadcast stream, as Postmark requires. Everything else through the transactional one. */
function streamOf(email: OutgoingEmail, settings: EmailSettings) {
  const [chosen, fallback] = email.bulk ? [str(settings.postmarkBroadcastStream), "broadcast"] : [str(settings.postmarkMessageStream), "outbound"];
  return STREAM.test(chosen) ? chosen : fallback;
}

const payload = (email: OutgoingEmail, settings: EmailSettings) => ({
  From: mailbox(email.from), To: email.to, Subject: email.subject, TextBody: email.text, HtmlBody: email.html,
  MessageStream: streamOf(email, settings),
  ...(email.replyTo ? { ReplyTo: email.replyTo } : {}),
  ...(Object.keys(email.headers).length ? { Headers: Object.entries(email.headers).map(([Name, Value]) => ({ Name, Value })) } : {}),
});

/** Postmark answers a batch with a JSON array, which callProvider only returns as an object. */
const batchFetch = (fetcher: typeof fetch): typeof fetch => async (input, init) => {
  const response = await fetcher(input, init);
  if (!response.ok) return response;
  const items: unknown = await response.json().catch(() => []);
  return new Response(JSON.stringify({ items }), { status: response.status, headers: { "content-type": "application/json" } });
};

/** Postmark, through its REST API. */
export const postmark = (fetcher: typeof fetch = fetch) => defineEmailProvider({
  id: "postmark",
  label: "Postmark",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        postmarkServerToken: {
          label: "رمز API لخادم Postmark",
          description: "من خادمك في Postmark ← API Tokens. أضف المرسل تحت Sender Signatures أولًا."
        },
        postmarkMessageStream: {
          label: "مسار رسائل Postmark",
          description: "روابط الدخول والإيصالات رسائل معاملات، فيناسبها المسار الافتراضي outbound."
        },
        postmarkBroadcastStream: {
          label: "مسار البث في Postmark",
          description: "البريد المرسل إلى كثيرين دفعة واحدة، مثل النشرة البريدية. يشترط Postmark أن يمر عبر مسار بث."
        }
      }
    }
  },
  settings: () => [
    { name: "postmarkServerToken", type: "secret", env: "POSTMARK_SERVER_TOKEN", label: "Postmark server API token", description: "From your server in Postmark → API Tokens. Add your sender under Sender Signatures first." },
    { name: "postmarkMessageStream", type: "text", default: "outbound", maxLength: 30, label: "Postmark message stream", description: "Sign-in links and receipts are transactional, so the default outbound stream suits them." },
    { name: "postmarkBroadcastStream", type: "text", default: "broadcast", maxLength: 30, label: "Postmark broadcast stream", description: "Mail sent to many people at once, such as a newsletter. Postmark requires it to go through a broadcast stream." },
  ],
  ready: (settings) => Boolean(token(settings)),
  async send(email, settings) {
    const answer = await callProvider("Postmark", "https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "x-postmark-server-token": token(settings), "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload(email, settings)),
    }, fetcher);
    return { id: idOf(answer.MessageID) };
  },
  // Up to 500 in one call, each answered on its own: ErrorCode 0 is sent.
  async sendBatch(emails, settings) {
    const answer = await callProvider("Postmark", "https://api.postmarkapp.com/email/batch", {
      method: "POST",
      headers: { "x-postmark-server-token": token(settings), "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(emails.map((email) => payload(email, settings))),
    }, batchFetch(fetcher));
    const items = Array.isArray(answer.items) ? (answer.items as Array<{ ErrorCode?: unknown; MessageID?: unknown }>) : [];
    return emails.map((_, index) => {
      const item = items[index];
      return item && item.ErrorCode === 0 ? { id: idOf(item.MessageID) } : new ProviderError("Postmark", 422);
    });
  },
});
