import { route } from "../../../core/authz/guard";
import { publicAuthConfig } from "../../../core/auth/public-config";

// PocketBase's listAuthMethods: lets sign-in screens show only what is enabled.
export const GET = route({ access: "public", reason: "Sign-in screens need the enabled methods before authentication" }, async ({ runtime: { settings } }) => publicAuthConfig(settings));
