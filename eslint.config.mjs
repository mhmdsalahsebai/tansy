import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";
const SEE = "See docs/contributing/security-model.md.";

// The auth model as lint rules, so that code which bypasses it does not merge.
const authModel = [
  {
    files: ["apps/starter/app/**/*.{ts,tsx}", "packages/cms/app/**/*.{ts,tsx}", "packages/cms/components/**/*.{ts,tsx}", "packages/cms/lib/client/**/*.{ts,tsx}", "packages/cms/lib/auth-client.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "@/lib/prisma", message: `Data access belongs in core/, behind the guard. ${SEE}` },
          { name: "@prisma/client", message: `Data access belongs in core/, behind the guard. ${SEE}` },
          { name: "kysely", message: `Data access belongs in core/, behind the guard. ${SEE}` },
          { name: "better-sqlite3", message: `Data access belongs in core/, behind the guard. ${SEE}` },
          { name: "better-auth", message: `Use getRuntime via core/authz. ${SEE}` },
          { name: "next/headers", importNames: ["cookies"], message: `Read identity through core/authz, not raw cookies. ${SEE}` },
        ],
        patterns: [
          { group: ["better-auth/adapters/*", "better-auth/plugins/*"], message: `Use core/auth. ${SEE}` },
          // Inside the package imports are relative, which the exact name above can't match.
          { group: ["**/lib/prisma", "**/lib/prisma/*", "**/generated/client-*"], message: `Data access belongs in core/, behind the guard. ${SEE}` },
        ],
      }],
      "react/no-danger": "error",
    },
  },
  {
    files: ["packages/cms/app/api/**/route.ts"],
    rules: {
      "no-restricted-syntax": ["error",
        { selector: `ExportNamedDeclaration > FunctionDeclaration[id.name=/^(${METHODS})$/]`, message: `API handlers must be exported as route(...). ${SEE}` },
        { selector: `ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name=/^(${METHODS})$/]:not([init.callee.name=/^(route|authEndpoint)$/])`, message: `API handlers must be exported as route(...). ${SEE}` },
        { selector: "ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.type='ObjectPattern']", message: `API handlers must be exported as route(...). ${SEE}` },
        { selector: "ExportNamedDeclaration[source]", message: `Re-exporting handlers hides their access policy. ${SEE}` },
        { selector: "ExportAllDeclaration", message: `Re-exporting handlers hides their access policy. ${SEE}` },
      ],
    },
  },
];

// Words in the dashboard come from the catalogs, so every interface language gets them.
// Flags text between tags, and literal strings shown as text or in the attributes a person
// reads or hears. Code samples in <code>, <kbd>, <pre> and <samp> are left as written. In
// attributes, an example such as "/blog/:slug", "fr" or "https://example.com" is not a
// word to translate: there, text counts when it has a space or starts with a capital.
const WORD = /\p{L}{2}/u;
const SPOKEN = new Set(["aria-label", "aria-description", "aria-roledescription", "aria-valuetext", "title", "placeholder", "alt", "label"]);
const VERBATIM = new Set(["code", "kbd", "pre", "samp", "style", "script"]);
const isText = (text, attribute) => WORD.test(text) && (!attribute || /\s/.test(text.trim()) || /^\p{Lu}/u.test(text.trim()));
const hasWords = (node, attribute = false) => {
  if (!node) return false;
  switch (node.type) {
    case "Literal": return typeof node.value === "string" && isText(node.value, attribute);
    case "TemplateLiteral": return isText(node.quasis.map((quasi) => quasi.value.cooked ?? "").join(""), attribute);
    case "ConditionalExpression": return hasWords(node.consequent, attribute) || hasWords(node.alternate, attribute);
    case "LogicalExpression": return hasWords(node.right, attribute) || (node.operator !== "&&" && hasWords(node.left, attribute));
    case "TSAsExpression": return hasWords(node.expression, attribute);
    default: return false;
  }
};
const verbatim = (node) => node?.type === "JSXElement" && node.openingElement.name.type === "JSXIdentifier" && VERBATIM.has(node.openingElement.name.name);
const MESSAGE = "Put this text in the admin catalogs (core/i18n/catalogs), a plugin's messages, or for site pages its render messages or the theme's, and show it with t(). See CONTRIBUTING.md.";
const i18n = {
  rules: {
    "no-literal-text": {
      meta: { type: "problem", schema: [] },
      create: (context) => ({
        JSXText(node) {
          if (WORD.test(node.value) && !verbatim(node.parent)) context.report({ node, message: MESSAGE });
        },
        JSXExpressionContainer(node) {
          const parent = node.parent;
          if ((parent.type === "JSXElement" || parent.type === "JSXFragment") && !verbatim(parent) && hasWords(node.expression)) context.report({ node, message: MESSAGE });
        },
        JSXAttribute(node) {
          const name = node.name.type === "JSXIdentifier" ? node.name.name : null;
          if (!name || !SPOKEN.has(name) || !node.value) return;
          const value = node.value.type === "JSXExpressionContainer" ? node.value.expression : node.value;
          if (hasWords(value, true)) context.report({ node, message: MESSAGE });
        },
      }),
    },
  },
};

