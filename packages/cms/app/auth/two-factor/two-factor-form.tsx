"use client";

import { useT } from "../../../components/i18n";
import { useState } from "react";
import { AuthCard } from "../../../components/auth/AuthCard";
import { Alert, Button, Field, Input } from "../../../components/ui/kit";
import { authClient, safeNext } from "../../../lib/auth-client";
import { unwrap, useAction } from "../../../lib/client/api";

export default function TwoFactorForm({ next }: { next?: string }) {
  const { t } = useT();
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const { busy, error, run } = useAction();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await run(() => unwrap(backup ? authClient.twoFactor.verifyBackupCode({ code }) : authClient.twoFactor.verifyTotp({ code })));
    if (ok) window.location.href = safeNext(next);
  };
  return (
    <AuthCard title={t("auth.twoFactorTitle")}>
      {error && <Alert>{error}</Alert>}
      <form onSubmit={submit} className="cms-stack-4">
        <Field label={backup ? t("auth.backupCode") : t("auth.appCode")}>
          <Input required autoFocus autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Button type="submit" loading={busy} className="cms-w-full">{t("auth.verify")}</Button>
      </form>
      <button type="button" className="cms-text-sm cms-link" onClick={() => { setBackup(!backup); setCode(""); }}>
        {backup ? t("auth.useApp") : t("auth.useBackup")}
      </button>
    </AuthCard>
  );
}
