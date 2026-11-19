import type { FieldLabels } from "tansy/plugin";

/** The LMS's dashboard words, read as `t("ext.lms.<key>")`, and its collections' names. */
export const messages = {
  en: {
    section: "LMS",
    pages: { "lms/courses": "Courses", "lms/courses/:id": "Course", "lms/learners": "Learners" },
    collections: { "lms-my-courses": "My courses page", "lms-certificate": "Certificate check page" },
    widgets: { "lms-overview": "Courses" },
    actions: { "lms-enroll": "Enroll users" },
    categories: { Lesson: "Lesson" },
    settings: {
      passingScore: { label: "Passing score (%)", description: "Needed to pass a quiz that doesn't set its own." },
      requireQuizzes: { label: "Require quizzes", description: "A course counts as completed only once its quizzes are passed." },
      certificates: { label: "Issue certificates", description: "Give each learner a certificate, with a code anyone can check, when they complete a course." },
    },
    common: {
      course: "Course {id}",
      draft: " (draft)",
      published: "Published",
      draftBadge: "Draft",
      percent: "{value}%",
    },
    learners: {
      cantRead: "You can't read the LMS collections. Ask an administrator for permission to list courses, lessons, enrollments and progress.",
      intro: "Enrollments and progress by course. Enroll people from a course's actions in its record list, and revoke an enrollment under Enrollments.",
      noCourses: "No courses yet.",
    },
    columns: { course: "Course", enrolled: "Enrolled", completed: "Completed", completedWeek: "Completed this week", average: "Average progress", passRate: "Quiz pass rate", status: "Status", taughtBy: "Taught by", lessons: "Lessons" },
    courses: {
      allDescription: "Every course. Open one to build its sections, lessons and quizzes on one page.",
      ownDescription: "Your courses. Open one to build its sections, lessons and quizzes on one page.",
      cantList: "You can't list courses. Ask an administrator for the Instructor or LMS manager role.",
      empty: "No courses yet. Create the first one above.",
      notFound: "Course not found",
      notFoundBody: "It may have been deleted, or it isn't one of yours.",
      back: "Back to courses",
      create: "Create course",
      newTitle: "New course title",
      notCreated: "The course wasn't created.",
    },
    widget: {
      cantRead: "You can't read Enrollments.",
      newEnrollments: "{count, plural, one {# new enrollment this week} other {# new enrollments this week}}",
      completed: "{count, plural, one {# course completed this week} other {# courses completed this week}}",
      mostStarted: "Most started: {courses}",
    },
    builder: {
      notSaved: "Not saved.",
      failed: "The request failed ({status}).",
      moveUp: "Move up",
      moveDown: "Move down",
      moveLabelUp: "Move {label} up",
      moveLabelDown: "Move {label} down",
      published: "Published",
      draft: "Draft",
      wrong: "Something went wrong. Try again.",
      loading: "Loading the course…",
      detailsSaved: "Course details saved.",
      quizTitle: "{lesson} quiz",
      quizAdded: "Quiz added at the end of the lesson. Write its questions in the quiz editor.",
      lessonTitle: "Lesson title",
      freePreview: "Free preview",
      quiz: "Quiz:",
      addQuiz: "Add quiz",
      editContent: "Edit content",
      sectionFor: "Section for {lesson}",
      noSection: "No section",
      removePreview: "Remove preview",
      makePreview: "Make preview",
      unpublish: "Unpublish",
      publish: "Publish",
      confirmDeleteLesson: "Delete the lesson \"{lesson}\"?",
      lessonDeleted: "Lesson deleted.",
      delete: "Delete",
      backToCourses: "← Courses",
      counts: "{lessons, plural, one {# lesson} other {# lessons}} in {sections, plural, one {# section} other {# sections}}",
      coverAndDescription: "Cover and description",
      draftAgain: "The course is a draft again.",
      nowPublished: "The course is published.",
      unpublishCourse: "Unpublish course",
      publishCourse: "Publish course",
      curriculum: "Curriculum",
      sectionTitle: "Section title",
      moveLessonsFirst: "Move or delete its lessons first.",
      confirmDeleteSection: "Delete the section \"{section}\"?",
      sectionDeleted: "Section deleted.",
      deleteSection: "Delete section",
      notInSection: "Not in a section",
      noLessons: "No lessons yet.",
      addLesson: "Add lesson",
      newLesson: "New lesson title",
      lessonAdded: "Lesson added as a draft.",
      start: "Start with a section, such as \"Getting started\", then add lessons to it.",
      addSection: "Add section",
      newSection: "New section title",
      sectionAdded: "Section added.",
      lessonWithoutSection: "Or a lesson without a section",
      details: "Details",
      title: "Title",
      summary: "Summary",
      summaryHint: "One or two sentences for course lists.",
      whoCanEnroll: "Who can enroll",
      accessFree: "Anyone signed in, for free",
      accessPaid: "People who buy it",
      accessEnrollment: "Only people staff enroll",
      price: "Price",
      priceHint: "As learners pay it, such as 49.99. The currency is set under Payments → Settings.",
      noPayments: "To sell courses, turn on the Payments plugin, then add a Price field to Courses under Collections.",
      level: "Level",
      notSet: "Not set",
      beginner: "Beginner",
      intermediate: "Intermediate",
      advanced: "Advanced",
      minutes: "Estimated minutes",
      taughtBy: "Taught by",
      taughtByManager: "Shown on the course page.",
      taughtByOwn: "Your name, from your account. An LMS manager can change it.",
      saveDetails: "Save details",
    },
    enroll: {
      prompt: "Email addresses of the people to enroll, separated by commas or spaces:",
      failed: "Nobody was enrolled. Check the addresses and try again.",
      result: "{enrolled} enrolled, {already} already enrolled.",
      resultUnknown: "{enrolled} enrolled, {already} already enrolled, {unknown} with no account.",
      builderPanel: "Sections, lessons and their order are edited in the {link}.",
      builderLink: "course builder",
    },
    editors: {
      startWriting: "Start writing…",
      video: "Video",
      uploadVideo: "Upload a video",
      orPaste: "Or paste a YouTube or Vimeo link:",
      videoTitle: "Title, read out by screen readers",
      transcript: "Transcript",
      addTranscript: "Add a transcript…",
      download: "Download",
      downloadFile: "The file to download",
      ask: "Ask a question",
      accepted: "Accepted answers, one per line",
      choiceCorrect: "Choice {number} is correct",
      correct: "Correct answer",
      choice: "Choice {number}",
      removeChoice: "Remove choice {number}",
      addChoice: "+ Add a choice",
      explanation: "Explanation, shown after answering",
      why: "Why this is the answer…",
    },
  },
  ar: {
    section: "التعلّم",
    pages: { "lms/courses": "الدورات", "lms/courses/:id": "الدورة", "lms/learners": "المتعلمون" },
    collections: { "lms-my-courses": "صفحة دوراتي", "lms-certificate": "صفحة التحقق من الشهادات" },
    widgets: { "lms-overview": "الدورات" },
    actions: { "lms-enroll": "تسجيل مستخدمين" },
    categories: { Lesson: "الدرس" },
    settings: {
      passingScore: { label: "درجة النجاح (%)", description: "المطلوبة لاجتياز اختبار لا يحدد درجته." },
      requireQuizzes: { label: "اشتراط الاختبارات", description: "لا تُحسب الدورة مكتملة إلا بعد اجتياز اختباراتها." },
      certificates: { label: "إصدار الشهادات", description: "امنح كل متعلم شهادة برمز يستطيع أي أحد التحقق منه، حين يُكمل دورة." },
    },
    common: {
      course: "الدورة {id}",
      draft: " (مسودة)",
      published: "منشورة",
      draftBadge: "مسودة",
      percent: "{value}٪",
    },
    learners: {
      cantRead: "لا يمكنك قراءة مجموعات التعلّم. اطلب من المسؤول صلاحية عرض الدورات والدروس والتسجيلات والتقدّم.",
      intro: "التسجيلات والتقدّم حسب الدورة. سجّل الأشخاص من إجراءات الدورة في قائمة سجلاتها، وألغِ تسجيلًا من «التسجيلات».",
      noCourses: "لا دورات بعد.",
    },
    columns: { course: "الدورة", enrolled: "المسجّلون", completed: "أكملوا", completedWeek: "أكملوا هذا الأسبوع", average: "متوسط التقدّم", passRate: "نسبة اجتياز الاختبارات", status: "الحالة", taughtBy: "المدرّس", lessons: "الدروس" },
    courses: {
      allDescription: "كل الدورات. افتح دورة لتبني أقسامها ودروسها واختباراتها في صفحة واحدة.",
      ownDescription: "دوراتك. افتح دورة لتبني أقسامها ودروسها واختباراتها في صفحة واحدة.",
      cantList: "لا يمكنك عرض الدورات. اطلب من المسؤول دور المدرّس أو مدير التعلّم.",
      empty: "لا دورات بعد. أنشئ أولى الدورات أعلاه.",
      notFound: "الدورة غير موجودة",
      notFoundBody: "ربما حُذفت، أو ليست من دوراتك.",
      back: "العودة إلى الدورات",
      create: "إنشاء دورة",
      newTitle: "عنوان الدورة الجديدة",
      notCreated: "لم تُنشأ الدورة.",
    },
    widget: {
      cantRead: "لا يمكنك قراءة التسجيلات.",
      newEnrollments: "{count, plural, zero {لا تسجيلات جديدة هذا الأسبوع} one {تسجيل جديد واحد هذا الأسبوع} two {تسجيلان جديدان هذا الأسبوع} few {# تسجيلات جديدة هذا الأسبوع} many {# تسجيلًا جديدًا هذا الأسبوع} other {# تسجيل جديد هذا الأسبوع}}",
      completed: "{count, plural, zero {لم تكتمل دورات هذا الأسبوع} one {اكتملت دورة واحدة هذا الأسبوع} two {اكتملت دورتان هذا الأسبوع} few {اكتملت # دورات هذا الأسبوع} many {اكتملت # دورة هذا الأسبوع} other {اكتملت # دورة هذا الأسبوع}}",
      mostStarted: "الأكثر بدءًا: {courses}",
    },
    builder: {
      notSaved: "لم يُحفظ.",
      failed: "فشل الطلب ({status}).",
      moveUp: "نقل لأعلى",
      moveDown: "نقل لأسفل",
      moveLabelUp: "نقل {label} لأعلى",
      moveLabelDown: "نقل {label} لأسفل",
      published: "منشور",
      draft: "مسودة",
      wrong: "حدث خطأ ما. حاول مجددًا.",
      loading: "جارٍ تحميل الدورة…",
      detailsSaved: "حُفظت تفاصيل الدورة.",
      quizTitle: "اختبار {lesson}",
      quizAdded: "أُضيف اختبار في نهاية الدرس. اكتب أسئلته في محرر الاختبار.",
      lessonTitle: "عنوان الدرس",
      freePreview: "معاينة مجانية",
      quiz: "الاختبار:",
      addQuiz: "إضافة اختبار",
      editContent: "تحرير المحتوى",
      sectionFor: "قسم {lesson}",
      noSection: "بلا قسم",
      removePreview: "إزالة المعاينة",
      makePreview: "جعله معاينة",
      unpublish: "إلغاء النشر",
      publish: "نشر",
      confirmDeleteLesson: "حذف الدرس «{lesson}»؟",
      lessonDeleted: "حُذف الدرس.",
      delete: "حذف",
      backToCourses: "→ الدورات",
      counts: "{lessons, plural, zero {لا دروس} one {درس واحد} two {درسان} few {# دروس} many {# درسًا} other {# درس}} في {sections, plural, zero {لا أقسام} one {قسم واحد} two {قسمين} few {# أقسام} many {# قسمًا} other {# قسم}}",
      coverAndDescription: "الغلاف والوصف",
      draftAgain: "عادت الدورة مسودة.",
      nowPublished: "نُشرت الدورة.",
      unpublishCourse: "إلغاء نشر الدورة",
      publishCourse: "نشر الدورة",
      curriculum: "المنهج",
      sectionTitle: "عنوان القسم",
      moveLessonsFirst: "انقل دروسه أو احذفها أولًا.",
      confirmDeleteSection: "حذف القسم «{section}»؟",
      sectionDeleted: "حُذف القسم.",
      deleteSection: "حذف القسم",
      notInSection: "ليست في قسم",
      noLessons: "لا دروس بعد.",
      addLesson: "إضافة درس",
      newLesson: "عنوان الدرس الجديد",
      lessonAdded: "أُضيف الدرس مسودة.",
      start: "ابدأ بقسم، مثل «البدء»، ثم أضف إليه دروسًا.",
      addSection: "إضافة قسم",
      newSection: "عنوان القسم الجديد",
      sectionAdded: "أُضيف القسم.",
      lessonWithoutSection: "أو درسًا بلا قسم",
      details: "التفاصيل",
      title: "العنوان",
      summary: "الملخّص",
      summaryHint: "جملة أو اثنتان لقوائم الدورات.",
      whoCanEnroll: "من يمكنه التسجيل",
      accessFree: "أي شخص مسجّل الدخول، مجانًا",
      accessPaid: "من يشتريها",
      accessEnrollment: "من يسجّلهم الموظفون فقط",
      price: "السعر",
      priceHint: "كما يدفعه المتعلمون، مثل 49.99. تُضبط العملة من المدفوعات ← الإعدادات.",
      noPayments: "لبيع الدورات، فعّل إضافة المدفوعات، ثم أضف حقل سعر إلى الدورات من المجموعات.",
      level: "المستوى",
      notSet: "غير محدد",
      beginner: "مبتدئ",
      intermediate: "متوسط",
      advanced: "متقدم",
      minutes: "الدقائق المقدّرة",
      taughtBy: "المدرّس",
      taughtByManager: "يظهر في صفحة الدورة.",
      taughtByOwn: "اسمك، من حسابك. يستطيع مدير التعلّم تغييره.",
      saveDetails: "حفظ التفاصيل",
    },
    enroll: {
      prompt: "عناوين البريد للأشخاص المراد تسجيلهم، مفصولة بفواصل أو مسافات:",
      failed: "لم يُسجَّل أحد. تحقق من العناوين وحاول مجددًا.",
      result: "سُجّل {enrolled}، و{already} مسجّلون من قبل.",
      resultUnknown: "سُجّل {enrolled}، و{already} مسجّلون من قبل، و{unknown} بلا حساب.",
      builderPanel: "تُحرَّر الأقسام والدروس وترتيبها في {link}.",
      builderLink: "منشئ الدورة",
    },
    editors: {
      startWriting: "ابدأ الكتابة…",
      video: "فيديو",
      uploadVideo: "ارفع فيديو",
      orPaste: "أو الصق رابطًا من YouTube أو Vimeo:",
      videoTitle: "العنوان، تقرؤه قارئات الشاشة",
      transcript: "النص المكتوب",
      addTranscript: "أضف نصًّا مكتوبًا…",
      download: "تنزيل",
      downloadFile: "الملف المراد تنزيله",
      ask: "اطرح سؤالًا",
      accepted: "الإجابات المقبولة، واحدة في كل سطر",
      choiceCorrect: "الخيار {number} صحيح",
      correct: "الإجابة الصحيحة",
      choice: "الخيار {number}",
      removeChoice: "إزالة الخيار {number}",
      addChoice: "+ أضف خيارًا",
      explanation: "الشرح، يظهر بعد الإجابة",
      why: "لماذا هذه هي الإجابة…",
    },
  },
};

