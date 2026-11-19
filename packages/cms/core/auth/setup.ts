import "server-only";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { HttpError } from "../http/errors";
import { SUPERADMIN } from "../authz/roles";
import { baseUrl } from "../http/request";
import { hashPassword } from "../../lib/argon2";
import prisma from "../../lib/prisma";
import { getRuntime } from "./instance";
import { assertPasswordAcceptable } from "./users";
import { authPath } from "../../lib/paths";

const KEY = "setup.token";
const TTL_MS = 60 * 60 * 1000;
const hash = (token: string) => createHash("sha256").update(token).digest();

export async function setupRequired(): Promise<boolean> {
  return (await prisma.user.count({ where: { role: { contains: SUPERADMIN } } })) === 0;
}

/**
 * PocketBase's first-run flow: only someone who can read the server log can
 * claim the instance, so a freshly deployed server cannot be taken over.
 */
export async function announceSetup(): Promise<void> {
  if (!(await setupRequired())) {
    await prisma.appSetting.deleteMany({ where: { key: KEY } });
    return;
  }
  const token = randomBytes(32).toString("base64url");
  const value = { hash: hash(token).toString("hex"), expiresAt: Date.now() + TTL_MS };
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  console.info(`\n[setup] No superadmin exists. Open this link within 1 hour to create one:\n[setup] ${baseUrl()}${authPath("setup")}?token=${token}\n`);
}

export async function completeSetup(input: { token: string; name: string; email: string; password: string }) {
  const invalid = () => new HttpError(403, "INVALID_SETUP_TOKEN", "This setup link is invalid or has expired. Restart the server for a new one.");
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
  const stored = row?.value as { hash?: string; expiresAt?: number } | undefined;
  if (!stored?.hash || !stored.expiresAt || stored.expiresAt < Date.now()) throw invalid();
  if (!timingSafeEqual(Buffer.from(stored.hash, "hex"), hash(input.token))) throw invalid();
  if (!(await setupRequired())) throw invalid();

  const runtime = await getRuntime();
  await assertPasswordAcceptable(input.password, runtime);

  // Deleting first makes the token single-use even under concurrent requests.
  if ((await prisma.appSetting.deleteMany({ where: { key: KEY, version: row!.version } })).count !== 1) throw invalid();

  const id = randomUUID();
  const password = await hashPassword(input.password);
  // One insert, so a failure can never leave a superadmin without a password.
  const user = await prisma.user.create({
    data: {
      id,
      email: input.email.toLowerCase(),
      name: input.name,
      emailVerified: true,
      role: SUPERADMIN,
      accounts: { create: { id: randomUUID(), providerId: "credential", accountId: id, password } },
    },
  });
  return user;
}
