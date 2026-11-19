type Version = [number, number, number];

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.+-]*)?$/;

function parse(text: string): Version | null {
  const match = VERSION.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export const isVersion = (text: string) => parse(text) !== null;

function compare(a: Version, b: Version) {
  for (const index of [0, 1, 2]) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/** Whether `a` is an earlier version than `b`. */
export function isOlder(a: string, b: string) {
  const [left, right] = [parse(a), parse(b)];
  if (!left || !right) throw new Error(`Invalid version "${left ? b : a}".`);
  return compare(left, right) < 0;
}

/** The first version a caret or tilde range no longer accepts. */
function upperBound([major, minor, patch]: Version, operator: "^" | "~"): Version {
  if (operator === "~") return [major, minor + 1, 0];
  if (major > 0) return [major + 1, 0, 0];
  return minor > 0 ? [0, minor + 1, 0] : [0, 0, patch + 1];
}

/** Enough of semver for what a plugin declares: *, an exact version, ^, ~ and >=. Anything else is an invalid range, so it can't quietly pass. */
export function satisfies(version: string, range: string): boolean {
  const current = parse(version);
  if (!current) throw new Error(`Invalid version "${version}".`);
  const text = range.trim();
  if (text === "*") return true;
  const operator = /^(\^|~|>=)/.exec(text)?.[1] as "^" | "~" | ">=" | undefined;
  const base = parse(operator ? text.slice(operator.length) : text);
  if (!base) throw new Error(`Invalid version range "${range}".`);
  if (!operator) return compare(current, base) === 0;
  if (compare(current, base) < 0) return false;
  return operator === ">=" || compare(current, upperBound(base, operator)) < 0;
}