/** The collections' names in other interface languages. Added by a migration, so names an owner set stay. */
export const COLLECTION_LABELS: Record<string, Record<string, string>> = {
  "lms-courses": { ar: "الدورات" },
  "lms-sections": { ar: "الأقسام" },
  "lms-lessons": { ar: "الدروس" },
  "lms-quizzes": { ar: "الاختبارات" },
  "lms-enrollments": { ar: "التسجيلات" },
  "lms-progress": { ar: "التقدّم" },
  "lms-attempts": { ar: "المحاولات" },
  "lms-certificates": { ar: "الشهادات" },
  "lms-my-courses": { ar: "دوراتي" },
  "lms-certificate": { ar: "التحقق من شهادة" },
  "lms-outline": { ar: "مخطط الدورة" },
};

/** Fields' words in other interface languages, by collection. Added by a migration, so words an owner set stay. */
export const FIELD_LABELS: Record<string, Record<string, FieldLabels>> = {
  "lms-courses": {
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
    summary: {
      labels: {
        ar: "الملخص"
      }
    },
    cover: {
      labels: {
        ar: "صورة الغلاف"
      }
    },
    description: {
      labels: {
        ar: "الوصف"
      }
    },
    byline: {
      labels: {
        ar: "يقدّمها"
      }
    },
    level: {
      labels: {
        ar: "المستوى"
      },
      options: {
        beginner: {
          ar: "مبتدئ"
        },
        intermediate: {
          ar: "متوسط"
        },
        advanced: {
          ar: "متقدم"
        }
      }
    },
    access: {
      labels: {
        ar: "الالتحاق"
      },
      options: {
        free: {
          ar: "مجاني: يلتحق أي شخص سجّل الدخول"
        },
        enrollment: {
          ar: "بالتسجيل: يسجّل الطاقم المتعلمين"
        },
        paid: {
          ar: "مدفوع: يشتريها المتعلمون (تحتاج إضافة المدفوعات وسعرًا)"
        }
      }
    },
    estimatedMinutes: {
      labels: {
        ar: "المدة التقديرية (دقائق)"
      }
    }
  },
  "lms-sections": {
    title: {
      labels: {
        ar: "العنوان"
      }
    },
    course: {
      labels: {
        ar: "الدورة"
      }
    },
    position: {
      labels: {
        ar: "الترتيب"
      },
      descriptions: {
        ar: "الأصغر أولًا."
      }
    }
  },
  "lms-lessons": {
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
    course: {
      labels: {
        ar: "الدورة"
      }
    },
    section: {
      labels: {
        ar: "القسم"
      }
    },
    position: {
      labels: {
        ar: "الترتيب"
      },
      descriptions: {
        ar: "الأصغر أولًا."
      }
    },
    preview: {
      labels: {
        ar: "معاينة"
      },
      descriptions: {
        ar: "مفتوح للجميع، ملتحقين أو لا."
      }
    },
    content: {
      labels: {
        ar: "المحتوى"
      }
    },
    durationMinutes: {
      labels: {
        ar: "المدة (دقائق)"
      }
    }
  },
  "lms-quizzes": {
    title: {
      labels: {
        ar: "العنوان"
      }
    },
    lesson: {
      labels: {
        ar: "الدرس"
      }
    },
    course: {
      labels: {
        ar: "الدورة"
      },
      descriptions: {
        ar: "يُضبط من الدرس عند الحفظ."
      }
    },
    questions: {
      labels: {
        ar: "الأسئلة"
      }
    },
    passingScore: {
      labels: {
        ar: "درجة النجاح"
      },
      descriptions: {
        ar: "النسبة المئوية اللازمة للنجاح. الفارغ يستخدم القيمة الافتراضية للموقع."
      }
    },
    maxAttempts: {
      labels: {
        ar: "أقصى عدد للمحاولات"
      },
      descriptions: {
        ar: "الفارغ يعني بلا حد."
      }
    }
  },
  "lms-enrollments": {
    course: {
      labels: {
        ar: "الدورة"
      }
    },
    student: {
      labels: {
        ar: "المتعلم (معرّف المستخدم)"
      }
    },
    state: {
      labels: {
        ar: "الحالة"
      },
      options: {
        active: {
          ar: "نشط"
        },
        completed: {
          ar: "مكتمل"
        },
        revoked: {
          ar: "ملغى"
        },
        lapsed: {
          ar: "متوقف: لم تعد خطته تشمله"
        }
      }
    },
    source: {
      labels: {
        ar: "المصدر"
      },
      options: {
        free: {
          ar: "التحاق مجاني"
        },
        staff: {
          ar: "الطاقم"
        },
        purchase: {
          ar: "شراء"
        },
        plan: {
          ar: "خطة"
        }
      }
    },
    enrolledAt: {
      labels: {
        ar: "تاريخ الالتحاق"
      }
    },
    completedAt: {
      labels: {
        ar: "تاريخ الإكمال"
      }
    }
  },
  "lms-progress": {
    key: {
      labels: {
        ar: "المفتاح"
      }
    },
    student: {
      labels: {
        ar: "المتعلم (معرّف المستخدم)"
      }
    },
    course: {
      labels: {
        ar: "الدورة"
      }
    },
    lesson: {
      labels: {
        ar: "الدرس"
      }
    },
    completedAt: {
      labels: {
        ar: "تاريخ الإكمال"
      }
    }
  },
  "lms-attempts": {
    quiz: {
      labels: {
        ar: "الاختبار"
      }
    },
    student: {
      labels: {
        ar: "المتعلم (معرّف المستخدم)"
      }
    },
    answers: {
      labels: {
        ar: "الإجابات"
      }
    },
    score: {
      labels: {
        ar: "الدرجة"
      }
    },
    passed: {
      labels: {
        ar: "ناجح"
      }
    },
    submittedAt: {
      labels: {
        ar: "تاريخ التسليم"
      }
    }
  },
  "lms-certificates": {
    code: {
      labels: {
        ar: "الرمز"
      }
    },
    student: {
      labels: {
        ar: "المتعلم (معرّف المستخدم)"
      }
    },
    course: {
      labels: {
        ar: "الدورة"
      }
    },
    studentName: {
      labels: {
        ar: "اسم المتعلم"
      }
    },
    issuedAt: {
      labels: {
        ar: "تاريخ الإصدار"
      }
    }
  },
  "lms-my-courses": {
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
  },
  "lms-certificate": {
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

/** The same for the blocks the plugin's schema makes, by block. */
export const BLOCK_FIELD_LABELS: Record<string, Record<string, FieldLabels>> = {
  lms_quiz: {
    quiz: {
      labels: {
        ar: "الاختبار"
      }
    }
  }
};
