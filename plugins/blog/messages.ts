import type { FieldLabels } from "tansy/plugin";

/** The blog's dashboard words, read as `t("ext.blog.<key>")`, and its collections' names. */
export const messages = {
  en: {
    section: "Blog",
    pages: { "blog/comments": "Comments to review" },
    collections: { "blog-comments": "All comments", "blog-home": "Blog home page" },
    widgets: { "blog-overview": "Blog" },
    actions: { "blog-approve": "Approve", "blog-spam": "Mark as spam" },
    categories: { Text: "Text", Media: "Media" },
    settings: {
      comments: { label: "Comments", options: { moderated: "Held for review", open: "Shown straight away", off: "Off" } },
      notify: { label: "Email for comments to review", description: "Who to tell when a comment is waiting. Leave empty for nobody." },
      feedItems: { label: "Posts in feeds", description: "How many of the latest posts the RSS and Atom feeds list." },
    },
    queue: {
      intro: "Comments waiting for review, oldest first. Approving or marking as spam needs permission to update records in Comments.",
      cantRead: "You can't read Comments. Ask an administrator for permission to list them.",
      empty: "Nothing is waiting for review.",
      on: "{name} on {post}",
      aPost: "a post",
      showing: "Showing the oldest {shown} of {total}.",
    },
    overview: {
      pending: "{count, plural, one {# comment waiting for review} other {# comments waiting for review}}",
      drafts: "{count, plural, one {# draft post} other {# draft posts}}",
      published: "{count, plural, one {# published post} other {# published posts}}",
      unknown: "— {label}",
      pendingLabel: "comments waiting for review",
      draftsLabel: "draft posts",
      publishedLabel: "published posts",
    },
    moderate: {
      approve: "Approve",
      spam: "Spam",
      approved: "Approved",
      markedSpam: "Marked as spam",
      failed: "{count, plural, one {One comment couldn't be changed.} other {# comments couldn't be changed.}} Changing comments needs permission to update records in Comments.",
    },
    editors: {
      startWriting: "Start writing…",
      quote: "Write a quote…",
      source: "Who said it",
      note: "Write a note…",
      image: "Image",
      caption: "Add a caption",
      alt: "Alt text: what the image shows, for people who can't see it",
      video: "Video",
      pasteVideo: "Paste a YouTube or Vimeo link.",
      code: "Paste or write code",
      language: "Language, such as ts",
    },
  },
  ar: {
    section: "المدونة",
    pages: { "blog/comments": "تعليقات بانتظار المراجعة" },
    collections: { "blog-comments": "كل التعليقات", "blog-home": "الصفحة الرئيسية للمدونة" },
    widgets: { "blog-overview": "المدونة" },
    actions: { "blog-approve": "موافقة", "blog-spam": "وسم كرسالة مزعجة" },
    categories: { Text: "نص", Media: "وسائط" },
    settings: {
      comments: { label: "التعليقات", options: { moderated: "تُحجز للمراجعة", open: "تظهر فورًا", off: "معطّلة" } },
      notify: { label: "بريد التعليقات التي تنتظر المراجعة", description: "من يُبلَّغ حين ينتظر تعليق المراجعة. اتركه فارغًا لعدم إبلاغ أحد." },
      feedItems: { label: "عدد المقالات في الخلاصات", description: "كم مقالًا من الأحدث تعرضه خلاصتا RSS وAtom." },
    },
    queue: {
      intro: "تعليقات تنتظر المراجعة، الأقدم أولًا. تتطلب الموافقة أو الوسم كرسالة مزعجة صلاحية تحديث السجلات في التعليقات.",
      cantRead: "لا يمكنك قراءة التعليقات. اطلب من المسؤول صلاحية عرضها.",
      empty: "لا شيء ينتظر المراجعة.",
      on: "{name} على {post}",
      aPost: "مقال",
      showing: "يُعرض أقدم {shown} من {total}.",
    },
    overview: {
      pending: "{count, plural, zero {لا تعليقات تنتظر المراجعة} one {تعليق واحد ينتظر المراجعة} two {تعليقان ينتظران المراجعة} few {# تعليقات تنتظر المراجعة} many {# تعليقًا ينتظر المراجعة} other {# تعليق ينتظر المراجعة}}",
      drafts: "{count, plural, zero {لا مسودات} one {مسودة واحدة} two {مسودتان} few {# مسودات} many {# مسودة} other {# مسودة}}",
      published: "{count, plural, zero {لا مقالات منشورة} one {مقال منشور واحد} two {مقالان منشوران} few {# مقالات منشورة} many {# مقالًا منشورًا} other {# مقال منشور}}",
      unknown: "— {label}",
      pendingLabel: "تعليقات تنتظر المراجعة",
      draftsLabel: "مسودات",
      publishedLabel: "مقالات منشورة",
    },
    moderate: {
      approve: "موافقة",
      spam: "مزعج",
      approved: "تمت الموافقة",
      markedSpam: "وُسم كرسالة مزعجة",
      failed: "{count, plural, one {تعذّر تغيير تعليق واحد.} two {تعذّر تغيير تعليقين.} few {تعذّر تغيير # تعليقات.} many {تعذّر تغيير # تعليقًا.} other {تعذّر تغيير # تعليق.}} يتطلب تغيير التعليقات صلاحية تحديث السجلات في التعليقات.",
    },
    editors: {
      startWriting: "ابدأ الكتابة…",
      quote: "اكتب اقتباسًا…",
      source: "قائله",
      note: "اكتب ملاحظة…",
      image: "صورة",
      caption: "أضف تعليقًا توضيحيًا",
      alt: "النص البديل: ما تُظهره الصورة، لمن لا يستطيع رؤيتها",
      video: "فيديو",
      pasteVideo: "الصق رابطًا من YouTube أو Vimeo.",
      code: "الصق رمزًا برمجيًا أو اكتبه",
      language: "اللغة، مثل ts",
    },
  },
};

