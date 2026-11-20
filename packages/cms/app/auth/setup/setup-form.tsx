"use client";

import { useT } from "../../../components/i18n";
import { useState } from "react";
import { AuthCard } from "../../../components/auth/AuthCard";
import { Alert, Button, Field, Input } from "../../../components/ui/kit";
import { useAuthConfig } from "../../../components/auth/AuthConfig";
import { api, useAction } from "../../../lib/client/api";
import { apiPath, authPath } from "../../../lib/paths";

export default function SetupForm({ token }: { token: string }) {
  const { t } = useT();
  const config = useAuthConfig();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const { busy, error, run } = useAction();
  const [leaving, setLeaving] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await run(() => api(apiPath("/setup"), { method: "POST", body: { ...form, token } }))) {
      setLeaving(true);
      window.location.href = authPath("signin");
    }
  };
  if (!config.setupRequired) {
    return <AuthCard title={t("auth.setupComplete")}><Alert kind="info">{t("auth.hasSuperadmin")}</Alert></AuthCard>;
  }
  return (
    <AuthCard title={t("auth.createSuperadmin")} subtitle={t("auth.superadminHint")}>
      {!token && <Alert kind="warning">{t("auth.openSetupLink")}</Alert>}
      {error && <Alert>{error}</Alert>}
      <form onSubmit={submit} className="cms-stack-4">
        <Field label={t("auth.name")}><Input required autoFocus autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label={t("auth.email")}><Input required type="email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label={t("auth.password")} hint={t("auth.passwordHint", { min: config.password.minLength })}>
          <Input required type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <Button type="submit" loading={busy || leaving} disabled={!token} className="cms-w-full">{t("auth.createSuperadminButton")}</Button>
      </form>
    </AuthCard>
  );
}
