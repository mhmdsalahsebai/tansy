import type { Messages } from "tansy/plugin";

/** What visitors read on forms, and what owners read in the email about one, as `t("forms.<key>")`. Themes and owners can word any of it differently. */
export const siteMessages = {
  en: {
    forms: {
      choose: "Choose…",
      send: "Send",
      sending: "Sending…",
      thanks: "Thanks. Your message was sent.",
      tooMany: "You've sent this form several times. Try again in a few minutes.",
      failed: "It couldn't be sent. Try again.",
      offline: "It couldn't be sent. Check your connection and try again.",
      trap: "Leave this empty",
      namePreview: "Give this field a name and a label.",
      refusals: {
        notFound: "There's no form here.",
        tooFast: "That was quick. Wait a few seconds, then send it again.",
        expired: "This form has expired. Reload the page and send it again.",
        invalid: "Check the highlighted fields.",
        noFields: "This form doesn't ask anything yet.",
        captchaRequired: "Complete the CAPTCHA, then send it again.",
        captchaFailed: "The CAPTCHA wasn't accepted. Try it again.",
      },
      errors: {
        tick: "Tick this box to send.",
        fill: "Fill in this field.",
        number: "Enter a number.",
        min: "Enter {min} or more.",
        max: "Enter {max} or less.",
        text: "Enter text.",
        tooLong: "Keep it under {limit} characters.",
        email: "Enter an email address.",
        option: "Choose one of the options.",
      },
      mail: {
        subject: "New submission: {title}",
        aForm: "a form",
        intro: "Someone filled in \"{title}\".",
        introOn: "Someone filled in \"{title}\" on {page}.",
        yes: "Yes",
        no: "No",
        outro: "Find it under Forms → Submissions in the dashboard. Reply to this email to answer them, when the form asked for their address.",
        rest: "The rest is in the dashboard.",
      },
    },
  },
  ar: {
    forms: {
      choose: "اختر…",
      send: "إرسال",
      sending: "جارٍ الإرسال…",
      thanks: "شكرًا. أُرسلت رسالتك.",
      tooMany: "أرسلت هذا النموذج عدة مرات. حاول مجددًا بعد بضع دقائق.",
      failed: "تعذّر الإرسال. حاول مجددًا.",
      offline: "تعذّر الإرسال. تحقق من اتصالك وحاول مجددًا.",
      trap: "اترك هذا فارغًا",
      namePreview: "أعطِ هذا الحقل اسمًا وتسمية.",
      refusals: {
        notFound: "لا يوجد نموذج هنا.",
        tooFast: "كان ذلك سريعًا. انتظر بضع ثوانٍ ثم أرسله مجددًا.",
        expired: "انتهت صلاحية هذا النموذج. أعد تحميل الصفحة وأرسله مجددًا.",
        invalid: "راجع الحقول المحددة.",
        noFields: "لا يطرح هذا النموذج أي سؤال بعد.",
        captchaRequired: "أكمل اختبار CAPTCHA ثم أرسله مجددًا.",
        captchaFailed: "لم يُقبل اختبار CAPTCHA. حاول مجددًا.",
      },
      errors: {
        tick: "حدّد هذا المربع للإرسال.",
        fill: "املأ هذا الحقل.",
        number: "أدخل رقمًا.",
        min: "أدخل {min} أو أكثر.",
        max: "أدخل {max} أو أقل.",
        text: "أدخل نصًا.",
        tooLong: "اجعله أقل من {limit} حرفًا.",
        email: "أدخل عنوان بريد إلكتروني.",
        option: "اختر أحد الخيارات.",
      },
      mail: {
        subject: "إرسال جديد: {title}",
        aForm: "نموذج",
        intro: "ملأ أحدهم «{title}».",
        introOn: "ملأ أحدهم «{title}» في {page}.",
        yes: "نعم",
        no: "لا",
        outro: "تجده في النماذج ← الإرسالات في لوحة التحكم. ردّ على هذه الرسالة لتجيبه، إن طلب النموذج عنوانه.",
        rest: "البقية في لوحة التحكم.",
      },
    },
  },
} satisfies Record<string, Messages>;

type Words = typeof siteMessages.en.forms;

/** Looks up an English word by its dotted key under `forms`, filling in `{name}` values. For code that runs without a page's words, and for API callers. */
export function english(key: string, values: Record<string, string | number> = {}): string {
  const found = key.replace(/^forms\./, "").split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), siteMessages.en.forms as Words);
  return typeof found === "string" ? found.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? "")) : key;
}
