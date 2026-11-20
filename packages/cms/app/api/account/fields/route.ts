import { z } from "zod";
import { setOwnValues, userFieldValues } from "../../../../core/auth/user-fields";
import { route } from "../../../../core/authz/guard";
import { isSharedAccount, SHARED_ACCOUNT_MESSAGE } from "../../../../core/auth/shared-accounts";
import { HttpError } from "../../../../core/http/errors";

const body = z.object({ values: z.record(z.string(), z.unknown()) });

export const PATCH = route(
  { access: "authenticated", body, audit: "account.update_fields", maxBodyBytes: 64 * 1024 },
  async ({ body, principal, auditTarget }) => {
    if (isSharedAccount(principal.user.email)) throw new HttpError(403, "SHARED_ACCOUNT", SHARED_ACCOUNT_MESSAGE);
    auditTarget("user", principal.user.id, { fields: Object.keys(body.values).slice(0, 100) });
    await setOwnValues(principal.user.id, body.values);
    return userFieldValues(principal.user.id, { includeHidden: false });
  },
);
