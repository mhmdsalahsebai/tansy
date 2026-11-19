import { siteWords, type SiteWords } from "tansy/react";
import { siteMessages } from "./site-messages";

const ENGLISH: SiteWords = { locale: "en", messages: siteMessages.en };

/** The LMS's words in the page's language, or in English where a theme passes none. */
export const lmsWords = (words: SiteWords | null | undefined) => siteWords(words ?? ENGLISH);
