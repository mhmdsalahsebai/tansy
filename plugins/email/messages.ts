/** The email plugin's dashboard words, read as `t("ext.email.<key>")`. Each provider package adds its own settings' words. */
export const messages = {
  en: {
    section: "Email",
    settings: {
      provider: { label: "Provider", description: "Who sends the site's email. Fill in that provider's settings below. Until its keys are set, email goes through SMTP under Settings → Email." },
      fromAddress: { label: "From address", description: "An address at a domain you've verified with the provider. Empty uses the one under Settings → Email." },
      fromName: { label: "From name", description: "Empty uses the one under Settings → Email, then the site's name." },
      replyTo: { label: "Reply-to address", description: "Where replies go, unless a message names its own, such as a form notification answering the visitor. Empty sends them to the from address." },
      log: { label: "Keep a delivery log", description: "Lists each email's recipient, subject and whether the provider took it, under Email → Messages. Never the body, which can hold sign-in links and codes." },
      logDays: { label: "Keep log entries for (days)" },
    },
  },
  ar: {
    section: "البريد الإلكتروني",
    settings: {
      provider: { label: "المزوّد", description: "الجهة التي ترسل بريد الموقع. املأ إعدادات ذلك المزوّد أدناه. حتى تُضبط مفاتيحه، يُرسل البريد عبر SMTP من الإعدادات ← البريد الإلكتروني." },
      fromAddress: { label: "عنوان المرسل", description: "عنوان في نطاق وثّقته لدى المزوّد. إن تُرك فارغًا يُستخدم العنوان في الإعدادات ← البريد الإلكتروني." },
      fromName: { label: "اسم المرسل", description: "إن تُرك فارغًا يُستخدم الاسم في الإعدادات ← البريد الإلكتروني، ثم اسم الموقع." },
      replyTo: { label: "عنوان الرد", description: "حيث تذهب الردود، ما لم تحدد الرسالة عنوانها، مثل إشعار نموذج يرد على الزائر. إن تُرك فارغًا تذهب إلى عنوان المرسل." },
      log: { label: "احتفظ بسجل الإرسال", description: "يسرد مستلم كل رسالة وموضوعها وهل قبلها المزوّد، في البريد الإلكتروني ← الرسائل. لا يحفظ النص أبدًا، فقد يحوي روابط ورموز الدخول." },
      logDays: { label: "احتفظ بسجلات الإرسال لمدة (أيام)" },
    },
  },
};

/** The collection's name in other interface languages. Added by a migration, so a name the owner set stays. */
export const COLLECTION_LABELS: Record<string, Record<string, string>> = {
  "email-messages": { ar: "الرسائل" },
};

/** The collection's fields in other interface languages, added the same way. */
export const FIELD_LABELS: Record<string, Record<string, { labels?: Record<string, string>; descriptions?: Record<string, string> }>> = {
  "email-messages": {
    recipient: { labels: { ar: "المستلم" } },
    subject: { labels: { ar: "الموضوع" } },
    kind: { labels: { ar: "النوع" }, descriptions: { ar: "ما الذي أرسلها، مثل auth:reset-password أو plugin:blog أو test." } },
    provider: { labels: { ar: "المزوّد" } },
    state: { labels: { ar: "الحالة" }, descriptions: { ar: "sent حين قبلها المزوّد، أو failed." } },
    providerId: { labels: { ar: "معرّف المزوّد" }, descriptions: { ar: "معرّف الرسالة لدى المزوّد، للبحث عنها هناك." } },
    error: { labels: { ar: "الخطأ" }, descriptions: { ar: "رمز الحالة من المزوّد فقط، لا ما قاله أبدًا." } },
  },
};
