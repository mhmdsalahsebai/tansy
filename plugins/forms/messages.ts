import type { FieldLabels } from "tansy/plugin";

/** The forms plugin's dashboard words, read as `t("ext.forms.<key>")`, and its collections' names. */
export const messages = {
  en: {
    section: "Forms",
    pages: { forms: "Overview" },
    categories: { "Form fields": "Form fields" },
    settings: {
      notify: { label: "Email submissions to", description: "Addresses separated by commas, for forms that don't name their own. Empty sends no email: submissions are still kept." },
      minSeconds: { label: "Fastest a person fills in a form (seconds)", description: "Anything sent sooner after the form loaded is refused as a script. 0 turns this off." },
      keepDays: { label: "Delete submissions after (days)", description: "0 keeps them until someone deletes them." },
    },
    overview: {
      description: "Forms visitors fill in, and what they sent. Put a form on a page with the Form block.",
      cantRead: "You can't read forms. Ask an administrator for permissions on the Forms collection.",
      empty: "No forms yet. Create one under Forms, add its fields, publish it, then put it on a page with the Form block.",
      draft: "Draft, so visitors can't open it",
      new: "{count} new",
    },
    status: {
      noMail: "Email isn't set up, so nobody is told about new submissions. They're still kept here. Set up SMTP under Settings → Email, or an email plugin.",
      noCaptcha: "No CAPTCHA is set up. Forms are still guarded by a hidden trap field, a minimum time to fill in and a rate limit. Add the CAPTCHA plugin for more.",
    },
  },
  ar: {
    section: "النماذج",
    pages: { forms: "نظرة عامة" },
    categories: { "Form fields": "حقول النموذج" },
    settings: {
      notify: { label: "أرسل الإرسالات بالبريد إلى", description: "عناوين مفصولة بفواصل، للنماذج التي لا تحدد عناوينها. إن تُرك فارغًا فلا يُرسل بريد، وتبقى الإرسالات محفوظة." },
      minSeconds: { label: "أسرع وقت يملأ فيه شخص نموذجًا (بالثواني)", description: "يُرفض كل ما يُرسل أسرع من ذلك بعد تحميل النموذج على أنه برنامج آلي. القيمة 0 تعطّل ذلك." },
      keepDays: { label: "احذف الإرسالات بعد (أيام)", description: "القيمة 0 تبقيها حتى يحذفها أحد." },
    },
    overview: {
      description: "النماذج التي يملؤها الزوار وما أرسلوه. ضع نموذجًا في صفحة بكتلة «نموذج».",
      cantRead: "لا يمكنك قراءة النماذج. اطلب من المسؤول صلاحيات على مجموعة النماذج.",
      empty: "لا نماذج بعد. أنشئ نموذجًا في «النماذج» وأضف حقوله وانشره، ثم ضعه في صفحة بكتلة «نموذج».",
      draft: "مسودة، فلا يستطيع الزوار فتحه",
      new: "{count} جديد",
    },
    status: {
      noMail: "البريد غير مُعدّ، فلن يُبلَّغ أحد بالإرسالات الجديدة. تبقى محفوظة هنا. أعدّ SMTP من الإعدادات ← البريد، أو استخدم إضافة بريد.",
      noCaptcha: "لا يوجد CAPTCHA مُعدّ. تبقى النماذج محمية بحقل فخ مخفي وحد أدنى لوقت الملء وحد للمعدّل. أضف إضافة CAPTCHA لحماية أكبر.",
    },
  },
};

/** The collections' names in other interface languages. Added by a migration, so names an owner set stay. */
export const COLLECTION_LABELS: Record<string, Record<string, string>> = {
  "forms-forms": { ar: "النماذج" },
  "forms-submissions": { ar: "الإرسالات" },
};

/** Fields' words in other interface languages, by collection. Added by a migration, so words an owner set stay. */
export const FIELD_LABELS: Record<string, Record<string, FieldLabels>> = {
  "forms-forms": {
    title: {
      labels: {
        ar: "العنوان"
      }
    },
    fields: {
      labels: {
        ar: "الحقول"
      },
      descriptions: {
        ar: "ما يسأله النموذج، بالترتيب."
      }
    },
    submitLabel: {
      labels: {
        ar: "نص الزر"
      },
      descriptions: {
        ar: "زر الإرسال. «إرسال» إن تُرك فارغًا."
      }
    },
    successMessage: {
      labels: {
        ar: "رسالة النجاح"
      },
      descriptions: {
        ar: "تظهر بعد الإرسال."
      }
    },
    notify: {
      labels: {
        ar: "أرسل إشعارًا إلى"
      },
      descriptions: {
        ar: "من يتلقى كل إرسال، مفصولين بفواصل. الفارغ يستخدم العناوين في النماذج ← الإعدادات."
      }
    },
    captcha: {
      labels: {
        ar: "CAPTCHA"
      },
      descriptions: {
        ar: "اطلب CAPTCHA الموقع، حين يُضبط في الإضافات ← CAPTCHA."
      }
    }
  },
  "forms-submissions": {
    form: {
      labels: {
        ar: "النموذج"
      }
    },
    email: {
      labels: {
        ar: "البريد الإلكتروني"
      },
      descriptions: {
        ar: "عنوان الزائر، من أول حقل بريد في النموذج. ترد الإشعارات عليه."
      }
    },
    data: {
      labels: {
        ar: "الإجابات"
      },
      descriptions: {
        ar: "الإجابات، حسب اسم الحقل."
      }
    },
    page: {
      labels: {
        ar: "الصفحة"
      },
      descriptions: {
        ar: "الصفحة التي أُرسل منها النموذج."
      }
    },
    state: {
      labels: {
        ar: "الحالة"
      },
      options: {
        new: {
          ar: "جديد"
        },
        done: {
          ar: "تم"
        },
        spam: {
          ar: "مزعج"
        }
      }
    }
  }
};

/** The same for the blocks the plugin's schema makes, by block. */
export const BLOCK_FIELD_LABELS: Record<string, Record<string, FieldLabels>> = {
  forms_embed: {
    form: {
      labels: {
        ar: "النموذج"
      }
    }
  }
};
