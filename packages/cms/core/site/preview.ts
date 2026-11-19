import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getRuntime } from "../auth/instance";
import { holdsRecordPermission, holdsRecordPermissionForSome } from "../authz/permissions";
import { ANONYMOUS, principalForUser, type Principal } from "../authz/principal";
import { loadRuleLookups, ownsRecord, type RuleRequest } from "../authz/records";
import { getCmsConfig } from "../config";
import { requireCollection, type CollectionWithFields } from "../content/access";
import { findDraftValues, findRow } from "../content/revisions";
import { viewRecord } from "../content/public-records";
import { flattenRecord } from "../content/records";
import { apiPath } from "../../lib/paths";
import type { SiteRecord } from "../theme/define";
import { buildRecordPath } from "../urls/pattern";
import type { PreviewedRecord } from "./page";

export const PREVIEW_TTL_SECONDS = 15 * 60;
export const PREVIEW_COOKIE = "cms-preview";

interface Claims { c: number; r: number; u: string; e: number }

function sign(payload: string) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET must be set");
  return createHmac("sha256", secret).update(`tansy.preview-token.v1:${payload}`).digest();
}

/** Lets its holder see one record's unpublished state, for a short while, on the authority of whoever made it. */
export function createPreviewToken(collectionId: number, recordId: number, userId: string, now = Date.now()) {
  const expires = Math.floor(now / 1000) + PREVIEW_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ c: collectionId, r: recordId, u: userId, e: expires } satisfies Claims)).toString("base64url");
  return { token: `${payload}.${sign(payload).toString("base64url")}`, expiresAt: new Date(expires * 1000).toISOString() };
}

export function verifyPreviewToken(token: string | undefined | null, now = Date.now()): Claims | null {
  const match = token ? /^([\w-]{1,400})\.([\w-]{43})$/.exec(token) : null;
  if (!match) return null;
  const given = Buffer.from(match[2], "base64url");
  const expected = sign(match[1]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const claims = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as Claims;
  return claims.e * 1000 > now ? claims : null;
}

/** The address to open for a new token: a headless site's preview route if one is configured, or this app's. */
export function previewEntryUrl(token: string) {
  const site = getCmsConfig().previewUrl;
  const query = `?token=${encodeURIComponent(token)}`;
  return site ? `${site}${query}` : apiPath(`/preview/enter${query}`);
}

const NO_REQUEST = (lookups: RuleRequest["lookups"]): RuleRequest => ({ method: "GET", headers: new Headers(), query: {}, body: {}, lookups });

export type PreviewCheck = (issuer: Principal, collection: CollectionWithFields, record: Record<string, unknown>, request: RuleRequest) => boolean;

/**
 * A record as it would look published: its pending draft over the live row, with what
 * a visitor couldn't read left out. The person who made the token has to be able to read
 * it now, so a token stops working as soon as they lose access. Never cached.
 */
export async function loadPreview(token: string | undefined | null, canView: PreviewCheck): Promise<PreviewedRecord | null> {
  const claims = verifyPreviewToken(token);
  if (!claims) return null;
  const issuer = await principalForUser(claims.u, await getRuntime(), `preview:${claims.r}`);
  if (!issuer || !holdsRecordPermissionForSome(issuer.permissions, "record:read", claims.c)) return null;

  const collection = await requireCollection(claims.c).catch(() => null);
  if (!collection) return null;
  const live = await findRow(collection, claims.r);
  if (!live) return null;
  // An own grant covers only a record the issuer created.
  if (!holdsRecordPermission(issuer.permissions, "record:read", claims.c) && !ownsRecord(issuer, flattenRecord(live))) return null;

  const request = NO_REQUEST(await loadRuleLookups([collection]));
  if (!canView(issuer, collection, flattenRecord(live), request)) return null;

  const row = { ...live, ...(await findDraftValues(collection, claims.r)) };
  return {
    collection: collection.slug,
    path: collection.urlPattern ? buildRecordPath(collection.urlPattern, row) : null,
    record: await viewRecord(collection, row, {}, ANONYMOUS, request) as SiteRecord,
  };
}

const cookieAttributes = (maxAge: number) => `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.BETTER_AUTH_URL?.startsWith("https://") ? "; Secure" : ""}`;

export const previewCookie = (token: string) => `${PREVIEW_COOKIE}=${token}; ${cookieAttributes(PREVIEW_TTL_SECONDS)}`;
export const clearPreviewCookie = () => `${PREVIEW_COOKIE}=; ${cookieAttributes(0)}`;

export async function previewTokenFromCookie() {
  return (await cookies()).get(PREVIEW_COOKIE)?.value ?? null;
}