const adminText = {
  // First-party plugins' and themes' files too, the site's pages included: dashboard words are in each
  // plugin's `messages`, and visitors' words in its render `messages` or the theme's, shown with the page's `words`.
  files: ["packages/cms/app/{dashboard,auth,account}/**/*.tsx", "packages/cms/components/**/*.tsx", "plugins/**/*.tsx", "themes/**/*.tsx"],
  plugins: { i18n },
  rules: { "i18n/no-literal-text": "error" },
};

// The dashboard's design pattern, see docs/contributing/design-system.md. Pages compose the kit's components
// (components/ui/kit.tsx, `tansy/admin` for plugins) instead of restating their classes, so a
// change to how a button, badge, header or tab looks reaches every page at once.
const PATTERN = [
  { test: /^cms-btn(-(primary|secondary|danger|ghost))?$/, use: "<Button> or <ButtonLink>", on: new Set(["a", "button", "Link"]) },
  { test: /^cms-badge(-[a-z]+)?$/, use: "<Badge tone=…>" },
  { test: /^cms-page-(header|title)$/, use: "<PageHeader>" },
  { test: /^cms-(alert|alert-(error|success|warning|info))$/, use: "<Alert kind=…>" },
  { test: /^cms-(tabs|tab|tab-active|pills|pill|pill-active)$/, use: "<Tabs>" },
  { test: /^cms-(card-header|card-title|panel-head|panel-title)$/, use: "<Card title=… actions=…>" },
  { test: /^cms-(grid-search|grid-search-icon|search|search-icon)$/, use: "<SearchInput>" },
];
const classWords = (node) => {
  if (!node) return [];
  switch (node.type) {
    case "Literal": return typeof node.value === "string" ? node.value.split(/\s+/) : [];
    case "TemplateLiteral": return node.quasis.flatMap((quasi) => (quasi.value.cooked ?? "").split(/\s+/)).concat(node.expressions.flatMap(classWords));
    case "ConditionalExpression": return [...classWords(node.consequent), ...classWords(node.alternate)];
    case "LogicalExpression": return classWords(node.right).concat(node.operator === "&&" ? [] : classWords(node.left));
    case "CallExpression": return node.arguments.flatMap(classWords);
    case "ObjectExpression": return node.properties.flatMap((property) => (property.type === "Property" ? classWords(property.value) : []));
    default: return [];
  }
};
const ui = {
  rules: {
    "use-kit": {
      meta: { type: "problem", schema: [] },
      create: (context) => ({
        JSXAttribute(node) {
          if (node.name.type !== "JSXIdentifier" || node.name.name !== "className" || !node.value) return;
          const element = node.parent.name.type === "JSXIdentifier" ? node.parent.name.name : "";
          const value = node.value.type === "JSXExpressionContainer" ? node.value.expression : node.value;
          const seen = new Set();
          for (const word of classWords(value)) {
            const rule = PATTERN.find((entry) => entry.test.test(word));
            if (!rule || seen.has(rule) || (rule.on && !rule.on.has(element))) continue;
            seen.add(rule);
            context.report({ node, message: `Use ${rule.use} from the UI kit instead of the "${word}" class. See docs/contributing/design-system.md.` });
          }
        },
        // Tone classes kept in a lookup, such as { draft: "cms-badge-warning" }, bypass the kit just the same.
        Property(node) {
          if (node.value.type !== "Literal" || typeof node.value.value !== "string") return;
          const word = node.value.value.split(/\s+/).find((part) => /^cms-badge(-[a-z]+)?$/.test(part));
          if (word) context.report({ node, message: `Map to a <Badge> tone instead of the "${word}" class. See docs/contributing/design-system.md.` });
        },
      }),
    },
  },
};

const designPattern = {
  files: ["packages/cms/app/{dashboard,auth,account}/**/*.tsx", "packages/cms/components/**/*.tsx", "plugins/**/*.tsx"],
  ignores: ["packages/cms/components/ui/kit.tsx"],
  plugins: { ui },
  rules: { "ui/use-kit": "error" },
};

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  { settings: { next: { rootDir: "apps/starter/" } } },
  ...authModel,
  adminText,
  designPattern,
  // Auth state changes need a full page load so no signed-in UI survives in memory.
  { rules: { "@next/next/no-location-assign-relative-destination": "off" } },
  globalIgnores(["**/.next/**", "apps/docs/**", ".release/**", "packages/cms/generated/**", "**/out/**", "**/build/**", "**/next-env.d.ts", ".codegraph/**"]),
]);
