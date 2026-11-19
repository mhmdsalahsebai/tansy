import { z } from "zod";

/**
 * Every authentication behaviour controllable from the dashboard. Defaults are
 * the secure choice: OWASP Authentication, Session and MFA cheat sheets, with
 * sign-up closed until an administrator opens it.
 *
 * This file has no server imports so the settings form can share it.
 */
/** Sent to and accepted from the dashboard in place of a stored secret. */
export const SECRET_MASK = "********";

const seconds = (min: number, max: number, fallback: number) => z.number().int().min(min).max(max).default(fallback);
const DAY = 86_400;

const oauthProvider = z.object({
  enabled: z.boolean().default(false),
  clientId: z.string().trim().max(512).default(""),
  clientSecret: z.string().max(2048).default(""),
});

/** A logo: a path on this site, as the Content Security Policy only allows images from here. Empty for none. */
export const logoPath = () => z.string().trim().max(500).regex(/^(\/(?![/\\])\S*)?$/, "Use a path on this site, such as /logo.svg.");
/** An accent colour as six-digit hex, or empty for none. Only this reaches the stylesheet. */
export const accentColour = () => z.string().trim().regex(/^(#[0-9a-fA-F]{6})?$/, "Use a colour such as #4f46e5.");

export const authSettingsSchema = z.object({
  general: z
    .object({
      appName: z.string().trim().min(1).max(80).default("Tansy"),
      logoUrl: logoPath().default(""),
      accentColor: accentColour().default(""),
    })
    .prefault({}),
  signUp: z
    .object({
      enabled: z.boolean().default(false),
      defaultRole: z.string().min(1).default("user"),
      allowedDomains: z.array(z.string().trim().toLowerCase().min(1)).max(200).default([]),
      blockedDomains: z.array(z.string().trim().toLowerCase().min(1)).max(200).default([]),
    })
    .prefault({}),
  methods: z
    .object({
      password: z.boolean().default(true),
      magicLink: z.boolean().default(false),
      emailOtp: z.boolean().default(false),
      passkey: z.boolean().default(true),
      bearer: z.boolean().default(false),
    })
    .prefault({}),
  emailVerification: z
    .object({ required: z.boolean().default(false), tokenTtl: seconds(600, 3 * DAY, DAY) })
    .prefault({}),
  password: z
    .object({
      minLength: z.number().int().min(8).max(128).default(15),
      maxLength: z.number().int().min(64).max(256).default(128),
      resetTokenTtl: seconds(300, 7200, 1800),
      revokeSessionsOnReset: z.boolean().default(true),
    })
    .prefault({}),
  lockout: z
    .object({
      enabled: z.boolean().default(true),
      maxFailures: z.number().int().min(3).max(50).default(5),
      baseDelaySeconds: seconds(1, 3600, 30),
      maxDelaySeconds: seconds(60, DAY, 3600),
    })
    .prefault({}),
  session: z
    .object({
      idleTimeout: seconds(300, 30 * DAY, DAY),
      refreshAfter: seconds(60, DAY, 3600),
      absoluteTimeout: seconds(3600, 90 * DAY, 7 * DAY),
      freshFor: seconds(60, DAY, 900),
      impersonationDuration: seconds(300, DAY, 3600),
    })
    .prefault({}),
  mfa: z
    .object({
      totp: z.boolean().default(true),
      emailOtp: z.boolean().default(false),
      requireForDashboard: z.boolean().default(false),
    })
    .prefault({}),
  oauth: z
    .object({
      allowAccountLinking: z.boolean().default(false),
      // Keyed by provider id. Which ids exist is decided by extensions in tansy.config.ts.
      providers: z
        .record(z.string().regex(/^[a-z0-9-]{1,40}$/), oauthProvider)
        .refine((providers) => Object.keys(providers).length <= 50, "Too many providers.")
        .default({}),
    })
    .prefault({}),
  rateLimit: z
    .object({
      enabled: z.boolean().default(true),
      window: seconds(1, 3600, 60),
      max: z.number().int().min(1).max(100_000).default(300),
      authWindow: seconds(1, 3600, 60),
      authMax: z.number().int().min(1).max(1000).default(10),
      apiWriteWindow: seconds(1, 3600, 60),
      apiWriteMax: z.number().int().min(1).max(100_000).default(120),
      apiReadWindow: seconds(1, 3600, 60),
      apiReadMax: z.number().int().min(1).max(1_000_000).default(1200),
    })
    .prefault({}),
  batch: z
    .object({ enabled: z.boolean().default(false), maxRequests: z.number().int().min(1).max(1000).default(50) })
    .prefault({}),
  network: z
    .object({
      ipHeaders: z.array(z.string().trim().toLowerCase().min(1)).max(10).default(["x-forwarded-for"]),
      trustedProxies: z.array(z.string().trim().min(1)).max(50).default([]),
      trustedOrigins: z.array(z.string().trim().min(1)).max(50).default([]),
    })
    .prefault({}),
  apiKeys: z
    .object({ enabled: z.boolean().default(true), maxLifetimeDays: z.number().int().min(1).max(3650).default(365) })
    .prefault({}),
  mail: z
    .object({
      host: z.string().trim().max(255).default(""),
      port: z.number().int().min(1).max(65535).default(587),
      secure: z.boolean().default(false),
      requireStartTls: z.boolean().default(true),
      username: z.string().max(255).default(""),
      password: z.string().max(1024).default(""),
      fromAddress: z.string().trim().max(255).default(""),
      fromName: z.string().trim().max(120).default("Tansy"),
      securityAlerts: z.boolean().default(true),
    })
    .prefault({}),
  audit: z.object({ retentionDays: z.number().int().min(7).max(3650).default(365) }).prefault({}),
  files: z.object({ unattachedRetentionDays: z.number().int().min(1).max(365).default(7) }).prefault({}),
  /** Deleted records are kept this long, so a delete can be undone (core/content/trash.ts). Off deletes them for good. */
  trash: z.object({ enabled: z.boolean().default(true), retentionDays: z.number().int().min(1).max(365).default(30) }).prefault({}),
});

export type AuthSettings = z.output<typeof authSettingsSchema>;
