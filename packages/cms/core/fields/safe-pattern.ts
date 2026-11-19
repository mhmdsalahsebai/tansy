const MAX_SOURCE = 500;
const MAX_REPEATS = 2;

export const MAX_PATTERN_INPUT = 4096;

/**
 * Field patterns run on every write, including writes from the public when a
 * rule allows them, and JavaScript regexes have no time limit. Reject shapes
 * that backtrack catastrophically: a repeated group holding a repeat or an
 * alternation, backreferences, and more than two repeats overall.
 */
export function patternProblem(source: string): string | null {
  if (source.length > MAX_SOURCE) return `Pattern is longer than ${MAX_SOURCE} characters.`;
  try {
    new RegExp(source);
  } catch {
    return "Pattern is not a valid regular expression.";
  }

  const open: Array<{ risky: boolean }> = [];
  let closed: { risky: boolean } | null = null;
  let inClass = false;
  let repeats = 0;

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      if (!inClass && /[1-9k]/.test(source[i + 1] ?? "")) return "Pattern cannot use backreferences.";
      i++;
      closed = null;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      closed = null;
      continue;
    }
    if (c === "(") {
      open.push({ risky: false });
      if (source[i + 1] === "?") i++;
      closed = null;
      continue;
    }
    if (c === ")") {
      closed = open.pop() ?? null;
      if (closed?.risky && open.length) open[open.length - 1].risky = true;
      continue;
    }
    if (c === "|") {
      if (open.length) open[open.length - 1].risky = true;
      closed = null;
      continue;
    }

    const brace = c === "{" ? /^\{\d+(,\d*)?\}/.exec(source.slice(i)) : null;
    if (c === "*" || c === "+" || brace) {
      if (closed?.risky) return "Pattern repeats a group that contains a repeat or alternation, which can hang the server.";
      if (++repeats > MAX_REPEATS) return `Pattern can use at most ${MAX_REPEATS} repeats.`;
      for (const group of open) group.risky = true;
      if (brace) i += brace[0].length - 1;
      if (source[i + 1] === "?") i++;
    } else if (c === "?" && source[i + 1] === "?") {
      i++;
    }
    closed = null;
  }
  return null;
}
