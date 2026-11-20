"use client";

import type { ReactNode } from "react";
import { useT } from "../i18n";
import { Card } from "../ui/kit";
import { useAuthConfig } from "./AuthConfig";

/**
 * The frame of every sign-in page: the site's mark, a card holding the title and the form, and
 * `footer` under it for the way to another auth page ("No account? Create one").
 */
export function AuthCard({ title, subtitle, footer, children }: { title: string; subtitle?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  const { appName, logoUrl } = useAuthConfig();
  return (
    <main className="cms-auth-page">
      <div className="cms-auth-panel">
        <div className="cms-auth-brand">
          {/* eslint-disable-next-line @next/next/no-img-element -- an administrator's path, whose size next/image can't know */}
          {logoUrl ? <img src={logoUrl} alt={appName} className="cms-auth-logo" /> : <span className="cms-auth-mark" aria-hidden="true">{appName.trim().charAt(0) || "C"}</span>}
        </div>
        <Card>
          <div className="cms-auth-head">
            <h1 className="cms-auth-title">{title}</h1>
            {subtitle && <p className="cms-auth-subtitle">{subtitle}</p>}
          </div>
          {children}
        </Card>
        {footer && <p className="cms-auth-footer">{footer}</p>}
      </div>
    </main>
  );
}

/** A rule with "or" on it, between the main way to sign in and the others. */
export function AuthDivider() {
  const { t } = useT();
  return <div className="cms-auth-divider" role="separator"><span>{t("auth.or")}</span></div>;
}
