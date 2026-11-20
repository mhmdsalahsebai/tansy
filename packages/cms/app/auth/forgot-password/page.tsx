"use client";

import { useT } from "../../../components/i18n";
import Link from "next/link";
import { useState } from "react";
import { AuthCard } from "../../../components/auth/AuthCard";
import { useAuthWidgets } from "../../../components/auth/useAuthWidgets";
import { Alert, Button, Field, Input } from "../../../components/ui/kit";
import { authClient } from "../../../lib/auth-client";
import { useAuthConfig } from "../../../components/auth/AuthConfig";
import { useAction } from "../../../lib/client/api";
import { authPath } from "../../../lib/paths";

export default function ForgotPasswordPage() {
  const { t } = useT();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const { busy, run } = useAction();
  const config = useAuthConfig();
  const widgets = useAuthWidgets(config.widgets, "forgot-password", config.captcha);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Same message whatever the outcome, so this can't confirm an account exists.
    await run(() => authClient.requestPasswordReset({ email, redirectTo: authPath("reset-password"), fetchOptions: { headers: widgets.headers } }));
    setSent(true);
  };
  return (
    <AuthCard title={t("auth.resetTitle")} footer={<Link className="cms-link" href={authPath("signin")}>{t("auth.backToSignIn")}</Link>}>
      {sent ? (
        <Alert kind="success">{t("auth.resetSent")}</Alert>
      ) : (
        <form onSubmit={submit} className="cms-stack-4">
          <Field label={t("auth.email")}><Input required autoFocus type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          {widgets.slot}
          <Button type="submit" loading={busy} className="cms-w-full">{t("auth.sendResetLink")}</Button>
        </form>
      )}
    </AuthCard>
  );
}
