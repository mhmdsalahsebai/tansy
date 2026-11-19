import { z } from "zod";
import { audit } from "../../../core/audit";
import { route } from "../../../core/authz/guard";
import { completeSetup } from "../../../core/auth/setup";

const body = z.object({ token: z.string().min(1).max(200), name: z.string().trim().min(1).max(120), email: z.email(), password: z.string().min(1).max(256) });

export const POST = route(
  { access: "public", reason: "First-run superadmin creation; authorized by the one-time token from the server log", body, rateLimit: { window: 60, max: 10 } },
  async ({ body }) => {
    const user = await completeSetup(body);
    await audit({ action: "auth.setup_completed", outcome: "success", actorId: user.id, actorEmail: user.email, actorKind: "system" });
    return { ok: true };
  },
);
