import { defineRenderers, pickWords, type BlockProps, type SiteWords } from "tansy/react";
import { BillingButton, BuyButton, SubscribeButton } from "./react";
import { siteMessages } from "./site-messages";
import "./payments.css";

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const forParts = (words: SiteWords | undefined) => (words ? pickWords(words, "payments") : undefined);

function Buy({ value, words }: BlockProps) {
  const collection = text(value.collection);
  const id = typeof value.record === "number" ? value.record : null;
  if (!collection || !id) return null;
  return <BuyButton collection={collection} id={id} label={text(value.label) || undefined} words={forParts(words)} />;
}

function Subscribe({ value, words }: BlockProps) {
  const plan = text(value.plan);
  if (!plan) return null;
  return <SubscribeButton plan={plan} annual={value.annual === true} label={text(value.label) || undefined} words={forParts(words)} />;
}

const Billing = ({ value, words }: BlockProps) => <BillingButton label={text(value.label) || undefined} words={forParts(words)} />;

export default defineRenderers({
  messages: siteMessages,
  blocks: { payments_buy: Buy, payments_subscribe: Subscribe, payments_billing: Billing },
});
