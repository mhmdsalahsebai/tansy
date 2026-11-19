import DodoPayments from "dodopayments";
import { checkout, dodopayments, portal, webhooks } from "@dodopayments/better-auth";
import type { ExtensionContext } from "tansy/plugin";
import { definePaymentProvider, loadPlanRefs, newReference, type PaymentsSettings, type PlanRef, productSlugs, recordPurchase, recordRefund, REFERENCE, rememberCheckout, startedCheckout, str, upsertMembership } from "@tansy/payments/provider";

interface DodoSettings { dodoApiKey: string; dodoWebhookSecret: string; dodoProductId: string }
const keys = (settings: PaymentsSettings) => settings as PaymentsSettings & DodoSettings;

const client = (settings: PaymentsSettings) => new DodoPayments({ bearerToken: keys(settings).dodoApiKey, environment: settings.testMode ? "test_mode" : "live_mode" });

interface DodoEvent { type: string; timestamp: string | Date; data: Record<string, unknown> }

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});

/** Every Dodo event better-auth's plugin verified. Throwing makes Dodo send it again. */
async function onEvent(context: ExtensionContext, event: DodoEvent, plans: () => Promise<PlanRef[]>) {
  const data = event.data;
  if (event.type === "payment.succeeded") {
    const metadata = record(data.metadata);
    await recordPurchase(context, { provider: "dodo", sessionId: str(metadata.ref), paymentRef: str(data.payment_id) || null, metadata, amount: Number(data.total_amount), currency: str(data.currency) });
  } else if (event.type === "refund.succeeded") {
    if (data.is_partial !== true) await recordRefund(context, { paymentRef: str(data.payment_id) });
  } else if (event.type.startsWith("subscription.")) {
    const metadata = record(data.metadata);
    // Subscriptions Payments starts carry the user's id. Others are matched by the customer's email.
    const email = str(record(data.customer).email);
    const user = str(metadata.userId) || (email ? (await context.system.users.findByEmail(email))?.id ?? null : null);
    await upsertMembership(context, {
      provider: "dodo",
      subscriptionId: str(data.subscription_id),
      user,
      productId: str(data.product_id),
      status: str(data.status),
      periodEnd: str(data.next_billing_date) || null,
      at: new Date(event.timestamp).getTime(),
    }, await plans());
  }
}

