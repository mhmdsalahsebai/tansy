/**
 * Parser for PocketBase-compatible API rule expressions.
 * Rules become an AST and are never concatenated into queries, so Phase 2 can
 * add a SQL backend (parameters only) on top of this same tree.
 */
export type Operator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "~" | "!~" | "?=" | "?!=" | "?>" | "?>=" | "?<" | "?<=" | "?~" | "?!~";
export type Modifier = "isset" | "changed" | "length" | "each" | "lower";

export type Operand =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "identifier"; path: string[]; modifier?: Modifier };

export type RuleNode =
  | { type: "and" | "or"; left: RuleNode; right: RuleNode }
  | { type: "compare"; op: Operator; left: Operand; right: Operand };

export class RuleSyntaxError extends Error {}

type Token =
  | { t: "op"; v: Operator }
  | { t: "and" | "or" | "lparen" | "rparen" | "end" }
  | { t: "string"; v: string }
  | { t: "number"; v: number }
  | { t: "identifier"; v: string; modifier?: Modifier };

const MAX_LENGTH = 4096;
const MAX_DEPTH = 32;
const OPERATORS: Operator[] = ["?!=", "?!~", "?>=", "?<=", "?=", "?~", "?>", "?<", "!=", "!~", ">=", "<=", "=", "~", ">", "<"];
const MODIFIERS = new Set<string>(["isset", "changed", "length", "each", "lower"]);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (source.startsWith("//", i)) { while (i < source.length && source[i] !== "\n") i++; continue; }
    if (source.startsWith("&&", i)) { tokens.push({ t: "and" }); i += 2; continue; }
    if (source.startsWith("||", i)) { tokens.push({ t: "or" }); i += 2; continue; }
    if (c === "(") { tokens.push({ t: "lparen" }); i++; continue; }
    if (c === ")") { tokens.push({ t: "rparen" }); i++; continue; }
    if (c === '"' || c === "'") {
      let value = "";
      let j = i + 1;
      for (; j < source.length && source[j] !== c; j++) {
        if (source[j] === "\\" && j + 1 < source.length) j++;
        value += source[j];
      }
      if (j >= source.length) throw new RuleSyntaxError("Unterminated string.");
      tokens.push({ t: "string", v: value });
      i = j + 1;
      continue;
    }
    const operator = OPERATORS.find((op) => source.startsWith(op, i));
    if (operator) { tokens.push({ t: "op", v: operator }); i += operator.length; continue; }
    const number = /^-?\d+(\.\d+)?/.exec(source.slice(i));
    if (number) { tokens.push({ t: "number", v: Number(number[0]) }); i += number[0].length; continue; }
    // A segment may hold hyphens, because a collection slug can, as in "blog-posts_via_author".
    // A number is lexed above, so a leading "-" is never part of a name, and nothing here is
    // arithmetic. A name that matches no field or relation is still refused by its own check.
    const identifier = /^@?[A-Za-z_]\w*(?:-\w+)*(\.[A-Za-z_]\w*(?:-\w+)*)*/.exec(source.slice(i));
    if (identifier) {
      i += identifier[0].length;
      let modifier: Modifier | undefined;
      const mod = /^:([a-z]+)/.exec(source.slice(i));
      if (mod) {
        if (!MODIFIERS.has(mod[1])) throw new RuleSyntaxError(`Unknown modifier ":${mod[1]}".`);
        modifier = mod[1] as Modifier;
        i += mod[0].length;
      }
      tokens.push({ t: "identifier", v: identifier[0], modifier });
      continue;
    }
    throw new RuleSyntaxError(`Unexpected character "${c}" at position ${i}.`);
  }
  tokens.push({ t: "end" });
  return tokens;
}

export function parseRule(source: string): RuleNode {
  if (source.length > MAX_LENGTH) throw new RuleSyntaxError(`Rule is longer than ${MAX_LENGTH} characters.`);
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position];
  const next = () => tokens[position++];

  const operand = (): Operand => {
    const token = next();
    if (token.t === "string" || token.t === "number") return { kind: "literal", value: token.v };
    if (token.t === "identifier") {
      if (!token.modifier && ["true", "false", "null"].includes(token.v)) {
        return { kind: "literal", value: token.v === "null" ? null : token.v === "true" };
      }
      return { kind: "identifier", path: token.v.split("."), modifier: token.modifier };
    }
    throw new RuleSyntaxError("Expected a field or a value.");
  };

  const primary = (depth: number): RuleNode => {
    if (depth > MAX_DEPTH) throw new RuleSyntaxError("Rule is nested too deeply.");
    if (peek().t === "lparen") {
      next();
      const inner = orExpr(depth + 1);
      if (next().t !== "rparen") throw new RuleSyntaxError('Expected ")".');
      return inner;
    }
    const left = operand();
    const op = next();
    if (op.t !== "op") throw new RuleSyntaxError("Expected a comparison operator.");
    return { type: "compare", op: op.v, left, right: operand() };
  };

  const andExpr = (depth: number): RuleNode => {
    let left = primary(depth);
    while (peek().t === "and") { next(); left = { type: "and", left, right: primary(depth) }; }
    return left;
  };

  const orExpr = (depth: number): RuleNode => {
    let left = andExpr(depth);
    while (peek().t === "or") { next(); left = { type: "or", left, right: andExpr(depth) }; }
    return left;
  };

  const ast = orExpr(0);
  if (peek().t !== "end") throw new RuleSyntaxError("Unexpected content after the end of the rule.");
  return ast;
}
