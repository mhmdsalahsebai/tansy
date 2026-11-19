import { AwsClient } from "aws4fetch";
import { callProvider, defineEmailProvider, idOf, mailbox, str, type EmailSettings } from "@tansy/email/provider";

/** An AWS region, and nothing that could change the request's host. */
export const SES_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const CONFIGURATION_SET = /^[A-Za-z0-9_-]{1,64}$/;
const region = (settings: EmailSettings) => str(settings.sesRegion);
const keys = (settings: EmailSettings) => ({ accessKeyId: str(settings.sesAccessKeyId), secretAccessKey: str(settings.sesSecretAccessKey) });

/** Amazon SES, through the SES v2 API, signed with the keys of an IAM user that may call ses:SendEmail. */
export const ses = (fetcher: typeof fetch = fetch) => defineEmailProvider({
  id: "ses",
  label: "Amazon SES",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        sesAccessKeyId: {
          label: "معرّف مفتاح الوصول في AWS",
          description: "لمستخدم IAM مسموح له بـ ses:SendEmail فقط. وثّق نطاق الإرسال في SES، واخرج من بيئة sandbox، أولًا."
        },
        sesSecretAccessKey: {
          label: "مفتاح الوصول السري في AWS"
        },
        sesRegion: {
          label: "منطقة SES",
          description: "حيث وُثّق نطاقك، مثل us-east-1 أو eu-west-1."
        },
        sesConfigurationSet: {
          label: "مجموعة إعدادات SES",
          description: "اختيارية، لنشر الأحداث."
        }
      }
    }
  },
  settings: () => [
    { name: "sesAccessKeyId", type: "secret", env: "SES_ACCESS_KEY_ID", label: "AWS access key id", description: "For an IAM user allowed only ses:SendEmail. Verify your sending domain in SES, and leave the sandbox, first." },
    { name: "sesSecretAccessKey", type: "secret", env: "SES_SECRET_ACCESS_KEY", label: "AWS secret access key" },
    { name: "sesRegion", type: "text", default: "us-east-1", maxLength: 30, label: "SES region", description: "Where your domain is verified, such as us-east-1 or eu-west-1." },
    { name: "sesConfigurationSet", type: "text", default: "", maxLength: 64, label: "SES configuration set", description: "Optional, for event publishing." },
  ],
  ready: (settings) => Boolean(keys(settings).accessKeyId && keys(settings).secretAccessKey) && SES_REGION.test(region(settings)),
  async send(email, settings) {
    const client = new AwsClient({ ...keys(settings), service: "ses", region: region(settings), retries: 0 });
    const set = str(settings.sesConfigurationSet);
    const url = `https://email.${region(settings)}.amazonaws.com/v2/email/outbound-emails`;
    const body = JSON.stringify({
      FromEmailAddress: mailbox(email.from),
      Destination: { ToAddresses: [email.to] },
      ...(email.replyTo ? { ReplyToAddresses: [email.replyTo] } : {}),
      Content: { Simple: {
        Subject: { Data: email.subject, Charset: "UTF-8" },
        Body: { Text: { Data: email.text, Charset: "UTF-8" }, Html: { Data: email.html, Charset: "UTF-8" } },
        ...(Object.keys(email.headers).length ? { Headers: Object.entries(email.headers).map(([Name, Value]) => ({ Name, Value })) } : {}),
      } },
      ...(CONFIGURATION_SET.test(set) ? { ConfigurationSetName: set } : {}),
    });
    const signed = await client.sign(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    const answer = await callProvider("Amazon SES", url, { method: "POST", headers: signed.headers, body }, fetcher);
    return { id: idOf(answer.MessageId) };
  },
});
