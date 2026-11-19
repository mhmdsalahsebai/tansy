"use client";

import { useT } from "../../../components/i18n";
import Link from "next/link";
import { useState } from "react";
import { AuthCard } from "../../../components/auth/AuthCard";
import { useAuthWidgets, type AuthCaptcha, type EnabledWidget } from "../../../components/auth/useAuthWidgets";
import { Alert, Button, Field, Input } from "../../../components/ui/kit";
import { authClient, safeNext } from "../../../lib/auth-client";
import { unwrap, useAction, useApi } from "../../../lib/client/api";
import { apiPath, authPath } from "../../../lib/paths";

export interface AuthConfig {
  appName: string;
  setupRequired: boolean;
  signUp: boolean;
  methods: { password: boolean; magicLink: boolean; emailOtp: boolean; passkey: boolean };
  password: { minLength: number; maxLength: number };
  oauth: string[];
  widgets: EnabledWidget[];
  /** Null when no CAPTCHA is set up. */
  captcha: AuthCaptcha | null;
}

export default function SignInForm({ next, reauth, oauthError }: { next?: string; reauth: boolean; oauthError: boolean }) {
  const { t } = useT();
  const destination = safeNext(next);
  const { data: config } = useApi<AuthConfig>(apiPath("/auth-config"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error, run, setError } = useAction();
  const go = () => { window.location.href = destination; };
  const widgets = useAuthWidgets(config?.widgets, "signin", config?.captcha);

  const signInPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await run(async () => {
      const { data, error: failure } = await authClient.signIn.email({ email, password, fetchOptions: { headers: widgets.headers } });
      if (failure) throw new Error(failure.status === 429 ? t("auth.tooManyAttempts") : t("auth.genericFailure"));
      if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) throw new Error("__2fa__");
    });
    if (ok) go();
    else {
      widgets.failed();
      setError((current) => (current === "__2fa__" ? null : current));
    }
  };
  const sendLink = () => run(async () => {
    await unwrap(authClient.signIn.magicLink({ email, callbackURL: destination }));
    setNotice(t("auth.linkSent"));
  });
  const sendOtp = () => run(async () => {
    await unwrap(authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" }));
    setOtpSent(true);
    setNotice(t("auth.codeSent"));
  });
  const verifyOtp = async () => {
    if (await run(() => unwrap(authClient.signIn.emailOtp({ email, otp })))) go();
  };
  const passkey = async () => {
    if (await run(() => unwrap(authClient.signIn.passkey()))) go();
  };

  if (config?.setupRequired) {
    return <AuthCard title={t("auth.finishSetup")}><Alert kind="info">{t("auth.noSuperadmin")}</Alert></AuthCard>;
  }

  const emailMethods = config?.methods.magicLink || config?.methods.emailOtp;
  return (
    <AuthCard title={t("auth.signInTo", { app: config?.appName ?? t("auth.yourAccount") })} subtitle={config?.signUp ? <>{t("auth.noAccount")} <Link className="cms-link" href={authPath("signup")}>{t("auth.createOne")}</Link></> : undefined}>
      {reauth && <Alert kind="info">{t("auth.reauth")}</Alert>}
      {oauthError && <Alert>{t("auth.oauthError")}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {error && <Alert>{error}</Alert>}
      <Field label={t("auth.email")}><Input type="email" autoComplete="username webauthn" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      {config?.methods.password && (
        <form onSubmit={signInPassword} className="cms-stack-4">
          <Field label={t("auth.password")}><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {widgets.slot}
          <Button type="submit" loading={busy} className="cms-w-full">{t("auth.signIn")}</Button>
          <p className="cms-right cms-text-sm"><Link className="cms-link" href={authPath("forgot-password")}>{t("auth.forgot")}</Link></p>
        </form>
      )}
      {otpSent && (
        <div className="cms-stack-2">
          <Field label={t("auth.emailCode")}><Input inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value)} /></Field>
          <Button loading={busy} className="cms-w-full" onClick={verifyOtp}>{t("auth.verifyCode")}</Button>
        </div>
      )}
      {(emailMethods || config?.methods.passkey || (config?.oauth.length ?? 0) > 0) && <hr className="cms-rule" />}
      <div className="cms-stack-2">
        {config?.methods.passkey && <Button variant="secondary" className="cms-w-full" onClick={passkey}>{t("auth.passkey")}</Button>}
        {config?.methods.magicLink && <Button variant="secondary" className="cms-w-full" disabled={!email} onClick={sendLink}>{t("auth.magicLink")}</Button>}
        {config?.methods.emailOtp && <Button variant="secondary" className="cms-w-full" disabled={!email} onClick={sendOtp}>{t("auth.emailMeCode")}</Button>}
        {config?.oauth.map((provider) => (
          <Button key={provider} variant="secondary" className="cms-w-full cms-capitalize" onClick={() => authClient.signIn.social({ provider, callbackURL: destination, errorCallbackURL: authPath("signin?error=oauth") })}>
            {t("auth.continueWith", { provider })}
          </Button>
        ))}
      </div>
    </AuthCard>
  );
}
