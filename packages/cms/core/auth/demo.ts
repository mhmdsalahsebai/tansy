import "server-only";

export interface DemoLogin {
  email: string;
  password: string;
}

/**
 * A public demo's login, which makes this instance a demo: the site shows a banner pointing to the
 * dashboard, and the sign-in form starts filled in with these details, so trying the dashboard
 * takes one press. The password is handed to every visitor, so the account is always treated
 * as shared (see shared-accounts.ts) and should hold a role with only what the demo means to
 * hand out. Null unless both are set.
 *
 *   TANSY_DEMO_EMAIL=demo@example.com
 *   TANSY_DEMO_PASSWORD=explore-the-demo
 */
export function demoLogin(): DemoLogin | null {
  const email = process.env.TANSY_DEMO_EMAIL?.trim().toLowerCase();
  const password = process.env.TANSY_DEMO_PASSWORD;
  return email && password ? { email, password } : null;
}
