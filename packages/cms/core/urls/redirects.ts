import "server-only";
import { LOCK, serializeWrites } from "../content/locks";
import { invalidateSiteCache } from "../site/cache";
import { HttpError, notFound } from "../http/errors";
import prisma from "../../lib/prisma";
import { currentScopeValue } from "../scope/context";
import { normalizePath, redirectTarget, targetPath } from "./path";
import { insideCms } from "./pattern";

export interface RedirectInput {
  from: string;
  to: string;
  status: number;
}

const invalid = (path: string, message: string) => new HttpError(400, "VALIDATION_FAILED", "Request validation failed.", [{ path, message }]);

function checkedInput({ from, to, status }: RedirectInput) {
  const source = normalizePath(from);
  if (source === null) throw invalid("from", 'Use a path on this site, such as "/old-page".');
  if (insideCms(source)) throw invalid("from", "This address belongs to the CMS itself.");
  const target = redirectTarget(to);
  if (target === null) throw invalid("to", 'Use a path on this site, such as "/new-page".');
  return { from: source, to: target, status };
}

const isConflict = (error: unknown) => (error as { code?: string }).code === "P2002";

/**
 * Redirects belong to the scope value the work is for, such as one tenant's site, or to none
 * ("") on an instance without one. Every query here names it, so a tenant's redirects never
 * reach another's site, and loops are checked within one value.
 */
const scopeOf = () => currentScopeValue() ?? "";

/**
 * One redirect at a time, so two saves can't form a loop between them. A target
 * that itself redirects is followed to its end, and redirects that pointed here
 * move along too, so a visitor only ever makes one hop.
 */
async function save(id: number | null, input: RedirectInput | ((current: RedirectInput) => RedirectInput), createdById: string | null) {
  try {
    const result = await prisma.$transaction(async (tx) => {
      await serializeWrites(tx, LOCK.redirects);
      const scope = scopeOf();
      const existing = id === null ? null : await tx.redirect.findFirst({ where: { id, scope } });
      if (id !== null && !existing) throw notFound("Redirect");
      const wanted = checkedInput(typeof input === "function" ? input(existing!) : input);

      let target = wanted.to;
      const seen = new Set([wanted.from]);
      for (;;) {
        const path = targetPath(target);
        if (seen.has(path)) throw invalid("to", "This would create a redirect loop.");
        seen.add(path);
        const next = await tx.redirect.findFirst({ where: { scope, from: path, ...(id === null ? {} : { id: { not: id } }) } });
        if (!next) break;
        target = next.to;
      }

      const data = { ...wanted, to: target };
      const saved = id === null ? await tx.redirect.create({ data: { ...data, scope, createdById } }) : await tx.redirect.update({ where: { id }, data });
      await tx.redirect.updateMany({ where: { scope, to: wanted.from, id: { not: saved.id } }, data: { to: target } });
      return saved;
    });
    invalidateSiteCache();
    return result;
  } catch (error) {
    if (isConflict(error)) throw new HttpError(409, "CONFLICT", "A redirect from that address already exists.", [{ path: "from", message: "A redirect from that address already exists." }]);
    throw error;
  }
}

export const createRedirect = (input: RedirectInput, createdById: string | null) => save(null, input, createdById);

export const updateRedirect = (id: number, changes: Partial<RedirectInput>) => save(id, (current) => ({ from: current.from, to: current.to, status: current.status, ...changes }), null);

export async function deleteRedirect(id: number) {
  const { count } = await prisma.redirect.deleteMany({ where: { id, scope: scopeOf() } });
  if (!count) throw notFound("Redirect");
  invalidateSiteCache();
}

export async function listRedirects({ page, perPage, search }: { page: number; perPage: number; search?: string }) {
  const scope = scopeOf();
  const where = search ? { scope, OR: [{ from: { contains: search } }, { to: { contains: search } }] } : { scope };
  const [totalItems, items] = await Promise.all([
    prisma.redirect.count({ where }),
    prisma.redirect.findMany({ where, orderBy: { id: "desc" }, skip: (page - 1) * perPage, take: perPage }),
  ]);
  return { page, perPage, totalItems, items };
}

export const findRedirect = (from: string) => prisma.redirect.findUnique({ where: { scope_from: { scope: scopeOf(), from } }, select: { to: true, status: true } });
