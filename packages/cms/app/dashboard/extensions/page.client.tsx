"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useT } from "../../../components/i18n";
import { Button } from "../../../components/ui/kit";
import { api, errorText } from "../../../lib/client/api";
import { apiPath } from "../../../lib/paths";

/** Runs a failed after-hook again, from the Extensions page. */
export default function HookRetryButton({ id }: { id: number }) {
  const { t } = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api(apiPath(`/extensions/hook-deliveries/${id}/retry`), { method: "POST" });
            router.refresh();
          } catch (caught) {
            setError(errorText(caught));
          } finally {
            setBusy(false);
          }
        }}
      >
        {t("extensions.runAgain")}
      </Button>
      {error && <span role="alert" className="cms-danger cms-text-sm"> {error}</span>}
    </>
  );
}
