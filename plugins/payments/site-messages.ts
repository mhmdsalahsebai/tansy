import type { Messages } from "tansy/plugin";

/** What visitors read on Payments' buttons, as `t("payments.<key>")`. Themes and owners can word any of it differently. */
export const siteMessages: Record<string, Messages> = {
  en: {
    payments: {
      buy: "Buy",
      subscribe: "Subscribe",
      billing: "Manage billing",
      opening: "Opening checkout…",
      openingBilling: "Opening…",
      checkoutFailed: "The checkout couldn't start.",
      subscribeFailed: "The subscription couldn't start.",
      billingFailed: "The billing page couldn't open.",
      offline: "{problem} Check your connection and try again.",
    },
  },
  ar: {
    payments: {
      buy: "شراء",
      subscribe: "اشترك",
      billing: "إدارة الفوترة",
      opening: "جارٍ فتح صفحة الدفع…",
      openingBilling: "جارٍ الفتح…",
      checkoutFailed: "تعذّر بدء الدفع.",
      subscribeFailed: "تعذّر بدء الاشتراك.",
      billingFailed: "تعذّر فتح صفحة الفوترة.",
      offline: "{problem} تحقق من اتصالك وحاول مجددًا.",
    },
  },
};
