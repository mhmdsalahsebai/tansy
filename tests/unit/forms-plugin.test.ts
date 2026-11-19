import { describe, expect, it } from "vitest";
import { assertPluginManifest } from "@/core/extend/manifest";
import { forms } from "../../plugins/forms/index";
import { check, duplicateNames, fieldsOf, issueToken, notification, pageOf, recipients, tokenProblem, type FormField } from "../../plugins/forms/logic";
import { CONTRACT, formsSchema } from "../../plugins/forms/schema";

const block = (type: string, value: Record<string, unknown>) => ({ id: `${type}-${String(value.name)}`, type, v: 1, value });

const STREAM = [
  block("forms_text", { name: "name", label: "Name", required: true }),
  block("forms_email", { name: "email", label: "Email", required: true }),
  block("forms_select", { name: "topic", label: "Topic", options: "Sales\nSupport\n\nSales" }),
  block("forms_textarea", { name: "message", label: "Message", required: true, maxLength: 20 }),
  block("forms_checkbox", { name: "consent", label: "You may contact me", required: true }),
  block("forms_number", { name: "seats", label: "Seats", min: 1, max: 10 }),
];

describe("forms plugin manifest", () => {
  it("validates, owns its blocks, and keeps submissions locked to staff", () => {
    const plugin = forms({ notify: "owner@example.com" });
    expect(() => assertPluginManifest(plugin)).not.toThrow();
    expect(plugin.blocks?.every((item) => item.name.startsWith("forms_"))).toBe(true);
    const [form, submissions] = formsSchema().collections;
    expect(submissions.rules).toEqual({ listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null });
    // Visitors may open a published form, never list them, and never write.
    expect(form.rules).toEqual({ listRule: null, viewRule: 'status = "published"', createRule: null, updateRule: null, deleteRule: null });
    expect(form.fields.find((field) => field.name === "notify")?.config).toMatchObject({ hidden: true });
    for (const [slug, fields] of Object.entries(CONTRACT)) {
      const collection = formsSchema().collections.find((item) => item.slug === slug)!;
      for (const [name, type] of Object.entries(fields)) expect(collection.fields.find((field) => field.name === name)?.type).toBe(type);
    }
  });

  it("serves only public routes for visitors, rate limits submissions and audits them", () => {
    const routes = forms().routes!;
    const submit = routes.find((route) => route.path === "/forms/:id/submit")!;
    expect(submit).toMatchObject({ method: "POST", access: "public", audit: "forms.submit", rateLimit: { window: 600, max: 5 } });
    expect(routes.find((route) => route.path === "/status")).toMatchObject({ access: "permission", permission: "dashboard:access" });
  });

  it("refuses bad options", () => {
    expect(() => forms({ notify: "x".repeat(1001) })).toThrow();
    expect(() => forms({ other: true } as never)).toThrow();
  });
});

describe("form fields", () => {
  it("reads the fields from the stream, public parts only", () => {
    const fields = fieldsOf(STREAM);
    expect(fields.map((field) => [field.kind, field.name])).toEqual([["text", "name"], ["email", "email"], ["select", "topic"], ["textarea", "message"], ["checkbox", "consent"], ["number", "seats"]]);
    expect(fields[2].options).toEqual(["Sales", "Support"]);
    expect(fields[0].maxLength).toBe(200);
    expect(fields[5]).toMatchObject({ min: 1, max: 10 });
  });

  it("skips other blocks, bad names and a second field with the same name", () => {
    const fields = fieldsOf([...STREAM, block("blog_text", { name: "x" }), block("forms_text", { name: "Bad Name", label: "?" }), block("forms_text", { name: "email", label: "Again" })]);
    expect(fields).toHaveLength(6);
    expect(duplicateNames([...STREAM, block("forms_text", { name: "email", label: "Again" })])).toEqual(["email"]);
    expect(fieldsOf("nope")).toEqual([]);
  });

  it("keeps labels and help to one line", () => {
    const [field] = fieldsOf([block("forms_text", { name: "a", label: "Line\r\nBcc: x", help: "One\ttwo" })]);
    expect([field.label, field.help]).toEqual(["Line Bcc: x", "One two"]);
  });
});

