import { defineBlock, type PluginBlock, type PluginRole } from "tansy/plugin";

/** The collections the newsletter creates on first install. Owners can change all of it afterwards. */
export const SUBSCRIBERS = "newsletter-subscribers";
export const CAMPAIGNS = "newsletter-campaigns";
export const PAGE = "newsletter-page";
export const COLLECTIONS = [SUBSCRIBERS, CAMPAIGNS, PAGE] as const;

/** Where people confirm and unsubscribe, until the owner gives the page another address. */
export const PAGE_PATH = "/newsletter";

export const SUBSCRIBER_STATES = ["pending", "confirmed", "unsubscribed"] as const;
export type SubscriberState = typeof SUBSCRIBER_STATES[number];
export const CAMPAIGN_STATES = ["draft", "scheduled", "sending", "sent", "cancelled"] as const;
export type CampaignState = typeof CAMPAIGN_STATES[number];

/** A campaign's fields only the plugin writes: its progress through the list. People send, schedule and cancel from the Newsletter page. */
export const CAMPAIGN_PROGRESS = ["state", "scheduledAt", "startedAt", "finishedAt", "recipients", "sent", "failed", "cursor", "until"] as const;

/** A field the plugin's code reads or writes, by collection: the contract Extensions checks. */
export const CONTRACT = {
  [SUBSCRIBERS]: { email: "email", name: "text", state: "radio", language: "text", source: "text", confirmedAt: "datetime", unsubscribedAt: "datetime", confirmSentAt: "datetime" },
  [CAMPAIGNS]: { subject: "text", body: "rich_text", link: "url", linkLabel: "text", source: "text", state: "radio", scheduledAt: "datetime", startedAt: "datetime", finishedAt: "datetime", recipients: "number", sent: "number", failed: "number", cursor: "number", until: "number" },
  [PAGE]: { title: "text", intro: "rich_text" },
};

/** The sign-up form, on any page. */
export const SIGNUP_BLOCK: PluginBlock = defineBlock({
  name: "newsletter_signup",
  label: "Newsletter sign-up",
  labels: { ar: "الاشتراك في النشرة" },
  category: "Forms",
  defaults: { title: "Get new posts by email", askName: false },
  fields: [
    { name: "title", type: "text", config: { maxLength: 120, labels: { ar: "العنوان" } } },
    { name: "text", type: "text", config: { multiline: true, maxLength: 500, labels: { ar: "النص" } } },
    { name: "buttonLabel", type: "text", config: { maxLength: 40, description: "Subscribe when left empty.", labels: { ar: "نص الزر" }, descriptions: { ar: "«اشترك» إن تُرك فارغًا." } } },
    { name: "askName", type: "boolean", config: { description: "Ask for a name as well as the address.", labels: { ar: "اسأل عن الاسم" }, descriptions: { ar: "اسأل عن الاسم مع العنوان." } } },
  ],
});

/** Who runs the newsletter. Created once, then owners change it under Roles like any other. */
export function newsletterRoles(): PluginRole[] {
  return [{
    name: "newsletter-editor",
    label: "Newsletter editor",
    description: "Writes and sends campaigns, and looks after the subscribers.",
    permissions: ["dashboard:access", "collection:read", "file:list", "file:read", "ext.newsletter:send", "ext.newsletter:manage"],
    records: {
      [CAMPAIGNS]: ["list", "read", "create", "update", "delete"],
      [SUBSCRIBERS]: ["list", "read", "update", "delete"],
      [PAGE]: ["list", "read", "update"],
    },
  }];
}

const STATE_LABELS: Record<CampaignState, string> = { draft: "Draft", scheduled: "Scheduled", sending: "Sending", sent: "Sent", cancelled: "Cancelled" };

const LOCKED = { createRule: null, updateRule: null, deleteRule: null };
const datetime = (name: string, description?: string, hidden = false) => ({ name, type: "datetime", config: { ...(description ? { description } : {}), ...(hidden ? { hidden: true } : {}) } });
const count = (name: string, description: string, hidden = false) => ({ name, type: "number", config: { format: "integer", min: 0, description, ...(hidden ? { hidden: true } : {}) } });

export function newsletterSchema() {
  return {
    version: 1,
    collections: [
      {
        slug: SUBSCRIBERS,
        name: "Subscribers",
        description: "Who gets the newsletter. Only people with permissions on this collection see it.",
        urlPattern: null,
        // Visitors sign up, confirm and leave only through the plugin's routes.
        rules: { listRule: null, viewRule: null, ...LOCKED },
        fields: [
          { name: "email", type: "email", config: { required: true, unique: true } },
          { name: "name", type: "text", config: { maxLength: 100 } },
          { name: "state", type: "radio", config: { options: [{ label: "Waiting to confirm", value: "pending" }, { label: "Subscribed", value: "confirmed" }, { label: "Unsubscribed", value: "unsubscribed" }], defaultValue: "pending" } },
          { name: "language", type: "text", config: { maxLength: 35, description: "The language they signed up in. Their confirmation email is in it." } },
          { name: "source", type: "text", config: { maxLength: 300, description: "Where they signed up: a page, an import or the dashboard." } },
          datetime("confirmedAt"),
          datetime("unsubscribedAt"),
          // When the last confirmation email went, so a form can't be used to flood someone's inbox.
          datetime("confirmSentAt", undefined, true),
        ],
      },
      {
        slug: CAMPAIGNS,
        name: "Campaigns",
        description: "Emails to every subscriber. Write one here, then send it from the Newsletter page.",
        urlPattern: null,
        rules: { listRule: null, viewRule: null, ...LOCKED },
        fields: [
          { name: "subject", type: "text", config: { required: true, maxLength: 150 } },
          { name: "body", type: "rich_text", config: { description: "What the email says. Headings, lists, quotes and links come through." } },
          { name: "link", type: "url", config: { allowedProtocols: ["https", "http"], description: "A button under the text, such as the post this campaign is about." } },
          { name: "linkLabel", type: "text", config: { maxLength: 60, description: "The button's words. Read more when left empty." } },
          // The rest is the campaign's progress, which only the plugin writes: a hook refuses people's changes.
          { name: "source", type: "text", config: { maxLength: 200, description: "The record this campaign was made from." } },
          { name: "state", type: "radio", config: { options: CAMPAIGN_STATES.map((value) => ({ value, label: STATE_LABELS[value] })), defaultValue: "draft", description: "Send, schedule and cancel from the Newsletter page." } },
          datetime("scheduledAt", "When it starts sending, once scheduled."),
          datetime("startedAt"),
          datetime("finishedAt"),
          count("recipients", "Subscribers when sending started."),
          count("sent", "Emails delivered."),
          count("failed", "Emails the mail server or provider refused."),
          // How far through the list it is, and where the list ended when it started.
          count("cursor", "The last subscriber sent to.", true),
          count("until", "The last subscriber when sending started.", true),
        ],
      },
      {
        slug: PAGE,
        name: "Newsletter page",
        description: "Where people sign up, confirm their address and unsubscribe. Links in the newsletter's emails come here.",
        type: "singleton",
        urlPattern: PAGE_PATH,
        rules: { listRule: "", viewRule: "", ...LOCKED },
        fields: [
          { name: "title", type: "text", config: { required: true, maxLength: 120 } },
          { name: "intro", type: "rich_text", config: {} },
        ],
      },
    ],
  };
}
