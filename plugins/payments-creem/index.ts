import { Creem } from "creem";
import { creem as creemPlugin } from "@creem_io/better-auth";
import type { ExtensionContext } from "tansy/plugin";
import { definePaymentProvider, loadPlanRefs, newReference, type PaymentsSettings, type PlanRef, recordPurchase, recordRefund, REFERENCE, rememberCheckout, startedCheckout, str, upsertMembership } from "@tansy/payments/provider";

interface CreemSettings { creemApiKey: string; creemWebhookSecret: string; creemProductId: string }
const keys = (settings: PaymentsSettings) => settings as PaymentsSettings & CreemSettings;

const client = (settings: PaymentsSettings) => new Creem({ apiKey: keys(settings).creemApiKey, serverURL: settings.testMode ? "https://test-api.creem.io" : "https://api.creem.io" });

const idOf = (value: unknown) => (typeof value === "string" ? value : str((value as { id?: unknown } | null | undefined)?.id));
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});

interface CreemOrder { id: string; amount: number; currency: string; status?: string }

async function onSubscription(context: ExtensionContext, data: Record<string, unknown>, plans: () => Promise<PlanRef[]>) {
  await upsertMembership(context, {
    provider: "creem",
    subscriptionId: str(data.id),
    // better-auth's Creem plugin puts the signed-in user's id in referenceId.
    user: str(record(data.metadata).referenceId) || null,
    productId: idOf(data.product),
    status: str(data.status),
    periodEnd: (data.current_period_end_date as string | Date | undefined) ?? null,
    at: Number(data.webhookCreatedAt) || Date.now(),
  }, await plans());
}

