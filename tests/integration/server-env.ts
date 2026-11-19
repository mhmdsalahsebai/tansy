import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The suite builds and starts the starter app, and Next loads `apps/starter/.env` into both. A
 * developer's own `.env` would then decide which plugins, theme, examples, storage adapter and
 * search engine the suite runs with: a `TANSY_THEME` set there pulls a theme's collections into every
 * test, and `TANSY_PWNED_PASSWORDS` sends password checks to an outside service.
 *
 * Next leaves a variable alone when the process already has it, including when it is empty, and the
 * starter config reads an empty value as unset, so blanking every variable that config reads makes
 * the build and the server deaf to `.env`. Each caller then sets what it wants on top:
 *
 *     const env = { ...process.env, ...blankStarterEnv(), TANSY_PLUGIN_BLOG: "true", ... };
 *
 * The theme and anything `NEXT_PUBLIC_` are baked into the build, so the build must see the same
 * values as the server: `tests/integration/build.mjs` is the suite's build, and
 * `tests/unit/server-env.test.ts` fails if `apps/starter/tansy.config.ts` starts reading a variable
 * the list doesn't name.
 */

/** Every variable `apps/starter/tansy.config.ts` reads, shared with `build.mjs` as JSON. */
export const STARTER_ENV_VARIABLES: readonly string[] = (
  JSON.parse(readFileSync(path.join(__dirname, "starter-env.json"), "utf8")) as { variables: string[] }
).variables;

/**
 * Every starter-config variable as an empty value, which that config reads as unset: `showing()`
 * wants the word "true", a theme wants its own name, a number becomes `undefined` and an adapter's
 * bucket or host is falsy. Spread it before the values a server actually needs.
 */
export function blankStarterEnv(): Record<string, string> {
  return Object.fromEntries(STARTER_ENV_VARIABLES.map((name) => [name, ""]));
}
