import { parseRule, RuleSyntaxError, type Modifier, type Operand, type Operator, type RuleNode } from "./parser";

/** Every value of a field across a collection, for @collection.<name>.<field>. Throws to deny. */
export type CollectionLookup = (collection: string, field: string) => unknown[];

/** Field names by collection slug, for checking @collection references when a rule is saved. */
export type RuleCatalog = ReadonlyMap<string, ReadonlySet<string>>;

export interface RuleContext {
  /** Absent where @collection is not allowed, such as caller-supplied filters. */
  lookup?: CollectionLookup;
  record: Record<string, unknown>;
  request: {
    auth: Record<string, unknown>;
    body: Record<string, unknown>;
    query: Record<string, unknown>;
    headers: Record<string, unknown>;
    method: string;
    context: string;
    /** The language a request reads or writes, or "" for one that named none. */
    locale?: string;
    /** The row scope value the request is for (core/scope), or "" for none. */
    scope?: string;
  };
  now?: Date;
  /**
   * What a relation-following comparison such as `author.name = "x"` answers for a
   * record, by `nodeKey`. Set only where those paths were resolved against the target
   * collection before the query ran (core/content/relations.ts), which is the only way
   * one can be answered: the evaluator is synchronous and can't read another table.
   */
  relations?: ReadonlyMap<string, (record: Record<string, unknown>) => boolean>;
}

/** Identifies one comparison, so a condition resolved before the query can be found again while compiling or evaluating it. */
export const nodeKey = (node: RuleNode) => JSON.stringify(node);

export const SYSTEM_RECORD_FIELDS = ["id", "status", "createdAt", "updatedAt", "publishedAt", "createdById"];
export const AUTH_RULE_FIELDS = ["id", "email", "name", "role", "emailVerified", "twoFactorEnabled", "createdAt", "updatedAt"];

const DATE_MACROS = ["@now", "@yesterday", "@tomorrow", "@todayStart", "@todayEnd", "@monthStart", "@monthEnd", "@yearStart", "@yearEnd"];
const NUMBER_MACROS = ["@second", "@minute", "@hour", "@weekday", "@day", "@month", "@year"];

function macro(name: string, now: Date): unknown {
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  const utc = (...a: [number, number, number, number?, number?, number?, number?]) => new Date(Date.UTC(...a)).toISOString();
  switch (name) {
    case "@now": return now.toISOString();
    case "@yesterday": return new Date(now.getTime() - 86_400_000).toISOString();
    case "@tomorrow": return new Date(now.getTime() + 86_400_000).toISOString();
    case "@todayStart": return utc(y, m, d);
    case "@todayEnd": return utc(y, m, d, 23, 59, 59, 999);
    case "@monthStart": return utc(y, m, 1);
    case "@monthEnd": return utc(y, m + 1, 0, 23, 59, 59, 999);
    case "@yearStart": return utc(y, 0, 1);
    case "@yearEnd": return utc(y, 11, 31, 23, 59, 59, 999);
    case "@second": return now.getUTCSeconds();
    case "@minute": return now.getUTCMinutes();
    case "@hour": return now.getUTCHours();
    case "@weekday": return now.getUTCDay();
    case "@day": return d;
    case "@month": return m + 1;
    case "@year": return y;
    default: throw new RuleSyntaxError(`Unknown macro ${name}.`);
  }
}

export const walk = (source: unknown, path: string[]): { found: boolean; value: unknown } => {
  let current = source;
  for (const key of path) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: current };
};

export type Resolved = { value: unknown; each?: boolean };

