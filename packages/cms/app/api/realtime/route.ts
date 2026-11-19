import { z } from "zod";
import { route } from "../../../core/authz/guard";
import { decideRecord, loadRuleLookups } from "../../../core/authz/records";
import { allCollections, ruleRequest } from "../../../core/content/access";
import { connect, setSubscriptions } from "../../../core/realtime/clients";

export const GET = route(
  { access: "public", reason: "Opens an empty event stream. Nothing is sent until a subscription passes the record rules.", apiKey: true },
  async ({ request }) => connect(request.signal),
);

const body = z.object({
  clientId: z.string().min(1).max(64),
  subscriptions: z.array(z.string().max(2048)).max(200).default([]),
});

export const POST = route(
  { access: "rules", apiKey: true, body, audit: "realtime.subscribe" },
  async ({ body, principal, request, auditTarget }) => {
    const req = ruleRequest(request, {}, {}, await loadRuleLookups(await allCollections()));
    // Refuses locked topics up front. Every event is then checked against the rule when it's sent.
    await setSubscriptions(body.clientId, body.subscriptions, principal, request.headers, (collection, action) => decideRecord(principal, collection, action, {}, req) !== "locked");
    auditTarget("realtime", body.clientId.slice(0, 8), { topics: body.subscriptions.length });
    return null;
  },
);
