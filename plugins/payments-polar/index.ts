import { checkout, polar as polarPlugin, portal, webhooks } from "@polar-sh/better-auth";
import { createPolarCore } from "@polar-sh/sdk/2026-10";
import { createCheckouts, getCheckouts } from "@polar-sh/sdk/2026-10/services/checkouts";
import type { ExtensionContext } from "tansy/plugin";
import { definePaymentProvider, loadPlanRefs, newReference, type PaymentsSettings, type PlanRef, productSlugs, recordPurchase, recordRefund, REFERENCE, rememberCheckout, startedCheckout, upsertMembership } from "@tansy/payments/provider";

interface PolarSettings { polarAccessToken: string; polarWebhookSecret: string; polarProductId: string }
const keys = (settings: PaymentsSettings) => settings as PaymentsSettings & PolarSettings;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const client = (settings: PaymentsSettings) => createPolarCore({ accessToken: keys(settings).polarAccessToken, environment: settings.testMode ? "sandbox" : "production" });

interface PolarOrder { id: string; status: string; total_amount: number; currency: string; checkout_id: string | null; metadata: Record<string, unknown> }
interface PolarSubscription { id: string; status: string; product_id: string; current_period_end: string; modified_at: string | null; created_at?: string; metadata: Record<string, unknown>; customer: { external_id?: string | null } }

async function onOrderPaid(context: ExtensionContext, order: PolarOrder) {
  await recordPurchase(context, { provider: "polar", sessionId: String(order.metadata?.ref ?? ""), paymentRef: order.id, metadata: order.metadata, amount: order.total_amount, currency: order.currency });
}

async function onSubscription(context: ExtensionContext, subscription: PolarSubscription, timestamp: Date | string, plans: () => Promise<PlanRef[]>) {
  await upsertMembership(context, {
    provider: "polar",
    subscriptionId: subscription.id,
    // better-auth's Polar plugin makes the user's id the customer's external id.
    user: subscription.customer?.external_id ?? null,
    productId: subscription.product_id,
    status: subscription.status,
    periodEnd: subscription.current_period_end,
    at: new Date(subscription.modified_at ?? timestamp).getTime(),
  }, await plans());
}

/** Polar, through better-auth's Polar plugin. Payments keeps its subscriptions as memberships. */
export const polar = () => definePaymentProvider({
  id: "polar",
  label: "Polar",
  webhookPath: "/polar/webhooks",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: (siteUrl) => ({
    ar: { settings: {
      polarAccessToken: { label: "رمز الوصول في Polar", description: "من Polar ← Settings ← Developers، رمز وصول للمؤسسة. فعّل وضع الاختبار لرمز sandbox." },
      polarWebhookSecret: { label: "سرّ webhook في Polar", description: `وجّه webhook من Polar إلى ${siteUrl}/api/auth/polar/webhooks، مع أحداث الطلبات والاشتراكات، ثم الصق سرّه.` },
      polarProductId: { label: "منتج Polar للمشتريات لمرة واحدة", description: "منتج لمرة واحدة في Polar. يُباع كل سجل تحته بسعره الخاص. اتركه فارغًا إن كنت تبيع الخطط فقط." },
    } },
  }),
  settings: (siteUrl) => [
    { name: "polarAccessToken", type: "secret", env: "POLAR_ACCESS_TOKEN", label: "Polar access token", description: "From Polar → Settings → Developers, an organization access token. Turn on test mode for a sandbox token." },
    { name: "polarWebhookSecret", type: "secret", env: "POLAR_WEBHOOK_SECRET", label: "Polar webhook secret", description: `Point a Polar webhook at ${siteUrl}/api/auth/polar/webhooks, with order and subscription events, then paste its secret.` },
    { name: "polarProductId", type: "text", default: "", maxLength: 100, label: "Polar product for one-time purchases", description: "A one-time product in Polar. Each record sells under it at its own price. Leave empty if you sell only plans." },
  ],
  // Polar's checkout takes any products and metadata from the caller.
  serverOnlyPaths: ["/checkout"],
  planIdProblem: (value) => (UUID.test(value) ? null : "Use a Polar product id, such as 1c4e2f6a-0b1c-4d2e-8f3a-123456789abc."),
  ready: (settings) => Boolean(keys(settings).polarAccessToken && keys(settings).polarWebhookSecret),

  authPlugins(settings, context, siteUrl) {
    const plans = () => loadPlanRefs(context);
    const subscription = async (payload: { data: unknown; timestamp: Date | string }) => onSubscription(context, payload.data as PolarSubscription, payload.timestamp, plans);
    return [polarPlugin({
      client: client(settings),
      createCustomerOnSignUp: settings.createCustomerOnSignUp,
      use: [
        checkout({ products: async () => productSlugs(await plans()), authenticatedUsersOnly: true }),
        portal({ returnUrl: siteUrl }),
        webhooks({
          secret: keys(settings).polarWebhookSecret,
          onOrderPaid: async (payload) => onOrderPaid(context, payload.data as unknown as PolarOrder),
          onOrderRefunded: async (payload) => {
            const order = payload.data as unknown as PolarOrder;
            if (order.status === "refunded") await recordRefund(context, { sessionId: typeof order.metadata?.ref === "string" ? order.metadata.ref : null, paymentRef: order.id });
          },
          onSubscriptionCreated: subscription,
          onSubscriptionUpdated: subscription,
          onSubscriptionActive: subscription,
          onSubscriptionCanceled: subscription,
          onSubscriptionUncanceled: subscription,
          onSubscriptionRevoked: subscription,
        }),
      ],
    })];
  },

  async checkout({ context, settings, buyer, collection, recordId, amount, currency, successUrl, cancelUrl }) {
    if (!keys(settings).polarProductId) throw new Error("Payments → Settings needs the Polar product that one-time purchases are sold under.");
    const ref = newReference();
    const productId = keys(settings).polarProductId;
    const created = await createCheckouts(client(settings))({
      products: [productId],
      // The record's own price, in place of the product's.
      prices: { [productId]: [{ amount_type: "fixed", price_amount: amount, price_currency: currency as never }] },
      external_customer_id: buyer.id,
      customer_email: buyer.email,
      metadata: { tansy: "purchase", collection, recordId: String(recordId), userId: buyer.id, ref },
      success_url: `${successUrl}&session_id=${ref}`,
      return_url: cancelUrl,
    });
    await rememberCheckout(context, ref, { id: created.id, userId: buyer.id, collection, recordId, at: Date.now() });
    return created.url;
  },

  isReference: (value) => REFERENCE.test(value),

  async confirm(context, settings, reference, buyer) {
    const started = await startedCheckout(context, reference);
    if (!started || started.userId !== buyer.id) return null;
    const found = await getCheckouts(client(settings))(started.id).catch(() => null);
    if (!found) return null;
    const paid = found.status === "succeeded";
    if (paid) await recordPurchase(context, { provider: "polar", sessionId: reference, paymentRef: null, metadata: found.metadata, amount: found.total_amount, currency: found.currency });
    context.auditTarget("record", `${started.collection}/${started.recordId}`, { paid });
    return { paid };
  },

  async subscribe({ context, plan, annual, successUrl, cancelUrl }) {
    const slug = annual && plan.annualProductId ? `${plan.name}-annual` : plan.name;
    const { url } = await context.auth.call<{ url: string }>("/checkout", { body: { slug, success_url: successUrl, return_url: cancelUrl, redirect: false } });
    return url;
  },

  async billing(context) {
    const { url } = await context.auth.call<{ url: string }>("/customer/portal", { body: { redirect: false } });
    return url;
  },
});
