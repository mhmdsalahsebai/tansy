import type { FieldLabels } from "tansy/plugin";

/** Payments' dashboard words, read as `t("ext.payments.<key>")`, and its collections' names. */
export const messages = {
  en: {
    categories: { Payments: "Payments" },
    fieldTypes: {
      payments_price: { label: "Price", description: "Makes a record something people can buy", options: { currency: "Currency", once: "Once per person" } },
    },
    settings: {
      provider: { label: "Provider", description: "Who takes the money. Fill in that provider's settings below. Records of past purchases stay when you switch." },
      currency: { label: "Currency", description: "For prices that don't name one. A three-letter code, such as \"usd\"." },
      testMode: { label: "Test mode", description: "Use the provider's sandbox or test environment, for providers that pick it by setting rather than by key." },
      createCustomerOnSignUp: { label: "Create a customer with the provider for every new account", description: "Otherwise one is made the first time someone pays, for providers that support it." },
    },
  },
  ar: {
    categories: { Payments: "المدفوعات" },
    fieldTypes: {
      payments_price: { label: "السعر", description: "يجعل السجل شيئًا يمكن شراؤه", options: { currency: "العملة", once: "مرة واحدة لكل شخص" } },
    },
    settings: {
      provider: { label: "المزوّد", description: "الجهة التي تحصّل المال. املأ إعدادات ذلك المزوّد أدناه. تبقى سجلات المشتريات السابقة حين تغيّره." },
      currency: { label: "العملة", description: "للأسعار التي لا تحدد عملتها. رمز من ثلاثة أحرف، مثل \"usd\"." },
      testMode: { label: "وضع الاختبار", description: "استخدم بيئة الاختبار لدى المزوّد، للمزوّدين الذين يختارونها بإعداد لا بمفتاح." },
      createCustomerOnSignUp: { label: "أنشئ عميلًا لدى المزوّد لكل حساب جديد", description: "وإلا يُنشأ عند أول دفعة، لدى المزوّدين الذين يدعمون ذلك." },
    },
  },
};

/** The collections' names in other interface languages. Added by a migration, so names an owner set stay. */
export const COLLECTION_LABELS: Record<string, Record<string, string>> = {
  "payments-plans": { ar: "الخطط" },
  "payments-purchases": { ar: "المشتريات" },
  "payments-memberships": { ar: "العضويات" },
  "payments-user-data": { ar: "بيانات العملاء" },
  "payments-access": { ar: "الوصول" },
  "payments-entitlements": { ar: "الاستحقاقات" },
};