describe("checking answers", () => {
  const fields = fieldsOf(STREAM);
  const good = { name: "Ada", email: "ada@example.com", topic: "Support", message: "Hello\r\nthere", consent: true, seats: "3" };

  it("keeps what the form asks, in its own types, and finds the reply-to address", () => {
    const { data, errors, replyTo } = check(fields, { ...good, isAdmin: true, extra: "dropped" });
    expect(errors).toEqual({});
    expect(data).toEqual({ name: "Ada", email: "ada@example.com", topic: "Support", message: "Hello\nthere", consent: true, seats: 3 });
    expect(replyTo).toBe("ada@example.com");
  });

  it("says what's wrong with each field", () => {
    const { errors } = check(fields, { name: " ", email: "not an address", topic: "Hacking", message: "x".repeat(21), consent: false, seats: 11 });
    expect(errors).toEqual({
      name: "Fill in this field.",
      email: "Enter an email address.",
      topic: "Choose one of the options.",
      message: "Keep it under 21 characters.",
      consent: "Tick this box to send.",
      seats: "Enter 10 or less.",
    });
  });

  it("refuses objects and keeps line breaks out of short answers", () => {
    expect(check(fields, { ...good, name: { $ne: 1 } }).errors.name).toBe("Enter text.");
    expect(check(fields, { ...good, name: "Ada\r\nBcc: x@example.com" }).data.name).toBe("Ada Bcc: x@example.com");
    expect(check(fields, { ...good, email: "a@example.com\nb@example.com" }).errors.email).toBe("Enter an email address.");
  });

  it("leaves out empty optional fields", () => {
    const { data } = check(fields, { ...good, topic: "", seats: "" });
    expect(data).not.toHaveProperty("topic");
    expect(data).not.toHaveProperty("seats");
  });
});

describe("notifications", () => {
  const fields: FormField[] = fieldsOf(STREAM);

  it("goes to the form's addresses, else the settings', at most ten, each checked", () => {
    expect(recipients("a@example.com, b@example.com", "c@example.com")).toEqual(["a@example.com", "b@example.com"]);
    expect(recipients("", "c@example.com")).toEqual(["c@example.com"]);
    expect(recipients("not an address\nBcc: x", "")).toEqual([]);
    expect(recipients(Array.from({ length: 12 }, (_, i) => `p${i}@example.com`).join(","), "")).toHaveLength(10);
  });

  it("lists each question and answer as plain text, with a one-line subject", () => {
    const { subject, body } = notification("Contact\r\nBcc: x@example.com", fields, { name: "Ada", consent: true, message: "<script>hi</script>" }, "/contact");
    expect(subject).toBe("New submission: Contact Bcc: x@example.com");
    expect(body).toContain('Someone filled in "Contact Bcc: x@example.com" on /contact.');
    expect(body).toContain("Name\nAda");
    expect(body).toContain("You may contact me\nYes");
    expect(body).toContain("<script>hi</script>");
  });

  it("keeps only a site path as the page", () => {
    expect(pageOf("/contact?x=1")).toBe("/contact?x=1");
    expect(pageOf("https://evil.example/")).toBe("");
    expect(pageOf("//evil.example/")).toBe("");
  });
});

describe("form tokens", () => {
  const key = "k".repeat(64);
  const now = 1_800_000_000_000;

  it("must be ours, for this form, and old enough", async () => {
    const token = await issueToken(key, 7, now);
    expect(await tokenProblem(key, 7, token, 3, now + 5000)).toBe("ok");
    expect(await tokenProblem(key, 7, token, 3, now + 1000)).toBe("early");
    expect(await tokenProblem(key, 8, token, 3, now + 5000)).toBe("invalid");
    expect(await tokenProblem("other".repeat(13), 7, token, 3, now + 5000)).toBe("invalid");
    expect(await tokenProblem(key, 7, token, 3, now + 2 * 86_400_000)).toBe("expired");
    expect(await tokenProblem(key, 7, `${now - 10_000}.${token.split(".")[1]}`, 3, now)).toBe("invalid");
    expect(await tokenProblem(key, 7, "garbage", 3, now)).toBe("invalid");
    expect(await tokenProblem(key, 7, token, 0, now)).toBe("ok");
  });
});
