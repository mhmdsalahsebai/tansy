import { definePlugin } from "tansy/plugin";

/**
 * Example of `emailContent`: wording that editors change in the dashboard. Create
 * a collection with this slug and text fields `kind`, `subject` and `body`, then
 * publish a record for each email to override. {{appName}} is replaced. Links and
 * codes are always added by the CMS, so a template can't lose them.
 */
export const emailTemplates = (slug = "email-templates") => definePlugin({
  name: "email-templates",
  version: "0.1.1",
  apiVersion: 1,
  auth: {
    emailContent: async ({ kind, appName }, { system }) => {
      const { items } = await system.records.list(slug, { filter: `kind = "${kind}" && status = "published"`, perPage: 1, skipTotal: "true" });
      const fill = (value: unknown) => (typeof value === "string" && value.trim() ? value.replaceAll("{{appName}}", appName) : undefined);
      const [template] = items;
      return template ? { subject: fill(template.subject), body: fill(template.body) } : undefined;
    },
  },
});