/** The collections' names in other interface languages. Added by a migration, so names an owner set stay. */
export const COLLECTION_LABELS: Record<string, Record<string, string>> = {
  "blog-categories": { ar: "التصنيفات" },
  "blog-tags": { ar: "الوسوم" },
  "blog-posts": { ar: "المقالات" },
  "blog-comments": { ar: "التعليقات" },
  "blog-home": { ar: "رئيسية المدونة" },
};

/** Fields' words in other interface languages, by collection. Added by a migration, so words an owner set stay. */
export const FIELD_LABELS: Record<string, Record<string, FieldLabels>> = {
  "blog-categories": {
    slug: {
      labels: {
        ar: "الاسم اللطيف"
      },
      descriptions: {
        ar: "يظهر في العنوان. أحرف لاتينية صغيرة وأرقام وشرطات. يُملأ من العنوان إن تُرك فارغًا."
      }
    },
    name: {
      labels: {
        ar: "الاسم"
      }
    },
    description: {
      labels: {
        ar: "الوصف"
      }
    },
    parent: {
      labels: {
        ar: "التصنيف الأب"
      }
    }
  },
  "blog-tags": {
    slug: {
      labels: {
        ar: "الاسم اللطيف"
      },
      descriptions: {
        ar: "يظهر في العنوان. أحرف لاتينية صغيرة وأرقام وشرطات. يُملأ من العنوان إن تُرك فارغًا."
      }
    },
    name: {
      labels: {
        ar: "الاسم"
      }
    }
  },
  "blog-posts": {
    title: {
      labels: {
        ar: "العنوان"
      }
    },
    slug: {
      labels: {
        ar: "الاسم اللطيف"
      },
      descriptions: {
        ar: "يظهر في العنوان. أحرف لاتينية صغيرة وأرقام وشرطات. يُملأ من العنوان إن تُرك فارغًا."
      }
    },
    excerpt: {
      labels: {
        ar: "المقتطف"
      }
    },
    cover: {
      labels: {
        ar: "صورة الغلاف"
      }
    },
    body: {
      labels: {
        ar: "المحتوى"
      }
    },
    byline: {
      labels: {
        ar: "الكاتب"
      }
    },
    categories: {
      labels: {
        ar: "التصنيفات"
      }
    },
    tags: {
      labels: {
        ar: "الوسوم"
      }
    },
    featured: {
      labels: {
        ar: "مميّزة"
      }
    },
    allowComments: {
      labels: {
        ar: "السماح بالتعليقات"
      }
    },
    readingMinutes: {
      labels: {
        ar: "مدة القراءة (دقائق)"
      }
    }
  },
  "blog-comments": {
    post: {
      labels: {
        ar: "المقالة"
      }
    },
    parent: {
      labels: {
        ar: "ردًا على"
      }
    },
    name: {
      labels: {
        ar: "الاسم"
      }
    },
    body: {
      labels: {
        ar: "التعليق"
      }
    },
    state: {
      labels: {
        ar: "الحالة"
      },
      options: {
        pending: {
          ar: "بانتظار المراجعة"
        },
        approved: {
          ar: "مقبول"
        },
        spam: {
          ar: "مزعج"
        }
      }
    }
  },
  "blog-home": {
    title: {
      labels: {
        ar: "العنوان"
      }
    },
    intro: {
      labels: {
        ar: "المقدمة"
      }
    }
  }
};
