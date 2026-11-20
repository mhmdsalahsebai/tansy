import "server-only";

/**
 * Accounts whose sign-in details are handed out, such as a public demo's. Anyone may sign in
 * as one and do what its role allows, but nobody signed in as it can change the account
 * itself, or one visitor could lock out the rest. A superadmin still manages it from Users.
 *
 *   TANSY_SHARED_ACCOUNTS=demo@example.com,reviewer@example.com
 */
export function sharedAccounts(): Set<string> {
  return new Set((process.env.TANSY_SHARED_ACCOUNTS ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
}

export const isSharedAccount = (email: string | null | undefined) => !!email && sharedAccounts().has(email.toLowerCase());

/**
 * better-auth paths that change the signed-in account, its sign-in methods or its sessions.
 * Signing out stays allowed: it ends only the visitor's own session.
 */
export const ACCOUNT_CHANGING_PATHS = new Set([
  "/change-password",
  "/set-password",
  "/change-email",
  "/update-user",
  "/delete-user",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/delete-passkey",
  "/passkey/update-passkey",
  "/link-social",
  "/unlink-account",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
]);

/** Asked for by email, with nobody signed in, so the body names the account. */
export const ACCOUNT_RECOVERY_PATHS = new Set(["/request-password-reset", "/forget-password", "/email-otp/send-verification-otp", "/sign-in/magic-link"]);

export const SHARED_ACCOUNT_MESSAGE = "This account is shared, so its sign-in details and settings can't be changed.";
