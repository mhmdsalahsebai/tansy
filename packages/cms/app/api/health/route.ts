import { route } from "../../../core/authz/guard";
import { liveness } from "../../../core/ops/health";

/**
 * Liveness, for a load balancer, Docker or an orchestrator. It reads nothing, so a server
 * whose database is down still answers it and isn't restarted for a fault that isn't its own:
 * `/api/ready` is the one that says whether it can serve.
 *
 * It deliberately doesn't name the version. A stranger who knows the exact version knows which
 * of its flaws to try, and anyone entitled to it can read `/api/metrics` or run `tansy doctor`.
 */
export const GET = route(
  { access: "public", reason: "Liveness for a load balancer or orchestrator, which can't hold credentials. It reads nothing and says only that the server is up and for how long." },
  async () => liveness(),
);