/** Creem, through better-auth's Creem plugin. Payments keeps its subscriptions as memberships. */
export const creem = () => definePaymentProvider({
  id: "creem",
  label: "Creem",
  webhookPath: "/creem/webhook",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: (siteUrl) => ({
    ar: { settings: {
      creemApiKey: { label: "مفتاح API لـ Creem", description: "من Creem ← Developers. فعّل وضع الاختبار لمفتاح اختبار." },
      creemWebhookSecret: { label: "سرّ webhook في Creem", description: `وجّه webhook من Creem إلى ${siteUrl}/api/auth/creem/webhook، ثم الصق سرّه.` },
      creemProductId: { label: "منتج Creem للمشتريات لمرة واحدة", description: "منتج لمرة واحدة مع تفعيل «ادفع ما تريد»، بعملة أسعارك (USD أو EUR). يُباع كل سجل تحته بسعره الخاص." },
    } },
  }),
  settings: (siteUrl) => [
    { name: "creemApiKey", type: "secret", env: "CREEM_API_KEY", label: "Creem API key", description: "From Creem → Developers. Turn on test mode for a test key." },
    { name: "creemWebhookSecret", type: "secret", env: "CREEM_WEBHOOK_SECRET", label: "Creem webhook secret", description: `Point a Creem webhook at ${siteUrl}/api/auth/creem/webhook, then paste its secret.` },
    { name: "creemProductId", type: "text", default: "", maxLength: 100, label: "Creem product for one-time purchases", description: "A one-time product with pay what you want turned on, in the currency of your prices (USD or EUR). Each record sells under it at its own price." },
  ],
  serverOnlyPaths: CREEM_SERVER_ONLY,
  planIdProblem: (value) => (value.startsWith("prod_") ? null : "Use a Creem product id, which starts with prod_."),
  ready: (settings) => Boolean(keys(settings).creemApiKey && keys(settings).creemWebhookSecret),

  authPlugins(settings, context, siteUrl) {
    const plans = () => loadPlanRefs(context);
    const subscription = async (data: unknown) => onSubscription(context, data as Record<string, unknown>, plans);
    return [creemPlugin({
      apiKey: keys(settings).creemApiKey,
      webhookSecret: keys(settings).creemWebhookSecret,
      testMode: settings.testMode,
      defaultSuccessUrl: siteUrl,
      onCheckoutCompleted: async (data) => {
        const order = data.order as CreemOrder | undefined;
        const metadata = record(data.metadata);
        if (order && order.status !== "pending") await recordPurchase(context, { provider: "creem", sessionId: str(metadata.ref), paymentRef: order.id, metadata, amount: order.amount, currency: order.currency });
      },
      onRefundCreated: async (data) => {
        const order = data.order as CreemOrder | string | undefined;
        const total = typeof order === "object" ? order.amount : null;
        // Only a refund of the whole order takes the purchase back.
        if (total !== null && data.refund_amount < total) return;
        await recordRefund(context, { paymentRef: idOf(order) || null });
      },
      onSubscriptionActive: subscription,
      onSubscriptionTrialing: subscription,
      onSubscriptionPaid: subscription,
      onSubscriptionCanceled: subscription,
      onSubscriptionScheduledCancel: subscription,
      onSubscriptionExpired: subscription,
      onSubscriptionUnpaid: subscription,
      onSubscriptionPastDue: subscription,
      onSubscriptionPaused: subscription,
      onSubscriptionUpdate: subscription,
    })];
  },

  async currencyProblem(settings, currency) {
    if (!keys(settings).creemProductId) return "Payments → Settings needs the Creem product that one-time purchases are sold under.";
    const product = await client(settings).products.get(keys(settings).creemProductId).catch(() => null);
    if (!product) return "The Creem product under Payments → Settings can't be found.";
    const productCurrency = str(product.currency).toLowerCase();
    return productCurrency && productCurrency !== currency ? `This is priced in ${currency.toUpperCase()}, and the Creem product sells in ${productCurrency.toUpperCase()}.` : null;
  },

  async checkout({ context, settings, buyer, collection, recordId, amount, successUrl }) {
    const ref = newReference();
    const created = await client(settings).checkouts.create({
      // A pay-what-you-want product, at the record's own price.
      productId: keys(settings).creemProductId,
      customPrice: amount,
      requestId: ref,
      customer: { email: buyer.email },
      metadata: { tansy: "purchase", collection, recordId: String(recordId), userId: buyer.id, ref, referenceId: buyer.id },
      successUrl: `${successUrl}&session_id=${ref}`,
    });
    await rememberCheckout(context, ref, { id: created.id, userId: buyer.id, collection, recordId, at: Date.now() });
    if (!created.checkoutUrl) throw new Error("Creem returned no checkout address.");
    return created.checkoutUrl;
  },

  isReference: (value) => REFERENCE.test(value),

  async confirm(context, settings, reference, buyer) {
    const started = await startedCheckout(context, reference);
    if (!started || started.userId !== buyer.id) return null;
    const found = await client(settings).checkouts.retrieve(started.id).catch(() => null);
    if (!found) return null;
    const order = found.order;
    const paid = found.status === "completed" && Boolean(order) && order?.status !== "pending";
    if (paid && order) await recordPurchase(context, { provider: "creem", sessionId: reference, paymentRef: order.id, metadata: found.metadata, amount: order.amount, currency: order.currency });
    context.auditTarget("record", `${started.collection}/${started.recordId}`, { paid });
    return { paid };
  },

  async subscribe({ context, plan, annual, successUrl }) {
    const { url } = await context.auth.call<{ url: string }>("/creem/create-checkout", { body: { productId: annual && plan.annualProductId ? plan.annualProductId : plan.productId, successUrl } });
    return url;
  },

  async billing(context) {
    // Without a customerId, the plugin uses the caller's own.
    const { url } = await context.auth.call<{ url: string }>("/creem/create-portal", { body: {} });
    return url;
  },
});

/**
 * Creem's endpoints that take an id from the request without checking it belongs to the
 * caller, and its checkout, which takes metadata of the caller's choosing. Payments' own
 * routes call them after their checks.
 */
export const CREEM_SERVER_ONLY = ["/creem/create-checkout", "/creem/create-portal", "/creem/cancel-subscription", "/creem/retrieve-subscription", "/creem/search-transactions"];
