const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

const formats = new Map<string, Intl.RelativeTimeFormat>();
const formatFor = (locale: string) => {
  let format = formats.get(locale);
  if (!format) formats.set(locale, (format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })));
  return format;
};

/** "3 minutes ago" or "in 2 days", in the interface language. Needs no time zone, so a server can render it. */
export function relativeTime(value: string | Date, now = Date.now(), locale = "en") {
  const format = formatFor(locale);
  const diff = new Date(value).getTime() - now;
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return format.format(Math.round(diff / size), unit);
  }
  // Intl says "now", which reads oddly alone in English. Other languages use their own word.
  if (Math.abs(diff) < 45_000) return locale === "en" ? "just now" : format.format(0, "second");
  return format.format(Math.round(diff / 60_000), "minute");
}
