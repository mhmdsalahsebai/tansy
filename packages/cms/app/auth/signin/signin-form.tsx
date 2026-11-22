"use client";

import { useT } from "../../../components/i18n";
import { EnvelopeIcon, KeyIcon, LinkIcon } from "@heroicons/react/16/solid";
import Link from "next/link";
import { useState } from "react";
import { useAuthConfig, type AuthConfig } from "../../../components/auth/AuthConfig";
import { AuthCard, AuthDivider } from "../../../components/auth/AuthCard";
import { useAuthWidgets } from "../../../components/auth/useAuthWidgets";
import { Alert, Button, Field, Input } from "../../../components/ui/kit";
import { authClient, safeNext } from "../../../lib/auth-client";
import { unwrap, useAction } from "../../../lib/client/api";
import { authPath } from "../../../lib/paths";

export type { AuthConfig };

type Method = "password" | "magicLink" | "emailOtp" | "verifyOtp" | "passkey" | `oauth:${string}`;

export default function SignInForm({ next, reauth, oauthError }: { next?: string; reauth: boolean; oauthError: boolean }) {
  const { t } = useT();
  const config = useAuthConfig();
  const destination = safeNext(next);
  // A public demo hands out its login, so the form starts filled in and trying the dashboard is one press.
  const [email, setEmail] = useState(config.demo?.email ?? "");
  const [password, setPassword] = useState(config.demo?.password ?? "");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The method under way. It stays set while the browser leaves for the dashboard, so the button keeps its spinner until the next page paints.
  const [pending, setPending] = useState<Method | null>(null);
  const { error, run, setError } = useAction();
  const widgets = useAuthWidgets(config.widgets, "signin", config.captcha);

  /** `go` opens `next` once it worked; `away` means the task itself sends the browser elsewhere, as an OAuth provider does. */
  const attempt = async (method: Method, task: () => Promise<unknown>, after?: "go" | "away") => {
    setPending(method);
    setNotice(null);
    const ok = await run(task);
    if (!ok || !after) setPending(null);
    else if (after === "go") window.location.assign(destination);
    return ok;
  };

  const signInPassword = async () => {
    let twoFactor = false;
    const ok = await attempt("password", async () => {
      const { data, error: failure } = await authClient.signIn.email({ email, password, fetchOptions: { headers: widgets.headers } });
      if (failure) throw new Error(failure.status === 429 ? t("auth.tooManyAttempts") : t("auth.genericFailure"));
      // The two-factor plugin is already on its way to the code page; this only keeps the form from going to `next`.
      if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) { twoFactor = true; throw new Error(); }
    }, "go");
    if (ok) return;
    if (twoFactor) { setError(null); setPending("password"); } else widgets.failed();
  };
  const sendLink = () => attempt("magicLink", async () => {
    await unwrap(authClient.signIn.magicLink({ email, callbackURL: destination }));
    setNotice(t("auth.linkSent"));
  });
  const sendOtp = () => attempt("emailOtp", async () => {
    await unwrap(authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" }));
    setOtpSent(true);
    setNotice(t("auth.codeSent"));
  });
  const verifyOtp = (e: React.FormEvent) => {
    e.preventDefault();
    return attempt("verifyOtp", () => unwrap(authClient.signIn.emailOtp({ email, otp })), "go");
  };
  const passkey = () => attempt("passkey", () => unwrap(authClient.signIn.passkey()), "go");
  const social = (provider: string) => attempt(`oauth:${provider}`, () => unwrap(authClient.signIn.social({ provider, callbackURL: destination, errorCallbackURL: authPath("signin?error=oauth") })), "away");

  if (config.setupRequired) {
    return <AuthCard title={t("auth.finishSetup")}><Alert kind="info">{t("auth.noSuperadmin")}</Alert></AuthCard>;
  }

  const { methods } = config;
  // The form's own button is the first enabled way in that uses the address; the rest are listed under it.
  const primary: Method | null = methods.password ? "password" : methods.magicLink ? "magicLink" : methods.emailOtp ? "emailOtp" : null;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (primary === "password") void signInPassword();
    else if (primary === "magicLink") void sendLink();
    else if (primary === "emailOtp") void sendOtp();
  };
  const busy = pending !== null;
  const others = [
    methods.passkey && <Button key="passkey" variant="secondary" className="cms-w-full" loading={pending === "passkey"} disabled={busy} onClick={passkey}><KeyIcon className="cms-icon" aria-hidden="true" />{t("auth.passkey")}</Button>,
    methods.magicLink && primary !== "magicLink" && <Button key="magicLink" variant="secondary" className="cms-w-full" loading={pending === "magicLink"} disabled={busy || !email} onClick={sendLink}><LinkIcon className="cms-icon" aria-hidden="true" />{t("auth.magicLink")}</Button>,
    methods.emailOtp && primary !== "emailOtp" && <Button key="emailOtp" variant="secondary" className="cms-w-full" loading={pending === "emailOtp"} disabled={busy || !email} onClick={sendOtp}><EnvelopeIcon className="cms-icon" aria-hidden="true" />{t("auth.emailMeCode")}</Button>,
    ...config.oauth.map((provider) => (
      <Button key={provider} variant="secondary" className="cms-w-full cms-capitalize" loading={pending === `oauth:${provider}`} disabled={busy} onClick={() => social(provider)}>
        {t("auth.continueWith", { provider })}
      </Button>
    )),
  ].filter(Boolean);

  return (
    <AuthCard
      title={t("auth.signInTo", { app: config.appName })}
      footer={config.signUp ? <>{t("auth.noAccount")} <Link className="cms-link" href={authPath("signup")}>{t("auth.createOne")}</Link></> : undefined}
    >
      {config.demo && primary === "password" && <Alert kind="info">{t("auth.demoFilledIn")}</Alert>}
      {reauth && <Alert kind="info">{t("auth.reauth")}</Alert>}
      {oauthError && <Alert>{t("auth.oauthError")}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {error && <Alert>{error}</Alert>}
      {primary && (
        <form onSubmit={submit} className="cms-stack-4">
          <Field label={t("auth.email")}>
            <Input type="email" required autoFocus autoComplete="username webauthn" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {primary === "password" && (
            <div className="cms-stack-1">
              <Field label={t("auth.password")}>
                <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <p className="cms-right cms-text-sm"><Link className="cms-link" href={authPath("forgot-password")}>{t("auth.forgot")}</Link></p>
            </div>
          )}
          {widgets.slot}
          <Button type="submit" loading={pending === primary} disabled={busy} className="cms-w-full">
            {primary === "password" ? t("auth.signIn") : primary === "magicLink" ? t("auth.magicLink") : t("auth.emailMeCode")}
          </Button>
        </form>
      )}
      {otpSent && (
        <form onSubmit={verifyOtp} className="cms-stack-4">
          <Field label={t("auth.emailCode")}><Input required autoFocus inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value)} /></Field>
          <Button type="submit" loading={pending === "verifyOtp"} disabled={busy} className="cms-w-full">{t("auth.verifyCode")}</Button>
        </form>
      )}
      {primary && others.length > 0 && <AuthDivider />}
      {others.length > 0 && <div className="cms-stack-2">{others}</div>}
    </AuthCard>
  );
}