/** Dodo Payments, through better-auth's Dodo Payments plugin. Payments keeps its subscriptions as memberships. */
export const dodo = () => definePaymentProvider({
  id: "dodo",
  label: "Dodo Payments",
  webhookPath: "/dodopayments/webhooks",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: (siteUrl) => ({
    ar: { settings: {
      dodoApiKey: { label: "مفتاح API لـ Dodo Payments", description: "من Dodo Payments ← Developer ← API keys. فعّل وضع الاختبار لمفتاح اختبار." },
      dodoWebhookSecret: { label: "سرّ webhook في Dodo Payments", description: `وجّه webhook من Dodo Payments إلى ${siteUrl}/api/auth/dodopayments/webhooks، ثم الصق مفتاح التوقيع.` },
      dodoProductId: { label: "منتج Dodo Payments للمشتريات لمرة واحدة", description: "منتج لمرة واحدة مع تفعيل «ادفع ما تريد»، بعملة أسعارك. يُباع كل سجل تحته بسعره الخاص." },
    } },
  }),
  settings: (siteUrl) => [
    { name: "dodoApiKey", type: "secret", env: "DODO_PAYMENTS_API_KEY", label: "Dodo Payments API key", description: "From Dodo Payments → Developer → API keys. Turn on test mode for a test key." },
    { name: "dodoWebhookSecret", type: "secret", env: "DODO_PAYMENTS_WEBHOOK_SECRET", label: "Dodo Payments webhook secret", description: `Point a Dodo Payments webhook at ${siteUrl}/api/auth/dodopayments/webhooks, then paste its signing key.` },
    { name: "dodoProductId", type: "text", default: "", maxLength: 100, label: "Dodo Payments product for one-time purchases", description: "A one-time product with pay what you want turned on, in the currency of your prices. Each record sells under it at its own price." },
  ],
  // Dodo's checkouts take any products, prices and metadata from the caller.
  serverOnlyPaths: ["/dodopayments/checkout", "/dodopayments/checkout-session"],
  planIdProblem: (value) => (value.startsWith("pdt_") ? null : "Use a Dodo Payments product id, which starts with pdt_."),
  ready: (settings) => Boolean(keys(settings).dodoApiKey && keys(settings).dodoWebhookSecret),

  authPlugins(settings, context) {
    const plans = () => loadPlanRefs(context);
    return [dodopayments({
      client: client(settings),
      createCustomerOnSignUp: settings.createCustomerOnSignUp,
      use: [
        checkout({ products: async () => productSlugs(await plans()), authenticatedUsersOnly: true }),
        portal(),
        webhooks({ webhookKey: keys(settings).dodoWebhookSecret, onPayload: async (payload) => onEvent(context, payload as unknown as DodoEvent, plans) }),
      ],
    })];
  },

  async currencyProblem(settings, currency) {
    if (!keys(settings).dodoProductId) return "Payments → Settings needs the Dodo Payments product that one-time purchases are sold under.";
    // Dodo charges in the product's currency, so a price in another would be charged as the wrong amount.
    const product = await client(settings).products.retrieve(keys(settings).dodoProductId).catch(() => null);
    const productCurrency = str(record(product?.price).currency).toLowerCase();
    if (!product) return "The Dodo Payments product under Payments → Settings can't be found.";
    return productCurrency && productCurrency !== currency ? `This is priced in ${currency.toUpperCase()}, and the Dodo Payments product sells in ${productCurrency.toUpperCase()}.` : null;
  },

  async checkout({ context, settings, buyer, collection, recordId, amount, successUrl, cancelUrl }) {
    const ref = newReference();
    const session = await client(settings).checkoutSessions.create({
      // A pay-what-you-want product, at the record's own price.
      product_cart: [{ product_id: keys(settings).dodoProductId, quantity: 1, amount }],
      customer: { email: buyer.email, name: buyer.name || buyer.email },
      metadata: { tansy: "purchase", collection, recordId: String(recordId), userId: buyer.id, ref },
      return_url: `${successUrl}&session_id=${ref}`,
      cancel_url: cancelUrl,
    });
    await rememberCheckout(context, ref, { id: session.session_id, userId: buyer.id, collection, recordId, at: Date.now() });
    return session.checkout_url ?? cancelUrl;
  },

  isReference: (value) => REFERENCE.test(value),

  async confirm(context, settings, reference, buyer) {
    const started = await startedCheckout(context, reference);
    if (!started || started.userId !== buyer.id) return null;
    const dodo = client(settings);
    const session = await dodo.checkoutSessions.retrieve(started.id).catch(() => null);
    if (!session) return null;
    const payment = session.payment_id && session.payment_status === "succeeded" ? await dodo.payments.retrieve(session.payment_id).catch(() => null) : null;
    if (payment) await recordPurchase(context, { provider: "dodo", sessionId: reference, paymentRef: payment.payment_id, metadata: payment.metadata, amount: payment.total_amount, currency: payment.currency });
    context.auditTarget("record", `${started.collection}/${started.recordId}`, { paid: Boolean(payment) });
    return { paid: Boolean(payment) };
  },

  // better-auth's Dodo checkout sends every buyer to one fixed address, so Payments starts the session itself.
  async subscribe({ settings, buyer, plan, annual, successUrl, cancelUrl }) {
    const session = await client(settings).checkoutSessions.create({
      product_cart: [{ product_id: annual && plan.annualProductId ? plan.annualProductId : plan.productId, quantity: 1 }],
      customer: { email: buyer.email, name: buyer.name || buyer.email },
      metadata: { tansy: "subscription", userId: buyer.id },
      return_url: successUrl,
      cancel_url: cancelUrl,
    });
    return session.checkout_url ?? cancelUrl;
  },

  async billing(context) {
    const { url } = await context.auth.call<{ url: string }>("/dodopayments/customer/portal");
    return url;
  },
});
