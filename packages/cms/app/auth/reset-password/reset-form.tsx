"use client";

import { useT } from "../../../components/i18n";
import Link from "next/link";
import { useState } from "react";
import { AuthCard } from "../../../components/auth/AuthCard";
import { Alert, Button, Field, Input } from "../../../components/ui/kit";
import { authClient } from "../../../lib/auth-client";
import { unwrap, useAction } from "../../../lib/client/api";
import { authPath } from "../../../lib/paths";

export default function ResetForm({ token }: { token: string }) {
  const { t } = useT();
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await run(() => unwrap(authClient.resetPassword({ newPassword: password, token })))) setDone(true);
  };
  return (
    <AuthCard title={t("auth.newPasswordTitle")}>
      {!token && <Alert>{t("auth.resetInvalid")}</Alert>}
      {error && <Alert>{error}</Alert>}
      {done ? (
        <Alert kind="success">{t("auth.passwordChanged")} <Link className="cms-underline" href={authPath("signin")}>{t("auth.signIn")}</Link></Alert>
      ) : (
        <form onSubmit={submit} className="cms-stack-4">
          <Field label={t("auth.newPassword")}><Input required type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Button type="submit" loading={busy} disabled={!token} className="cms-w-full">{t("auth.changePassword")}</Button>
        </form>
      )}
    </AuthCard>
  );
}