export function resolve(operand: Operand, ctx: RuleContext): Resolved {
  if (operand.kind === "literal") return { value: operand.value };
  const { path, modifier } = operand;
  const now = ctx.now ?? new Date();
  if (path[0] === "@collection") {
    if (!ctx.lookup || path.length !== 3) throw new RuleSyntaxError("@collection lookups are not available here.");
    return applyModifier(modifier, { found: true, value: ctx.lookup(path[1], path[2]) });
  }
  if (path[0].startsWith("@") && path[0] !== "@request") return { value: macro(path[0], now) };

  let lookup: { found: boolean; value: unknown };
  let bodyKey: string[] | null = null;
  if (path[0] === "@request") {
    const [, section, ...rest] = path;
    if (section === "method" || section === "context") lookup = { found: true, value: ctx.request[section] };
    else if (section === "locale") lookup = { found: true, value: ctx.request.locale ?? "" };
    else if (section === "scope") lookup = { found: true, value: ctx.request.scope ?? "" };
    else if (section === "headers") lookup = walk(ctx.request.headers, rest.map((h) => h.toLowerCase().replaceAll("-", "_")));
    else if (section === "auth" || section === "body" || section === "query") {
      lookup = walk(ctx.request[section], rest);
      if (section === "body") bodyKey = rest;
    } else throw new RuleSyntaxError(`Unknown request property ${section}.`);
  } else {
    lookup = walk(ctx.record, path);
  }
  return applyModifier(modifier, lookup, () => bodyKey !== null && !looseEqual(lookup.value, walk(ctx.record, bodyKey).value));
}

export function applyModifier(modifier: Modifier | undefined, lookup: { found: boolean; value: unknown }, changed: () => boolean = () => false): Resolved {
  switch (modifier) {
    case undefined: return { value: lookup.value };
    case "isset": return { value: lookup.found };
    case "changed": return { value: lookup.found && changed() };
    case "length": return { value: Array.isArray(lookup.value) ? lookup.value.length : lookup.value == null || lookup.value === "" ? 0 : 1 };
    case "lower": return { value: typeof lookup.value === "string" ? lookup.value.toLowerCase() : lookup.value };
    case "each": return { value: lookup.value, each: true };
  }
}

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?/;

export const isDateLike = (value: string) => DATE_LIKE.test(value);

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return value;
}

export const normalizeValue = normalize;

function comparable(a: unknown, b: unknown): [number, number] | [string, string] {
  if (typeof a === "number" || typeof b === "number") {
    const x = Number(a), y = Number(b);
    if (!Number.isNaN(x) && !Number.isNaN(y)) return [x, y];
  }
  if (typeof a === "string" && typeof b === "string" && DATE_LIKE.test(a) && DATE_LIKE.test(b)) {
    const x = Date.parse(a.replace(" ", "T")), y = Date.parse(b.replace(" ", "T"));
    if (!Number.isNaN(x) && !Number.isNaN(y)) return [x, y];
  }
  return [String(a), String(b)];
}

function looseEqual(a: unknown, b: unknown): boolean {
  const x = normalize(a), y = normalize(b);
  if (typeof x === "object" || typeof y === "object") return JSON.stringify(x) === JSON.stringify(y);
  if (typeof x === "boolean" || typeof y === "boolean") return String(x) === String(y);
  const [p, q] = comparable(x, y);
  return p === q;
}

function like(value: unknown, pattern: unknown): boolean {
  const text = String(normalize(value)).toLowerCase();
  const raw = String(normalize(pattern)).toLowerCase();
  if (!raw.includes("%")) return text.includes(raw);
  // Matched by hand because filters come from callers, and a regex of many wildcards backtracks badly.
  const [first, ...parts] = raw.split("%");
  const last = parts.pop()!;
  if (!text.startsWith(first)) return false;
  let at = first.length;
  for (const part of parts) {
    const found = text.indexOf(part, at);
    if (found === -1) return false;
    at = found + part.length;
  }
  return text.length - last.length >= at && text.endsWith(last);
}

function compareOne(op: string, a: unknown, b: unknown): boolean {
  switch (op) {
    case "=": return looseEqual(a, b);
    case "!=": return !looseEqual(a, b);
    case "~": return like(a, b);
    case "!~": return !like(a, b);
  }
  const [x, y] = comparable(normalize(a), normalize(b));
  switch (op) {
    case ">": return x > y;
    case ">=": return x >= y;
    case "<": return x < y;
    case "<=": return x <= y;
    default: throw new RuleSyntaxError(`Unknown operator ${op}.`);
  }
}

export const compareValues = compareOne;

export function compare(op: Operator, left: Resolved, right: Resolved): boolean {
  const any = op.startsWith("?");
  const base = any ? op.slice(1) : op;
  // Copies: an empty list is padded below, and these are the record's and the caller's own values.
  const lefts = Array.isArray(left.value) ? [...left.value] : [left.value];
  const rights = Array.isArray(right.value) ? [...right.value] : [right.value];
  if (lefts.length === 0) lefts.push("");
  if (rights.length === 0) rights.push("");
  const matches = (l: unknown) => rights.some((r) => compareOne(base, l, r));
  return any ? lefts.some(matches) : lefts.every(matches);
}

