"use client";

import { useEffect, useState } from "react";
import { Alert, apiPath, useT } from "tansy/admin";

/** Says what's missing for forms to reach anyone: email to deliver notifications, and a CAPTCHA to keep scripts out. */
export function SetupStatus() {
  const { t } = useT();
  const [status, setStatus] = useState<{ mail: boolean; captcha: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    fetch(apiPath("/ext/forms/status")).then((response) => (response.ok ? response.json() : null)).then((json) => { if (active) setStatus(json); }).catch(() => {});
    return () => { active = false; };
  }, []);
  if (!status) return null;
  return (
    <div className="cms-stack-2 cms-mb-6">
      {!status.mail && <Alert kind="warning">{t("ext.forms.status.noMail")}</Alert>}
      {!status.captcha && <Alert kind="info">{t("ext.forms.status.noCaptcha")}</Alert>}
    </div>
  );
}
