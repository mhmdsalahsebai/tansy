import { headers } from "next/headers";
import { z } from "zod";
import { route } from "../../../core/authz/guard";
import { assertPasswordAcceptable, assertRoleAssignable } from "../../../core/auth/users";

const query = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(30),
  search: z.string().trim().max(200).optional(),
});

export const GET = route({ access: "permission", permission: "user:list", query }, async ({ query, runtime }) => {
  const result = await runtime.auth.api.listUsers({
    headers: await headers(),
    query: {
      limit: query.perPage,
      offset: (query.page - 1) * query.perPage,
      sortBy: "createdAt",
      sortDirection: "desc",
      ...(query.search ? { searchValue: query.search, searchField: "email" as const, searchOperator: "contains" as const } : {}),
    },
  });
  return { page: query.page, perPage: query.perPage, totalItems: result.total, items: result.users };
});

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email(),
  password: z.string().min(1).max(256),
  role: z.string().min(1),
});

export const POST = route(
  { access: "permission", permission: "user:create", body: createBody, audit: "user.create" },
  async ({ body, principal, runtime, auditTarget }) => {
    if (principal.kind !== "user") return null;
    assertRoleAssignable(principal, body.role, runtime);
    await assertPasswordAcceptable(body.password, runtime);
    const { user } = await runtime.auth.api.createUser({
      headers: await headers(),
      body: { ...body, role: body.role as "user", data: { emailVerified: true } },
    });
    auditTarget("user", user.id, { role: body.role });
    return user;
  },
);
