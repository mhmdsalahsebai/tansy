import { Commet } from "@commet/node";
import { commet as commetPlugin, portal, subscriptions, webhooks } from "@commet/better-auth";
import type { ExtensionContext } from "tansy/plugin";
import { type Buyer, definePaymentProvider, isUserId, loadPlanRefs, newReference, type PaymentsSettings, type PlanRef, PURCHASES, recordPurchase, recordRefund, REFERENCE, rememberCheckout, startedCheckout, str, toMinorUnits, upsertMembership } from "@tansy/payments/provider";

interface CommetSettings { commetApiKey: string; commetWebhookSecret: string }
const keys = (settings: PaymentsSettings) => settings as PaymentsSettings & CommetSettings;

const client = (settings: PaymentsSettings) => new Commet({ apiKey: keys(settings).commetApiKey });

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});

/** better-auth's Commet plugin makes the user's id the customer's id. Payments does the same for people who signed up before. */
async function ensureCustomer(sdk: Commet, buyer: Buyer) {
  const { data } = await sdk.customers.list({ externalId: buyer.id });
  if (!data?.length) await sdk.customers.create({ id: buyer.id, email: buyer.email, ...(buyer.name ? { fullName: buyer.name } : {}) }).catch(async (error) => {
    // Created at the same moment by another request.
    if (!(await sdk.customers.list({ externalId: buyer.id })).data?.length) throw error;
  });
}

async function recordPayment(context: ExtensionContext, sdk: Commet, paymentId: string) {
  const payment = await sdk.payments.get({ id: paymentId });
  if (payment.status !== "succeeded") return false;
  const metadata = payment.metadata ?? {};
  return recordPurchase(context, { provider: "commet", sessionId: str(metadata.ref), paymentRef: payment.paymentContext?.paymentLinkId ?? payment.id, metadata, amount: payment.amountTotal, currency: payment.currency });
}

/** Commet's subscription events don't carry the plan, so Payments reads the subscription back. */
async function syncSubscription(context: ExtensionContext, sdk: Commet, subscriptionId: string, at: number, plans: PlanRef[]) {
  const subscription = await sdk.subscriptions.get({ id: subscriptionId });
  const customerId = subscription.customerId;
  const user = isUserId(customerId) && (await context.system.users.get(customerId)) ? customerId : (await sdk.customers.get({ id: customerId }).catch(() => null))?.externalId ?? null;
  await upsertMembership(context, { provider: "commet", subscriptionId, user, productId: subscription.plan.id, status: subscription.status, periodEnd: subscription.currentPeriod?.end ?? null, at }, plans);
}

/** Every Commet event better-auth's plugin verified. Throwing makes Commet send it again. */
async function onEvent(context: ExtensionContext, settings: PaymentsSettings, payload: unknown) {
  const { event, data, timestamp } = record(payload) as { event?: string; data?: Record<string, unknown>; timestamp?: string };
  if (!event || !data) return;
  const sdk = client(settings);
  if (event === "payment_link.completed" && str(data.paymentId)) await recordPayment(context, sdk, str(data.paymentId));
  else if (event === "payment.refunded") {
    // Commet sends what was refunded. Only a refund of the whole purchase takes it back.
    const ref = str(data.paymentLinkId);
    if (!ref) return;
    const { items } = await context.system.records.list(PURCHASES, { filter: `paymentIntent = "${ref.replace(/[^A-Za-z0-9_-]/g, "")}"`, perPage: 1, fields: "amount,currency" });
    const purchase = items[0];
    const total = purchase ? toMinorUnits(purchase.amount, str(purchase.currency) || "usd") : null;
    if (total !== null && Number(data.refundAmount) >= total) await recordRefund(context, { paymentRef: ref });
  } else if (event.startsWith("subscription.") && str(data.subscriptionId)) {
    await syncSubscription(context, sdk, str(data.subscriptionId), timestamp ? new Date(timestamp).getTime() : Date.now(), await loadPlanRefs(context));
  }
}

