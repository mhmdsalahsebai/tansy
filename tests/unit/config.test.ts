import { afterEach, describe, expect, it } from "vitest";
import { defineCms } from "@/core/auth/extensions";
import { getCmsConfig, provideCmsConfig } from "@/core/config";
import { assertConfiguredExtensions } from "@/core/extend/registry";
import { allPermissions } from "@/core/authz/permissions";
import { fieldTypeNames } from "@/core/fields/registry";
import { defineField } from "@/core/fields/define";
import { z } from "zod";

declare const globalThis: { cmsConfig?: ReturnType<typeof getCmsConfig> } & typeof global;
const original = globalThis.cmsConfig;
afterEach(() => { globalThis.cmsConfig = original; });

const field = (type: string) => defineField({ type, admin: { label: type, input: "text" }, config: {}, value: () => z.string(), storage: () => ({ sql: "text" }) });

describe("config holder", () => {
  it("refuses to run with no config, instead of acting as if there were no plugins", () => {
    globalThis.cmsConfig = undefined;
    expect(() => getCmsConfig()).toThrow(/has not been provided/);
    expect(() => allPermissions()).toThrow(/has not been provided/);
  });

  it("uses the field types of the config it was given", () => {
    provideCmsConfig(defineCms({ fields: [field("first_type")] }));
    expect(fieldTypeNames()).toContain("first_type");
    provideCmsConfig(defineCms({ fields: [field("second_type")] }));
    expect(fieldTypeNames()).toContain("second_type");
    expect(fieldTypeNames()).not.toContain("first_type");
  });

  it("still stops startup when two field types clash, now that the registry is lazy", () => {
    provideCmsConfig(defineCms({ fields: [field("clash"), field("clash")] }));
    expect(() => assertConfiguredExtensions()).toThrow(/registered twice/);
  });
});
