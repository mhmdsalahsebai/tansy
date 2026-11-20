"use client";

import { useT } from "../../../components/i18n";
import Link from "next/link";
import { useState } from "react";
import { AuthCard } from "../../../components/auth/AuthCard";
import { useAuthWidgets } from "../../../components/auth/useAuthWidgets";
import { Alert, Button, Field, Input } from "../../../components/ui/kit";
import { authClient } from "../../../lib/auth-client";
import { useAuthConfig } from "../../../components/auth/AuthConfig";
import { unwrap, useAction } from "../../../lib/client/api";
import { authPath } from "../../../lib/paths";

export default function SignUpPage() {
  const { t } = useT();
  const config = useAuthConfig();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  const widgets = useAuthWidgets(config.widgets, "signup", config.captcha);

  const backToSignIn = <Link className="cms-link" href={authPath("signin")}>{t("auth.backToSignIn")}</Link>;
  if (!config.signUp) {
    return <AuthCard title={t("auth.signUpClosed")} footer={backToSignIn}><Alert kind="info">{t("auth.askAdmin")}</Alert></AuthCard>;
  }
  if (done) {
    return <AuthCard title={t("auth.checkEmail")} footer={<Link className="cms-link" href={authPath("signin")}>{t("auth.goToSignIn")}</Link>}><Alert kind="success">{t("auth.registered")}</Alert></AuthCard>;
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await run(() => unwrap(authClient.signUp.email({ ...form, fetchOptions: { headers: widgets.headers } })))) setDone(true);
    else widgets.failed();
  };
  return (
    <AuthCard title={t("auth.createAccountTitle")} footer={<>{t("auth.alreadyRegistered")} <Link className="cms-link" href={authPath("signin")}>{t("auth.signIn")}</Link></>}>
      {error && <Alert>{error}</Alert>}
      <form onSubmit={submit} className="cms-stack-4">
        <Field label={t("auth.name")}><Input required autoFocus autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label={t("auth.email")}><Input required type="email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label={t("auth.password")} hint={t("auth.passwordHint", { min: config.password.minLength })}>
          <Input required type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        {widgets.slot}
        <Button type="submit" loading={busy} className="cms-w-full">{t("auth.createAccount")}</Button>
      </form>
    </AuthCard>
  );
}