/** Commet, through better-auth's Commet plugin. Payments keeps its subscriptions as memberships. */
export const commet = () => definePaymentProvider({
  id: "commet",
  label: "Commet",
  webhookPath: "/commet/webhooks",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: (siteUrl) => ({
    ar: { settings: {
      commetApiKey: { label: "مفتاح API لـ Commet", description: "من Commet ← Developers. يبدأ بـ ck_. مفتاح sandbox للاختبار." },
      commetWebhookSecret: { label: "سرّ webhook في Commet", description: `وجّه webhook من Commet إلى ${siteUrl}/api/auth/commet/webhooks، ثم الصق سرّه، الذي يبدأ بـ whsec_.` },
    } },
  }),
  settings: (siteUrl) => [
    { name: "commetApiKey", type: "secret", env: "COMMET_API_KEY", label: "Commet API key", description: "From Commet → Developers. Starts with ck_. A sandbox key tests." },
    { name: "commetWebhookSecret", type: "secret", env: "COMMET_WEBHOOK_SECRET", label: "Commet webhook secret", description: `Point a Commet webhook at ${siteUrl}/api/auth/commet/webhooks, then paste its secret, which starts with whsec_.` },
  ],
  yearlyFromSamePlan: true,
  planIdProblem: (value) => (/^[A-Za-z0-9_:.-]{1,100}$/.test(value) ? null : "Use a Commet plan id."),
  ready: (settings) => Boolean(keys(settings).commetApiKey && keys(settings).commetWebhookSecret),

  authPlugins: (settings, context, siteUrl) => [commetPlugin({
    client: client(settings),
    createCustomerOnSignUp: settings.createCustomerOnSignUp,
    use: [
      portal({ returnUrl: siteUrl }),
      subscriptions(),
      webhooks({ secret: keys(settings).commetWebhookSecret, onPayload: async (payload) => onEvent(context, settings, payload) }),
    ],
  })],

  async checkout({ context, settings, buyer, collection, recordId, name, amount, currency, successUrl }) {
    const sdk = client(settings);
    await ensureCustomer(sdk, buyer);
    const ref = newReference();
    // A hosted payment link at the record's own price. Commet needs no product for it.
    const payment = await sdk.payments.create({
      amount,
      currency: currency.toUpperCase(),
      customerId: buyer.id,
      description: name,
      successUrl: `${successUrl}&session_id=${ref}`,
      metadata: { tansy: "purchase", collection, recordId: String(recordId), userId: buyer.id, ref },
    });
    await rememberCheckout(context, ref, { id: payment.id, userId: buyer.id, collection, recordId, at: Date.now() });
    if (!payment.url) throw new Error("Commet returned no payment address.");
    return payment.url;
  },

  isReference: (value) => REFERENCE.test(value),

  async confirm(context, settings, reference, buyer) {
    const started = await startedCheckout(context, reference);
    if (!started || started.userId !== buyer.id) return null;
    const paid = await recordPayment(context, client(settings), started.id).catch(() => null);
    if (paid === null) return null;
    context.auditTarget("record", `${started.collection}/${started.recordId}`, { paid });
    return { paid };
  },

  async subscribe({ context, settings, buyer, plan, annual, successUrl }) {
    const sdk = client(settings);
    await ensureCustomer(sdk, buyer);
    const created = await sdk.subscriptions.create({ customerId: buyer.id, planId: plan.productId, ...(annual ? { billingInterval: "yearly" as const } : {}), successUrl });
    // Recorded now, so its events find whose it is.
    await upsertMembership(context, { provider: "commet", subscriptionId: created.id, user: buyer.id, productId: created.plan.id, status: created.status, periodEnd: created.currentPeriod?.end ?? null, at: Date.now() }, await loadPlanRefs(context));
    // A free trial without a card starts at once, with nothing to pay.
    return created.checkoutUrl ?? successUrl;
  },

  async billing(context) {
    const { url } = await context.auth.call<{ url: string }>("/commet/portal");
    return url;
  },
});
