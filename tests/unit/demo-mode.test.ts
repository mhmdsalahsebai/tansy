import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { demoLogin } from "@/core/auth/demo";
import { isSharedAccount, sharedAccounts } from "@/core/auth/shared-accounts";
import { pageWords, siteWords } from "@/core/site/words";
import { DemoBanner } from "@/components/site/DemoBanner";

const KEYS = ["TANSY_DEMO_EMAIL", "TANSY_DEMO_PASSWORD", "TANSY_SHARED_ACCOUNTS"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
const set = (values: Partial<Record<(typeof KEYS)[number], string>>) => {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
};

describe("demo mode", () => {
  it("is on only when both the demo email and password are set", () => {
    set({});
    expect(demoLogin()).toBeNull();
    set({ TANSY_DEMO_EMAIL: "demo@example.com" });
    expect(demoLogin()).toBeNull();
    set({ TANSY_DEMO_PASSWORD: "explore-the-demo" });
    expect(demoLogin()).toBeNull();
    set({ TANSY_DEMO_EMAIL: " Demo@Example.com ", TANSY_DEMO_PASSWORD: "explore-the-demo" });
    expect(demoLogin()).toEqual({ email: "demo@example.com", password: "explore-the-demo" });
  });

  it("always makes the demo login a shared account, whose details nobody signed in as it can change", () => {
    set({ TANSY_DEMO_EMAIL: "demo@example.com", TANSY_DEMO_PASSWORD: "explore-the-demo" });
    expect(isSharedAccount("DEMO@example.com")).toBe(true);
    set({ TANSY_DEMO_EMAIL: "demo@example.com", TANSY_DEMO_PASSWORD: "explore-the-demo", TANSY_SHARED_ACCOUNTS: "reviewer@example.com" });
    expect([...sharedAccounts()].sort()).toEqual(["demo@example.com", "reviewer@example.com"]);
    // Without a password there's no demo, so the address is only shared if it's listed.
    set({ TANSY_DEMO_EMAIL: "demo@example.com" });
    expect(isSharedAccount("demo@example.com")).toBe(false);
  });

  it("words the site's banner in the page's language and links it to the dashboard", () => {
    for (const locale of ["en", "ar"]) {
      const { t } = siteWords(pageWords(locale, [locale], {}));
      expect(t("cms.demo")).not.toBe("cms.demo");
      expect(t("cms.demoDashboard")).not.toBe("cms.demoDashboard");
    }
    const { t } = siteWords(pageWords("ar", ["ar"], {}));
    const html = renderToStaticMarkup(createElement(DemoBanner, { text: t("cms.demo"), link: t("cms.demoDashboard"), href: "/dashboard", direction: "rtl" }));
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain(t("cms.demoDashboard"));
  });
});
