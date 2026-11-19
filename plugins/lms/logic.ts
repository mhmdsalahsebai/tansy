/** Pure helpers, shared by the server half and the render module. No imports, so both can use them. */

/** Lowercase letters, digits and single hyphens, from any title. */
export function slugify(text: string, fallback = "lesson"): string {
  const slug = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
  return slug || fallback;
}

export interface QuestionBlock { id: string; type: string; value: Record<string, unknown> }
export interface PublicQuestion { id: string; prompt: string; kind: "single" | "multiple" | "short"; choices: string[] }
export type Answer = number | number[] | string;

const KINDS = new Set(["single", "multiple", "short"]);
const kindOf = (value: unknown): PublicQuestion["kind"] => (typeof value === "string" && KINDS.has(value) ? value as PublicQuestion["kind"] : "single");
const choicesOf = (value: unknown) => (Array.isArray(value) ? value.filter((choice): choice is string => typeof choice === "string").slice(0, 50) : []);

/** The questions of a quiz's stream, in order. Anything that isn't a question is skipped. */
export function questionsOf(stream: unknown): QuestionBlock[] {
  if (!Array.isArray(stream)) return [];
  return stream.filter((block): block is QuestionBlock => !!block && typeof block === "object" && (block as QuestionBlock).type === "lms_question" && typeof (block as QuestionBlock).id === "string" && !!(block as QuestionBlock).value && typeof (block as QuestionBlock).value === "object");
}

/** What a learner may see of a question: never its answer or explanation. Built field by field, so a field added later stays out. */
export function publicQuestion(block: QuestionBlock): PublicQuestion {
  const kind = kindOf(block.value.kind);
  return { id: block.id, prompt: typeof block.value.prompt === "string" ? block.value.prompt : "", kind, choices: kind === "short" ? [] : choicesOf(block.value.choices) };
}

const normalize = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const indexes = (value: unknown) => (Array.isArray(value) ? value : [value]).filter((item): item is number => Number.isSafeInteger(item));

/** Whether one answer is right. A question with no usable answer key counts as wrong, so a mistake in it never gives marks away. */
export function isCorrect(block: QuestionBlock, answer: unknown): boolean {
  const kind = kindOf(block.value.kind);
  const correct = block.value.correct;
  if (kind === "short") {
    const accepted = (Array.isArray(correct) ? correct : [correct]).filter((item): item is string => typeof item === "string" && item.trim() !== "").map(normalize);
    return typeof answer === "string" && accepted.includes(normalize(answer));
  }
  const key = [...new Set(indexes(correct))].sort((a, b) => a - b);
  if (!key.length) return false;
  if (kind === "single") return key.length === 1 && typeof answer === "number" && answer === key[0];
  if (!Array.isArray(answer) || !answer.every((item) => Number.isSafeInteger(item))) return false;
  const given = [...new Set(answer as number[])].sort((a, b) => a - b);
  return given.length === key.length && given.every((item, i) => item === key[i]);
}

/** A whole-number percentage. A quiz with no questions can't be passed. */
export function grade(questions: QuestionBlock[], answers: Record<string, unknown>) {
  if (!questions.length) return { score: 0, correct: 0, total: 0 };
  const correct = questions.filter((question) => Object.hasOwn(answers, question.id) && isCorrect(question, answers[question.id])).length;
  return { score: Math.round((correct / questions.length) * 100), correct, total: questions.length };
}

/** Crockford's base32 without the letters people misread, so a code read aloud or typed by hand still matches. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CERTIFICATE_CODE = /^[0-9A-HJKMNP-TV-Z]{16}$/;

/** 16 characters from 80 random bits. `random` returns that many random bytes. */
export function certificateCode(random: (size: number) => Uint8Array): string {
  const bytes = random(10);
  let bits = 0;
  let value = 0;
  let code = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      code += CODE_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return code;
}

/** As typed: spaces, hyphens and lowercase are forgiven. */
export const normalizeCode = (text: string) => text.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");

/** Lessons in reading order: by their section's position, then their own. Lessons outside a section come first. */
export function orderLessons<T extends { id: number; section?: unknown; position?: unknown }>(lessons: T[], sections: Array<{ id: number; position?: unknown }>): T[] {
  const sectionOrder = new Map(sections.map((section) => [section.id, typeof section.position === "number" ? section.position : Number.MAX_SAFE_INTEGER]));
  const rank = (lesson: T) => (typeof lesson.section === "number" ? sectionOrder.get(lesson.section) ?? Number.MAX_SAFE_INTEGER : -1);
  const own = (lesson: T) => (typeof lesson.position === "number" ? lesson.position : Number.MAX_SAFE_INTEGER);
  return [...lessons].sort((a, b) => rank(a) - rank(b) || (typeof a.section === "number" && typeof b.section === "number" ? a.section - b.section : 0) || own(a) - own(b) || a.id - b.id);
}

/** Whole-number percent of lessons done. */
export const percentDone = (done: number, total: number) => (total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0);

/** A privacy-friendly embed address for a YouTube or Vimeo link over https, or null for anything else. */
export function embedUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.replace(/^www\./, "");
  const id = (value: string | null | undefined, pattern: RegExp) => (value && pattern.test(value) ? value : null);
  const youtube = /^[A-Za-z0-9_-]{6,20}$/;
  let video: string | null = null;
  if (host === "youtube.com" || host === "m.youtube.com") video = id(parsed.pathname === "/watch" ? parsed.searchParams.get("v") : parsed.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1], youtube);
  else if (host === "youtu.be") video = id(parsed.pathname.slice(1), youtube);
  if (video) return `https://www.youtube-nocookie.com/embed/${video}`;
  if (host === "vimeo.com") {
    const vimeo = id(parsed.pathname.slice(1), /^\d{1,12}$/);
    if (vimeo) return `https://player.vimeo.com/video/${vimeo}`;
  }
  return null;
}

/** A price in the page's language, such as "$49.00". An unknown currency shows its code. */
export const money = (amount: number, currency: string, locale: string) => {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() }).format(amount);
  } catch {
    return `${amount} ${currency.toUpperCase()}`;
  }
};
