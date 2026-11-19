import { createHmac, timingSafeEqual } from "node:crypto";

export const FILE_TOKEN_TTL_SECONDS = 120;

function signature(fileId: string, expires: number) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET must be set");
  return createHmac("sha256", secret).update(`tansy.file-token.v1:${fileId}:${expires}`).digest();
}

/** A short-lived proof, for one file, that its holder passed the access check. */
export function createFileToken(fileId: string, now = Date.now()) {
  const expires = Math.floor(now / 1000) + FILE_TOKEN_TTL_SECONDS;
  return { token: `${expires}.${signature(fileId, expires).toString("base64url")}`, expiresAt: new Date(expires * 1000).toISOString() };
}

export function verifyFileToken(fileId: string, token: string | undefined, now = Date.now()) {
  const match = token ? /^(\d{1,12})\.([\w-]{43})$/.exec(token) : null;
  if (!match) return false;
  const expires = Number(match[1]);
  if (expires * 1000 <= now) return false;
  const given = Buffer.from(match[2], "base64url");
  const expected = signature(fileId, expires);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
