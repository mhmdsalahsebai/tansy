"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { AuthCaptcha, EnabledWidget } from "./useAuthWidgets";

/** The public sign-in configuration, as GET /api/auth-config returns it. */
export interface AuthConfig {
  appName: string;
  logoUrl: string;
  setupRequired: boolean;
  signUp: boolean;
  methods: { password: boolean; magicLink: boolean; emailOtp: boolean; passkey: boolean };
  password: { minLength: number; maxLength: number };
  oauth: string[];
  widgets: EnabledWidget[];
  /** Null when no CAPTCHA is set up. */
  captcha: AuthCaptcha | null;
}

const Context = createContext<AuthConfig | null>(null);

/** Rendered by the sign-in pages' server entry, so every form has the configuration on its first paint, with no request of its own. */
export function AuthConfigProvider({ value, children }: { value: AuthConfig; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAuthConfig(): AuthConfig {
  const config = useContext(Context);
  if (!config) throw new Error("useAuthConfig needs an AuthConfigProvider, which the sign-in pages' entry renders.");
  return config;
}
