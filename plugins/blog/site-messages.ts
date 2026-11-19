import { siteWords, type SiteWords } from "tansy/react";

/** What visitors read on the blog's pages, read as `t("blog.<key>")`. Themes and owners can word any of it differently. */
export const siteMessages = {
  en: {
    blog: {
      home: "Blog",
      noPosts: "No posts yet.",
      noPostsHere: "No posts here yet.",
      newerPosts: "Newer posts",
      olderPosts: "Older posts",
      minutes: "{count, plural, one {# min read} other {# min read}}",
      tags: "Tags",
      morePosts: "More posts",
      category: "Category",
      tag: "Tag",
      video: "Video",
      comments: "Comments",
      noComments: "No comments yet.",
      leaveComment: "Leave a comment",
      name: "Name",
      comment: "Comment",
      reply: "Reply",
      postComment: "Post comment",
      postReply: "Post reply",
      posting: "Posting…",
      cancel: "Cancel",
      waiting: "Waiting for review",
      signIn: "Sign in to comment.",
      failed: "Your comment couldn't be posted. Try again.",
      offline: "Your comment couldn't be posted. Check your connection and try again.",
    },
  },
  ar: {
    blog: {
      home: "المدونة",
      noPosts: "لا توجد مقالات بعد.",
      noPostsHere: "لا توجد مقالات هنا بعد.",
      newerPosts: "مقالات أحدث",
      olderPosts: "مقالات أقدم",
      minutes: "{count, plural, zero {أقل من دقيقة قراءة} one {دقيقة قراءة} two {دقيقتا قراءة} few {# دقائق قراءة} many {# دقيقة قراءة} other {# دقيقة قراءة}}",
      tags: "الوسوم",
      morePosts: "مقالات أخرى",
      category: "تصنيف",
      tag: "وسم",
      video: "فيديو",
      comments: "التعليقات",
      noComments: "لا توجد تعليقات بعد.",
      leaveComment: "اترك تعليقًا",
      name: "الاسم",
      comment: "التعليق",
      reply: "رد",
      postComment: "نشر التعليق",
      postReply: "نشر الرد",
      posting: "جارٍ النشر…",
      cancel: "إلغاء",
      waiting: "بانتظار المراجعة",
      signIn: "سجّل الدخول لتعلّق.",
      failed: "تعذّر نشر تعليقك. حاول مجددًا.",
      offline: "تعذّر نشر تعليقك. تحقق من اتصالك وحاول مجددًا.",
    },
  },
};

const ENGLISH: SiteWords = { locale: "en", messages: siteMessages.en };

/** The blog's words in the page's language, or in English where a theme passes none. */
export const blogWords = (words: SiteWords | undefined) => siteWords(words ?? ENGLISH);