export function evaluateNode(node: RuleNode, ctx: RuleContext): boolean {
  switch (node.type) {
    case "and": return evaluateNode(node.left, ctx) && evaluateNode(node.right, ctx);
    case "or": return evaluateNode(node.left, ctx) || evaluateNode(node.right, ctx);
    case "compare": {
      // A relation-following comparison was answered against the target collection already.
      const resolved = ctx.relations?.get(nodeKey(node));
      if (resolved) return resolved(ctx.record);
      return compare(node.op, resolve(node.left, ctx), resolve(node.right, ctx));
    }
  }
}

const cache = new Map<string, RuleNode>();

export function compiled(source: string): RuleNode {
  let ast = cache.get(source);
  if (!ast) {
    ast = parseRule(source);
    if (cache.size >= 1000) cache.clear();
    cache.set(source, ast);
  }
  return ast;
}

/** Fails closed: any problem evaluating a rule denies access. */
export function evaluateRule(source: string, ctx: RuleContext): boolean {
  try {
    return evaluateNode(compiled(source), ctx);
  } catch (error) {
    console.error("[rules] evaluation failed; denying", error);
    return false;
  }
}

/** Rules can't contain hyphens, and slugs can't contain underscores, so a slug is written with underscores. */
export const collectionSlug = (written: string) => written.replaceAll("_", "-");

function* identifiers(node: RuleNode): Generator<Extract<Operand, { kind: "identifier" }>> {
  if (node.type !== "compare") {
    yield* identifiers(node.left);
    yield* identifiers(node.right);
    return;
  }
  for (const operand of [node.left, node.right]) if (operand.kind === "identifier") yield operand;
}

/** Every comparison in a rule, in the order written. */
export function* compareNodes(node: RuleNode): Generator<Extract<RuleNode, { type: "compare" }>> {
  if (node.type === "compare") { yield node; return; }
  yield* compareNodes(node.left);
  yield* compareNodes(node.right);
}

/**
 * Whether a comparison names a path the record itself can't answer, such as
 * `author.name`. The caller decides what to do with one: a prepared relation
 * condition answers it, and nothing else can.
 */
export const followsRelation = (node: Extract<RuleNode, { type: "compare" }>, columns: ReadonlyMap<string, string>) =>
  [node.left, node.right].some((operand) => operand.kind === "identifier" && !operand.path[0].startsWith("@") && operand.path.length > 1 && columns.get(operand.path[0]) !== "json");

/**
 * Checks a caller-supplied filter. Only the given columns can be named, and with
 * no catalogue @collection is refused, because it would read past API rules.
 * `relations` names the relations this filter may follow, each with the fields of
 * its target the caller may read; without it, no path may leave the record.
 */
export function validateFilter(
  source: string,
  columns: ReadonlyMap<string, string>,
  operators?: ReadonlyMap<string, readonly string[]>,
  relations?: ReadonlyMap<string, ReadonlySet<string>>,
): string | null {
  const problem = validateRule(source, [...columns.keys(), ...(relations?.keys() ?? [])]);
  if (problem) return problem;
  const parsed = parseRule(source);
  for (const { path } of identifiers(parsed)) {
    if (path[0].startsWith("@") || path.length === 1) continue;
    // A relation's own column can still be compared directly, as in `author = 7`, so this is only about paths through it.
    const target = relations?.get(path[0]);
    if (target) {
      if (!target.has(path[1])) return `"${path[0]}" has no field "${path[1]}" you can filter on.`;
      continue;
    }
    if (columns.get(path[0]) !== "json") return `"${path[0]}" has no nested values to filter on.`;
  }
  return operators?.size ? operatorProblem(parsed, operators) : null;
}

/** A field that declares its operators can be compared only with those. */
function operatorProblem(node: RuleNode, operators: ReadonlyMap<string, readonly string[]>): string | null {
  if (node.type !== "compare") return operatorProblem(node.left, operators) ?? operatorProblem(node.right, operators);
  for (const operand of [node.left, node.right]) {
    const allowed = operand.kind === "identifier" ? operators.get(operand.path[0]) : undefined;
    if (allowed && operand.kind === "identifier" && !allowed.includes(node.op)) return `"${operand.path[0]}" can't be filtered with ${node.op}.`;
  }
  return null;
}