/** Fields' words in other interface languages, by collection. Added by a migration, so words an owner set stay. */
export const FIELD_LABELS: Record<string, Record<string, FieldLabels>> = {
  "payments-plans": {
    name: {
      labels: {
        ar: "الاسم"
      },
      descriptions: {
        ar: "بأحرف صغيرة، مثل pro. تتحقق منه القواعد: @request.auth.payments_plan = \"pro\"."
      }
    },
    priceId: {
      labels: {
        ar: "معرّف السعر"
      },
      descriptions: {
        ar: "معرّف المزوّد: سعر Stripe (price_…)، أو منتج Polar، أو منتج Dodo Payments (pdt_…)، أو منتج Creem (prod_…)، أو خطة Commet."
      }
    },
    annualPriceId: {
      labels: {
        ar: "معرّف السعر السنوي"
      },
      descriptions: {
        ar: "سعر أو منتج سنوي اختياري. أما Commet فتفوتر الخطة نفسها سنويًا."
      }
    },
    trialDays: {
      labels: {
        ar: "أيام التجربة"
      },
      descriptions: {
        ar: "أيام مجانية قبل أول دفعة، مع Stripe. يضبط المزوّدون الآخرون التجربة على المنتج."
      }
    },
    limits: {
      labels: {
        ar: "الحدود"
      },
      descriptions: {
        ar: "أرقام اختيارية يقرؤها موقعك، مثل {\"projects\": 5}."
      }
    },
    group: {
      labels: {
        ar: "المجموعة"
      }
    },
    includes: {
      labels: {
        ar: "يشمل"
      },
      descriptions: {
        ar: "ما يمكن لمشتركي هذه الخطة فتحه."
      }
    },
    title: {
      labels: { ar: "العنوان" },
      descriptions: { ar: "كما تظهر على صفحة الأسعار، مثل «كل الدورات». يُستخدم الاسم إن تُرك فارغًا." }
    },
    description: {
      labels: { ar: "الوصف" },
      descriptions: { ar: "سطر أو سطران على صفحة الأسعار." }
    },
    amount: {
      labels: { ar: "السعر الشهري المعروض" },
      descriptions: { ar: "ما تعرضه صفحة الأسعار شهريًا. يأخذ المزوّد السعر المحدد عنده، فاجعلهما متطابقين." }
    },
    annualAmount: {
      labels: { ar: "السعر السنوي المعروض" },
      descriptions: { ar: "اختياري، لخطة لها سعر سنوي." }
    },
    currency: {
      labels: { ar: "العملة" },
      descriptions: { ar: "رمز من ثلاثة أحرف، مثل usd. تُملأ من إعدادات المدفوعات إن تُركت فارغة." }
    },
    featured: {
      labels: { ar: "مميّزة" },
      descriptions: { ar: "تُبرزها صفحة الأسعار." }
    }
  },
  "payments-purchases": {
    buyer: {
      labels: {
        ar: "المشتري"
      }
    },
    collection: {
      labels: {
        ar: "المجموعة"
      }
    },
    recordId: {
      labels: {
        ar: "معرّف السجل"
      }
    },
    amount: {
      labels: {
        ar: "المبلغ"
      }
    },
    currency: {
      labels: {
        ar: "العملة"
      }
    },
    sessionId: {
      labels: {
        ar: "معرّف الجلسة"
      }
    },
    paymentIntent: {
      labels: {
        ar: "نية الدفع"
      }
    },
    state: {
      labels: {
        ar: "الحالة"
      },
      descriptions: {
        ar: "paid أو refunded."
      }
    },
    provider: {
      labels: {
        ar: "المزوّد"
      },
      descriptions: {
        ar: "من تلقّى الدفعة. فارغ للمشتريات من قبل أن تدعم المدفوعات أكثر من Stripe."
      }
    }
  },
  "payments-memberships": {
    provider: {
      labels: {
        ar: "المزوّد"
      }
    },
    subscriptionId: {
      labels: {
        ar: "معرّف الاشتراك"
      }
    },
    user: {
      labels: {
        ar: "المستخدم"
      }
    },
    plan: {
      labels: {
        ar: "الخطة"
      },
      descriptions: {
        ar: "اسم الخطة من الخطط، مطابقًا بمعرّف المنتج أو الخطة لدى المزوّد."
      }
    },
    state: {
      labels: {
        ar: "الحالة"
      },
      descriptions: {
        ar: "active أو trialing أو past_due أو paused أو canceled أو expired أو pending."
      }
    },
    periodEnd: {
      labels: {
        ar: "نهاية الفترة"
      }
    },
    eventAt: {
      labels: {
        ar: "وقت الحدث"
      },
      descriptions: {
        ar: "متى وقع آخر حدث من المزوّد بشأنها، كي لا تكتب الأحداث الأقدم فوقه."
      }
    }
  },
  "payments-access": {
    name: {
      labels: {
        ar: "الاسم"
      },
      descriptions: {
        ar: "مثل كل الدورات أو المقالات المميزة."
      }
    },
    description: {
      labels: {
        ar: "الوصف"
      }
    },
    collections: {
      labels: {
        ar: "المجموعات"
      },
      descriptions: {
        ar: "مجموعات يفتحها كاملة، بمعرّفها، مثل [\"lms-courses\"]. تتحقق منها القواعد: @request.auth.payments_access ?= \"lms-courses\"."
      }
    }
  },
  "payments-entitlements": {
    user: {
      labels: {
        ar: "المستخدم"
      }
    },
    plans: {
      labels: {
        ar: "الخطط"
      },
      descriptions: {
        ar: "أسماء الخطط التي عليها اشتراكاتهم النشطة."
      }
    },
    access: {
      labels: {
        ar: "الوصول"
      },
      descriptions: {
        ar: "معرّفات الوصول الذي تشمله تلك الخطط، ثم المجموعات التي تفتحها كاملة."
      }
    }
  }
};
