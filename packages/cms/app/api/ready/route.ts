import { route } from "../../../core/authz/guard";
import { HttpError } from "../../../core/http/errors";
import { readiness } from "../../../core/ops/health";

/**
 * Readiness: whether this server can serve requests now. 200 when it can, 503 when it can't,
 * so a load balancer takes it out of rotation and puts it back on its own.
 *
 * The body is one boolean per check and never says why: what failed is in the server's log.
 */
export const GET = route(
  { access: "public", reason: "Readiness for a load balancer or orchestrator, which can't hold credentials. It answers with one boolean per check and no detail." },
  async () => {
    const result = await readiness();
    if (!result.ready) throw new HttpError(503, "NOT_READY", "The server can't serve requests yet.", result.checks);
    return result;
  },
);
