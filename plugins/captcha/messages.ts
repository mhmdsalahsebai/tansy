/** The CAPTCHA plugin's dashboard words, read as `t("ext.captcha.<key>")`. Each provider package adds its own settings' words. */
export const messages = {
  en: {
    settings: {
      provider: { label: "Provider", description: "Who checks that a person is filling in the form. Fill in that provider's keys below. Until they're set, forms go without a CAPTCHA." },
      signIn: { label: "Ask on sign-in", description: "Slows down password guessing. Lockout after failed attempts applies either way." },
      signUp: { label: "Ask on sign-up", description: "Keeps scripts from creating accounts." },
      passwordReset: { label: "Ask on password reset", description: "Keeps scripts from sending reset emails to people who didn't ask." },
    },
  },
  ar: {
    settings: {
      provider: { label: "المزوّد", description: "الجهة التي تتحقق من أن من يملأ النموذج إنسان. املأ مفاتيح ذلك المزوّد أدناه. حتى تُضبط، تعمل النماذج دون CAPTCHA." },
      signIn: { label: "اطلبه عند تسجيل الدخول", description: "يبطئ تخمين كلمات المرور. القفل بعد المحاولات الفاشلة يعمل في الحالتين." },
      signUp: { label: "اطلبه عند إنشاء حساب", description: "يمنع البرامج الآلية من إنشاء الحسابات." },
      passwordReset: { label: "اطلبه عند إعادة تعيين كلمة المرور", description: "يمنع البرامج الآلية من إرسال رسائل إعادة التعيين لمن لم يطلبها." },
    },
  },
};
