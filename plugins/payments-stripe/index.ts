import Stripe from "stripe";
import { stripe as stripePlugin } from "@better-auth/stripe";
import type { ExtensionContext } from "tansy/plugin";
import { CUSTOMERS, definePaymentProvider, PLANS, recordPurchase, recordRefund, str, type PaymentsSettings, type PlanRecord } from "@tansy/payments/provider";

interface StripeSettings { stripeSecretKey: string; stripeWebhookSecret: string }
const keys = (settings: PaymentsSettings) => settings as PaymentsSettings & StripeSettings;

/** A plan record as better-auth's Stripe plugin takes it. Null when it's missing what Stripe needs. */
export function toStripePlan(plan: PlanRecord) {
  const name = typeof plan.name === "string" ? plan.name.trim().toLowerCase() : "";
  const priceId = typeof plan.priceId === "string" ? plan.priceId.trim() : "";
  if (!name || !priceId) return null;
  const annual = typeof plan.annualPriceId === "string" && plan.annualPriceId.trim() ? plan.annualPriceId.trim() : undefined;
  const days = typeof plan.trialDays === "number" && Number.isInteger(plan.trialDays) && plan.trialDays > 0 ? plan.trialDays : null;
  const limits = plan.limits && typeof plan.limits === "object" && !Array.isArray(plan.limits) ? (plan.limits as Record<string, number>) : undefined;
  return {
    name,
    priceId,
    ...(annual ? { annualDiscountPriceId: annual } : {}),
    ...(limits ? { limits } : {}),
    ...(typeof plan.group === "string" && plan.group.trim() ? { group: plan.group.trim() } : {}),
    ...(days ? { freeTrial: { days } } : {}),
  };
}

/** The plans better-auth's Stripe plugin offers, from the plans collection, so owners edit them in the dashboard. */
async function loadPlans(context: ExtensionContext) {
  const { items } = await context.system.records.list(PLANS, { filter: 'status = "published"', perPage: 200, fields: "name,priceId,annualPriceId,trialDays,limits,group" });
  return items.map(toStripePlan).filter((plan) => plan !== null);
}

/** The user's Stripe customer, once better-auth's Stripe plugin has made one. */
async function customerOf(context: ExtensionContext, userId: string) {
  try {
    const { items } = await context.system.records.list(CUSTOMERS, { filter: `coreId = "${userId}"`, perPage: 1, fields: "stripeCustomerId" });
    return str(items[0]?.stripeCustomerId) || null;
  } catch {
    return null;
  }
}

const isPaid = (session: Stripe.Checkout.Session) => session.payment_status === "paid" || session.payment_status === "no_payment_required";

async function recordSession(context: ExtensionContext, session: Stripe.Checkout.Session) {
  if (session.mode !== "payment" || !isPaid(session)) return;
  await recordPurchase(context, {
    provider: "stripe",
    sessionId: session.id,
    paymentRef: typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null),
    metadata: session.metadata,
    amount: session.amount_total ?? 0,
    currency: session.currency ?? "usd",
    // Payments creates every one-time session itself, with the secret key, and better-auth's
    // Stripe plugin creates only subscription sessions, so no one else can set this metadata.
    metadataTrusted: true,
  });
}

/** Every Stripe event better-auth's plugin receives comes here too. Throwing makes Stripe send it again. */
async function onEvent(context: ExtensionContext, event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await recordSession(context, event.data.object);
      break;
    case "charge.refunded": {
      const charge = event.data.object;
      const intent = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
      if (charge.refunded && intent) await recordRefund(context, { paymentRef: intent });
      break;
    }
  }
}

