import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STARTER_ENV_VARIABLES } from "../integration/server-env";

const CONFIG = path.join(__dirname, "../../apps/starter/tansy.config.ts");

/**
 * The integration suite starts the starter app, and Next loads `apps/starter/.env` into it, so the
 * suite blanks every variable that config reads (`tests/integration/server-env.ts`). A variable the
 * config starts reading that isn't on that list is a developer's `.env` deciding how the suite runs.
 */
describe("the starter config's environment", () => {
  const source = readFileSync(CONFIG, "utf8");
  const read = new Set<string>();
  for (const match of source.matchAll(/\benv\.([A-Z][A-Z_0-9]*)\b/g)) read.add(match[1]);
  for (const match of source.matchAll(/\benv\[\s*"([A-Z][A-Z_0-9]*)"\s*\]/g)) read.add(match[1]);
  // `showing("TANSY_PLUGIN_X")` reads its argument.
  for (const match of source.matchAll(/\bshowing\(\s*"([A-Z][A-Z_0-9]*)"\s*\)/g)) read.add(match[1]);

  it("is read through `env` or `showing`, so this test can see every variable", () => {
    // `const env = process.env` is the one place the config touches the environment directly.
    expect(source.match(/process\.env/g)).toEqual(["process.env"]);
    expect(read.size).toBeGreaterThan(50);
  });

  it("is blanked in full by the integration suite", () => {
    const blanked = new Set<string>(STARTER_ENV_VARIABLES);
    const missing = [...read].filter((name) => !blanked.has(name)).sort();
    expect(missing, "add these to STARTER_ENV_VARIABLES in tests/integration/server-env.ts").toEqual([]);
  });

  it("lists nothing the config has stopped reading", () => {
    const stale = STARTER_ENV_VARIABLES.filter((name) => !read.has(name)).sort();
    expect(stale, "remove these from STARTER_ENV_VARIABLES in tests/integration/server-env.ts").toEqual([]);
  });
});
