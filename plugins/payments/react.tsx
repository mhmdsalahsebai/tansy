"use client";

import { useState } from "react";
import { apiPath, authPath, siteWords, type SiteWords } from "tansy/react";
import { siteMessages } from "./site-messages";

const ENGLISH: SiteWords = { locale: "en", messages: siteMessages.en };

/**
 * Buttons any template or block can place. Each sends the visitor to the payment provider and back to
 * the page they were on. Signed-out visitors go to sign in first. Pass the page's `words`
 * (`pickWords(words, "payments")`) to word them in its language.
 */

const here = () => `${window.location.pathname}${window.location.search}`;
const signIn = () => { window.location.assign(authPath(`signin?next=${encodeURIComponent(here())}`)); };

async function post(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json().catch(() => null) as { url?: string } | null;
  return { status: response.status, ok: response.ok, url: json?.url };
}

function useRedirect(start: () => ReturnType<typeof post>, failed: string, t: ReturnType<typeof siteWords>["t"]) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const { status, ok, url } = await start();
      if (status === 401) return signIn();
      // The route's message is English, for API callers, so the page says it in its own words.
      if (!ok || !url) return setError(failed);
      window.location.assign(url);
    } catch {
      setError(t("payments.offline", { problem: failed }));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, go };
}

function Action({ label, busyLabel, busy, error, onClick }: { label: string; busyLabel: string; busy: boolean; error: string | null; onClick: () => void }) {
  return (
    <div className="payments-cta">
      <button type="button" className="payments-button" onClick={onClick} disabled={busy}>{busy ? busyLabel : label}</button>
      {error && <p className="payments-error" role="alert">{error}</p>}
    </div>
  );
}

/** Buys one record of any collection with a Price field. */
export function BuyButton({ collection, id, label, words }: { collection: string; id: number; label?: string; words?: SiteWords }) {
  const { t } = siteWords(words ?? ENGLISH);
  const { busy, error, go } = useRedirect(() => post(apiPath("/ext/payments/checkout"), { collection, id, returnPath: here() }), t("payments.checkoutFailed"), t);
  return <Action label={label ?? t("payments.buy")} busyLabel={t("payments.opening")} busy={busy} error={error} onClick={go} />;
}

/** Subscribes to a plan from Payments → Plans, or switches to it, with whichever provider the site uses. */
export function SubscribeButton({ plan, annual = false, label, words }: { plan: string; annual?: boolean; label?: string; words?: SiteWords }) {
  const { t } = siteWords(words ?? ENGLISH);
  const { busy, error, go } = useRedirect(() => post(apiPath("/ext/payments/subscribe"), { plan: plan.toLowerCase(), annual, returnPath: window.location.pathname }), t("payments.subscribeFailed"), t);
  return <Action label={label ?? t("payments.subscribe")} busyLabel={t("payments.opening")} busy={busy} error={error} onClick={go} />;
}

/** The provider's billing page: change plan, update the card, see invoices, cancel. */
export function BillingButton({ label, words }: { label?: string; words?: SiteWords }) {
  const { t } = siteWords(words ?? ENGLISH);
  const { busy, error, go } = useRedirect(() => post(apiPath("/ext/payments/billing"), { returnPath: here() }), t("payments.billingFailed"), t);
  return <Action label={label ?? t("payments.billing")} busyLabel={t("payments.openingBilling")} busy={busy} error={error} onClick={go} />;
}