/** Stripe, through better-auth's Stripe plugin, which keeps customers and subscriptions. */
export const stripe = () => definePaymentProvider({
  id: "stripe",
  label: "Stripe",
  webhookPath: "/stripe/webhook",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: (siteUrl) => ({
    ar: { settings: {
      stripeSecretKey: { label: "المفتاح السري لـ Stripe", description: "من Stripe ← Developers ← API keys. يبدأ بـ sk_. استخدم مفتاح اختبار حتى تبدأ البيع فعليًا." },
      stripeWebhookSecret: { label: "سرّ توقيع webhook في Stripe", description: `وجّه webhook من Stripe إلى ${siteUrl}/api/auth/stripe/webhook مع checkout.session.completed وcheckout.session.async_payment_succeeded وcharge.refunded وcustomer.subscription.*، ثم الصق سرّ التوقيع، الذي يبدأ بـ whsec_.` },
    } },
  }),
  settings: (siteUrl) => [
    { name: "stripeSecretKey", type: "secret", env: "STRIPE_SECRET_KEY", label: "Stripe secret key", description: "From Stripe → Developers → API keys. Starts with sk_. Use a test key until you go live." },
    { name: "stripeWebhookSecret", type: "secret", env: "STRIPE_WEBHOOK_SECRET", label: "Stripe webhook signing secret", description: `Point a Stripe webhook at ${siteUrl}/api/auth/stripe/webhook with checkout.session.completed, checkout.session.async_payment_succeeded, charge.refunded and customer.subscription.*, then paste its signing secret, which starts with whsec_.` },
  ],
  // better-auth's Stripe plugin keeps subscriptions in its own table, which core keeps as this collection.
  subscriptionRecords: { collection: "payments-subscription", user: "referenceId", plan: "plan", state: "subscriptionStatus" },
  planIdProblem: (value) => (value.startsWith("price_") ? null : "Use a Stripe price id, which starts with price_."),
  ready: (settings) => Boolean(keys(settings).stripeSecretKey && keys(settings).stripeWebhookSecret),

  authPlugins: (settings, context) => [stripePlugin({
    stripeClient: new Stripe(keys(settings).stripeSecretKey),
    stripeWebhookSecret: keys(settings).stripeWebhookSecret,
    createCustomerOnSignUp: settings.createCustomerOnSignUp,
    subscription: {
      enabled: true,
      plans: () => loadPlans(context),
      // A person manages only their own subscription. Organizations can come later.
      authorizeReference: async ({ user, referenceId }) => referenceId === user.id,
    },
    onEvent: (event) => onEvent(context, event),
  })],

  async checkout({ context, settings, buyer, collection, recordId, name, amount, currency, successUrl, cancelUrl }) {
    const metadata = { tansy: "purchase", collection, recordId: String(recordId), userId: buyer.id };
    const customer = await customerOf(context, buyer.id);
    const session = await new Stripe(keys(settings).stripeSecretKey).checkout.sessions.create({
      mode: "payment",
      line_items: [{ quantity: 1, price_data: { currency, unit_amount: amount, product_data: { name } } }],
      ...(customer ? { customer } : { customer_email: buyer.email }),
      client_reference_id: buyer.id,
      metadata,
      payment_intent_data: { metadata },
      // Stripe fills in the session id, so the page can confirm the purchase without waiting for the webhook.
      success_url: `${successUrl}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
    });
    return session.url ?? cancelUrl;
  },

  isReference: (value) => /^cs_[A-Za-z0-9_]{1,250}$/.test(value),

  async confirm(context, settings, reference, buyer) {
    // Read from Stripe with the secret key, so nothing the browser sends is trusted but the id.
    const session = await new Stripe(keys(settings).stripeSecretKey).checkout.sessions.retrieve(reference).catch(() => null);
    // Someone else's checkout reads as missing.
    if (!session || session.mode !== "payment" || session.metadata?.tansy !== "purchase" || session.metadata.userId !== buyer.id) return null;
    await recordSession(context, session);
    context.auditTarget("record", `${session.metadata.collection}/${session.metadata.recordId}`, { paid: isPaid(session) });
    return { paid: isPaid(session) };
  },

  async subscribe({ context, plan, annual, successUrl, cancelUrl }) {
    const { url } = await context.auth.call<{ url?: string }>("/subscription/upgrade", { body: { plan: plan.name, annual, successUrl, cancelUrl, returnUrl: cancelUrl, disableRedirect: true } });
    return url ?? cancelUrl;
  },

  async billing(context, _settings, _buyer, returnUrl) {
    const { url } = await context.auth.call<{ url?: string }>("/subscription/billing-portal", { body: { returnUrl, disableRedirect: true } });
    return url ?? returnUrl;
  },
});
