// The integration suite's build. The theme, and anything NEXT_PUBLIC_, are baked into the build, so
// the build has to see the same environment the suite's server will: every variable the starter
// config reads, blank, whatever apps/starter/.env says. See tests/integration/server-env.ts.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { variables } = JSON.parse(readFileSync(path.join(here, "starter-env.json"), "utf8"));

const env = { ...process.env };
for (const name of variables) env[name] = "";
// The build needs no database, and reads none, but the starter's Prisma client wants a URL.
env.DATABASE_URL = process.env.DATABASE_URL ?? "file:./dev.db";
// Two themes, so the suite can prove a tenant serving its own: blank is the default and blog the
// other. Must match TANSY_THEMES in tests/integration/global-setup.ts, the server's own environment.
env.TANSY_THEMES = "blank,blog";

const build = spawnSync("npm", ["run", "build"], { cwd: path.join(here, "../.."), env, stdio: "inherit", shell: process.platform === "win32" });
process.exit(build.status ?? 1);
