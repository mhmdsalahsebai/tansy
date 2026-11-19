"use client";

import { useEffect, useState } from "react";
import { adminPath, apiPath, defineAdminClient, translate, useT, type RecordPanelProps } from "tansy/admin";
import { formatMoney as money, linesOf, str } from "./logic";

/** This plugin's words outside a component. */
const word = (key: string, values?: Record<string, string | number>) => translate(`ext.shop.${key}`, values);

/** This plugin's words and money in the person's interface language. */
function useWords() {
  const { t, locale } = useT();
  return { t: (key: string, values?: Record<string, string | number>) => t(`ext.shop.${key}`, values), formatMoney: (amount: number, currency: string) => money(amount, currency, locale) };
}

async function setState(orderId: number, state: "shipped" | "delivered", trackingUrl?: string) {
  const response = await fetch(apiPath(`/ext/shop/orders/${orderId}/status`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, ...(trackingUrl ? { trackingUrl } : {}) }) });
  if (response.ok) return null;
  const json = await response.json().catch(() => null) as { error?: { message?: string; details?: Array<{ message?: string }> } } | null;
  return json?.error?.details?.[0]?.message ?? json?.error?.message ?? word("order.notChanged");
}

/** What was ordered and where it goes, readable, instead of the raw JSON fields. */
function OrderPanel({ values }: RecordPanelProps) {
  const { t, formatMoney } = useWords();
  const lines = linesOf(values.lines);
  if (!lines.length) return null;
  const currency = str(values.currency) || "usd";
  const address = (values.address ?? null) as Record<string, unknown> | null;
  return (
    <section className="cms-panel cms-cell">
      <h3 className="cms-section-title cms-mb-2">{t("order.title")}</h3>
      <table className="cms-table">
        <thead><tr><th>{t("columns.item")}</th><th>{t("columns.sku")}</th><th>{t("columns.price")}</th><th>{t("columns.qty")}</th><th>{t("columns.subtotal")}</th></tr></thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={index}>
              <td>{line.title}{line.variantTitle ? ` · ${line.variantTitle}` : ""}</td>
              <td>{line.sku ?? "—"}</td>
              <td>{formatMoney(line.unitPrice, currency)}</td>
              <td>{line.quantity}</td>
              <td>{formatMoney(line.subtotal, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="cms-text-sm cms-muted">
        {t("order.sums", { items: formatMoney(Number(values.subtotal) || 0, currency), shipping: formatMoney(Number(values.shippingCost) || 0, currency), total: formatMoney(Number(values.total) || 0, currency) })}
      </p>
      {address && (
        <address className="cms-text-sm" style={{ fontStyle: "normal", whiteSpace: "pre-line" }}>
          {[address.name, address.line1, address.line2, [address.postalCode, address.city].filter(Boolean).join(" "), address.region, address.country, address.phone].map(str).filter(Boolean).join("\n")}
        </address>
      )}
    </section>
  );
}

interface Variant { id: number; title?: string; sku?: string; price?: number | null; stock?: number | null; status?: string }

/** A product's variants and their stock, with links to edit them. */
function VariantsPanel({ recordId }: RecordPanelProps) {
  const { t } = useWords();
  const [state, setState] = useState<{ variants: Variant[]; collection: number | null } | null>(null);
  useEffect(() => {
    if (!recordId) return;
    let live = true;
    void Promise.all([
      fetch(apiPath(`/collections/shop-variants/records?perPage=100&sort=position&fields=id,title,sku,price,stock,status&filter=${encodeURIComponent(`product = ${Number(recordId)}`)}`)).then((r) => (r.ok ? r.json() : { items: [] })),
      fetch(apiPath("/collections")).then((r) => (r.ok ? r.json() : [])),
    ]).then(([list, collections]) => {
      const found = (collections as Array<{ id: number; slug: string }>).find((collection) => collection.slug === "shop-variants");
      if (live) setState({ variants: (list as { items: Variant[] }).items ?? [], collection: found?.id ?? null });
    }).catch(() => { if (live) setState({ variants: [], collection: null }); });
    return () => { live = false; };
  }, [recordId]);
  if (!recordId || !state) return null;
  const link = (path: string) => (state.collection ? adminPath(`/collections/${state.collection}/content/${path}`) : null);
  return (
    <section className="cms-panel cms-cell">
      <h3 className="cms-section-title cms-mb-2">{t("variants.title")}</h3>
      {state.variants.length === 0 ? <p className="cms-text-sm cms-muted">{t("variants.none")}</p> : (
        <table className="cms-table">
          <thead><tr><th>{t("columns.option")}</th><th>{t("columns.sku")}</th><th>{t("columns.price")}</th><th>{t("columns.stock")}</th></tr></thead>
          <tbody>
            {state.variants.map((variant) => (
              <tr key={variant.id}>
                <td>{link(String(variant.id)) ? <a className="cms-link" href={link(String(variant.id))!}>{variant.title}</a> : variant.title}{variant.status === "draft" && <span className="cms-faded">{t("variants.draft")}</span>}</td>
                <td>{variant.sku || "—"}</td>
                <td>{typeof variant.price === "number" ? variant.price : t("variants.productsPrice")}</td>
                <td>{typeof variant.stock === "number" ? variant.stock : t("variants.notCounted")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {link("new") && <p className="cms-text-sm"><a className="cms-link" href={link("new")!}>{t("variants.add")}</a>{t("variants.addAfter")}</p>}
    </section>
  );
}

function Panels(props: RecordPanelProps) {
  if (props.collection.slug === "shop-orders") return <OrderPanel {...props} />;
  if (props.collection.slug === "shop-products") return <VariantsPanel {...props} />;
  return null;
}

export default defineAdminClient({
  recordActions: [
    {
      id: "shop-ship",
      label: "Mark shipped",
      permission: "ext.shop:fulfill",
      collections: ["shop-orders"],
      run: async ({ record, refresh }) => {
        if (record.state !== "paid") return window.alert(word("order.onlyPaid"));
        const tracking = window.prompt(word("order.tracking"));
        if (tracking === null) return;
        const problem = await setState(Number(record.id), "shipped", tracking.trim() || undefined);
        if (problem) window.alert(problem);
        refresh();
      },
    },
    {
      id: "shop-deliver",
      label: "Mark delivered",
      permission: "ext.shop:fulfill",
      collections: ["shop-orders"],
      run: async ({ record, refresh }) => {
        if (record.state !== "paid" && record.state !== "shipped") return window.alert(word("order.onlyPaidOrShipped"));
        const problem = await setState(Number(record.id), "delivered");
        if (problem) window.alert(problem);
        refresh();
      },
    },
  ],
  recordPanels: [{ id: "shop-panels", component: Panels }],
});