/** Every @collection.<name>.<field> a rule reads. A rule that doesn't parse reads nothing, and is denied when evaluated. */
export function collectionReferences(source: string): Array<[collection: string, field: string]> {
  try {
    return [...identifiers(compiled(source))].filter(({ path }) => path[0] === "@collection" && path.length === 3).map(({ path }) => [path[1], path[2]]);
  } catch {
    return [];
  }
}

/** The record columns a rule reads, for fetching no more than it needs. */
export const ruleColumnNames = (node: RuleNode) => [...identifiers(node)].map(({ path }) => path[0]).filter((name) => !name.startsWith("@"));

/**
 * Save-time check. Unknown names are rejected so a typo cannot silently change access.
 * `nested` names the fields that can hold values under them, which are the JSON ones: with it,
 * any other path that leaves the record is refused, because a rule can't follow a relation.
 */
export function validateRule(source: string, recordFields: string[], collections?: RuleCatalog, customAuthFields: string[] = [], nested?: ReadonlySet<string>): string | null {
  try {
    const known = new Set([...SYSTEM_RECORD_FIELDS, ...recordFields]);
    const authFields = new Set([...AUTH_RULE_FIELDS, ...customAuthFields]);
    const check = (operand: Operand) => {
      if (operand.kind === "literal") return;
      const [root, section, name] = operand.path;
      if (root === "@collection") {
        if (!collections) throw new RuleSyntaxError("@collection lookups are not available here.");
        if (operand.path.length !== 3) throw new RuleSyntaxError("Use @collection.<collection>.<field>.");
        if (operand.modifier === "isset" || operand.modifier === "changed") throw new RuleSyntaxError(`:${operand.modifier} only applies to request data.`);
        const fields = collections.get(collectionSlug(section));
        if (!fields) throw new RuleSyntaxError(`Unknown collection "${section}".`);
        if (!fields.has(name) && !SYSTEM_RECORD_FIELDS.includes(name)) throw new RuleSyntaxError(`Unknown field @collection.${section}.${name}.`);
        return;
      }
      if (root === "@request") {
        if (!["auth", "body", "query", "headers", "method", "context", "locale", "scope"].includes(section ?? "")) {
          throw new RuleSyntaxError(`Unknown request property "${section ?? ""}".`);
        }
        if (section === "auth" && !authFields.has(name ?? "")) throw new RuleSyntaxError(`Unknown field @request.auth.${name ?? ""}.`);
        if (operand.modifier === "isset" && !["body", "query", "headers"].includes(section)) {
          throw new RuleSyntaxError(":isset only applies to @request.body, query or headers.");
        }
        if (operand.modifier === "changed" && section !== "body") throw new RuleSyntaxError(":changed only applies to @request.body.");
        return;
      }
      if (root.startsWith("@")) {
        if (!DATE_MACROS.includes(root) && !NUMBER_MACROS.includes(root)) throw new RuleSyntaxError(`Unknown macro ${root}.`);
        return;
      }
      if (operand.modifier === "isset" || operand.modifier === "changed") throw new RuleSyntaxError(`:${operand.modifier} only applies to request data.`);
      if (!known.has(root)) throw new RuleSyntaxError(`Unknown field "${root}".`);
      // A rule is compiled to SQL, or checked one record at a time, with no chance to read
      // another collection, so a path that leaves the record has no value to compare. Refused
      // here rather than at read time, where it would quietly deny every record.
      if (nested && operand.path.length > 1 && !nested.has(root)) {
        throw new RuleSyntaxError(`"${operand.path.join(".")}" follows a relation, which a rule can't do. Use @collection.<collection>.<field>, or compare "${root}" itself. A caller's filter can follow one.`);
      }
    };
    const visit = (node: RuleNode) => {
      if (node.type === "compare") { check(node.left); check(node.right); return; }
      visit(node.left);
      visit(node.right);
    };
    visit(parseRule(source));
    return null;
  } catch (error) {
    if (error instanceof RuleSyntaxError) return error.message;
    throw error;
  }
}
