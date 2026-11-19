import type { BetterAuthPlugin } from "better-auth";
import type { ExtensionContext, ExtensionRouteContext, Messages, PluginSettingField } from "tansy/plugin";
import type { PaymentsSettings, SubscriptionRecords } from "./shared";

/**
 * What a payment provider adapter implements, such as @tansy/payments-stripe. Payments
 * keeps everything providers share: plans, purchases, memberships, the price field, blocks,
 * routes and the plan user field. An adapter is the provider's better-auth plugin, plus
 * its SDK for what that plugin leaves out, such as selling a record at its stored price.
 * See docs/plugins/payments.md.
 */

export interface Buyer { id: string; email: string; name: string }

export interface CheckoutRequest {
  context: ExtensionRouteContext;
  settings: PaymentsSettings;
  buyer: Buyer;
  collection: string;
  recordId: number;
  /** What the checkout page calls it. */
  name: string;
  /** In the currency's smallest unit. */
  amount: number;
  currency: string;
  /** Where the buyer lands after paying. It already has a query string: add `&session_id=…`, which /confirm takes. */
  successUrl: string;
  cancelUrl: string;
}

export interface SubscribeRequest {
  context: ExtensionRouteContext;
  settings: PaymentsSettings;
  buyer: Buyer;
  plan: { name: string; productId: string; annualProductId?: string };
  annual: boolean;
  successUrl: string;
  cancelUrl: string;
}

export interface PaymentProvider {
  /** Lowercase letters and digits, such as "stripe". Every setting's name starts with it. */
  id: string;
  label: string;
  /** Where its better-auth plugin takes the provider's webhooks, under /api/auth. */
  webhookPath: string;
  /** Its keys and options on Payments → Settings. `siteUrl` is for telling owners the webhook address. */
  settings(siteUrl: string): PluginSettingField[];
  /**
   * Its settings' words in other interface languages, by language code, as
   * `{ ar: { settings: { <name>: { label, description } } } }`, with the same `siteUrl`.
   * Payments adds them to its own `messages`, and the setting's `label` and `description`
   * cover any language missing.
   */
  messages?(siteUrl: string): Record<string, Messages>;
  /** Its better-auth plugin's endpoints that trust what the caller sends. Payments closes them to HTTP. */
  serverOnlyPaths?: string[];
  /** Where its better-auth plugin keeps subscriptions itself, if it does. Otherwise the adapter keeps memberships with `upsertMembership`. */
  subscriptionRecords?: SubscriptionRecords;
  /** Bills a plan yearly without a yearly product, so plans need no annual id. */
  yearlyFromSamePlan?: boolean;
  /** What's wrong with a plan's product or price id, or null. */
  planIdProblem(value: string): string | null;
  /** Whether the keys it needs are set. */
  ready(settings: PaymentsSettings): boolean;
  /** Its better-auth plugin, built from the settings with Payments' context, for webhooks and customers. */
  authPlugins(settings: PaymentsSettings, context: ExtensionContext, siteUrl: string): BetterAuthPlugin[];
  /** Why records priced in this currency can't be sold, or null. */
  currencyProblem?(settings: PaymentsSettings, currency: string): Promise<string | null>;
  /** Starts a one-time checkout for one record. Returns the checkout page's address. */
  checkout(request: CheckoutRequest): Promise<string>;
  /** Whether a return address's `session_id` could be this provider's. */
  isReference(value: string): boolean;
  /** Records the checkout if it's paid and the caller's own. Null when there's no such checkout for them. */
  confirm(context: ExtensionRouteContext, settings: PaymentsSettings, reference: string, buyer: Buyer): Promise<{ paid: boolean } | null>;
  subscribe(request: SubscribeRequest): Promise<string>;
  /** The provider's billing page for the caller. */
  billing(context: ExtensionRouteContext, settings: PaymentsSettings, buyer: Buyer, returnUrl: string): Promise<string>;
}

/** Types an adapter. */
export const definePaymentProvider = (provider: PaymentProvider): PaymentProvider => provider;

export type { PaymentsSettings, PaidCheckout, MembershipUpdate, StartedCheckout, SubscriptionRecords } from "./shared";
export {
  CUSTOMERS, PLANS, PURCHASES, loadPlanRefs, newReference, recordPurchase, recordRefund, rememberCheckout, startedCheckout, str, upsertMembership,
} from "./shared";
export { REFERENCE, isUserId, membershipState, planNamed, productSlugs, toMinorUnits, fromMinorUnits, type PlanRecord, type PlanRef } from "./logic";
