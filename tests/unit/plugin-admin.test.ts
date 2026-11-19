import { describe, expect, it } from "vitest";
import type { PluginSettingField } from "@/core/extend/define";
import { hasParams, matchPagePath, navIcon } from "@/core/extend/admin-paths";
import { assertPluginManifest } from "@/core/extend/manifest";
import { resolveSettings, settingsProblem, settingsSchema } from "@/core/extend/settings-schema";
import { PLUGIN_API_VERSION } from "@/core/extend/define";

describe("plugin page paths", () => {
  it("match :name segments one part at a time", () => {
    expect(matchPagePath("lms/courses/:id", "lms/courses/12")).toEqual({ id: "12" });
    expect(matchPagePath("lms/courses/:id", "lms/courses")).toBeNull();
    expect(matchPagePath("lms/courses/:id", "lms/courses/12/edit")).toBeNull();
    expect(matchPagePath("lms/courses", "lms/courses")).toEqual({});
    expect(matchPagePath("lms/courses", "blog/courses")).toBeNull();
    expect(hasParams("lms/courses/:id")).toBe(true);
    expect(hasParams("lms/courses")).toBe(false);
  });
});

const fields: PluginSettingField[] = [
  { name: "passingScore", type: "number", integer: true, min: 0, max: 100, default: 70, label: "Passing score" },
  { name: "certificates", type: "boolean", default: true, label: "Certificates" },
  { name: "mode", type: "select", default: "a", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], label: "Mode" },
  { name: "notify", type: "text", default: "", maxLength: 10, label: "Notify" },
];

describe("plugin settings", () => {
  it("use saved values that still fit, and defaults for the rest", () => {
    expect(resolveSettings(fields, null)).toEqual({ passingScore: 70, certificates: true, mode: "a", notify: "" });
    expect(resolveSettings(fields, { passingScore: 80, mode: "b", stale: 1 })).toEqual({ passingScore: 80, certificates: true, mode: "b", notify: "" });
    // A limit that tightened after a value was saved falls back instead of failing.
    expect(resolveSettings(fields, { passingScore: 150, mode: "gone", notify: "far too long a value" })).toEqual({ passingScore: 70, certificates: true, mode: "a", notify: "" });
  });

  it("validate a whole set, and refuse names that aren't declared", () => {
    expect(settingsSchema(fields).safeParse({ passingScore: 50, certificates: false, mode: "b", notify: "x" }).success).toBe(true);
    expect(settingsSchema(fields).safeParse({ passingScore: 50.5, certificates: false, mode: "b", notify: "x" }).success).toBe(false);
    expect(settingsSchema(fields).safeParse({ passingScore: 50, certificates: false, mode: "c", notify: "x" }).success).toBe(false);
    expect(settingsSchema(fields).safeParse({ passingScore: 50, certificates: false, mode: "b", notify: "x", extra: 1 }).success).toBe(false);
  });

  it("stop startup on a bad declaration", () => {
    expect(settingsProblem(fields)).toBeNull();
    expect(settingsProblem([...fields, fields[0]])).toMatch(/twice/);
    expect(settingsProblem([{ ...fields[0], name: "Bad name" } as PluginSettingField])).toMatch(/name/);
    expect(settingsProblem([{ ...fields[0], default: 500 } as PluginSettingField])).toMatch(/default/);
    expect(settingsProblem([{ name: "mode", type: "select", default: "a", options: [], label: "Mode" }])).toMatch(/options/);
    const plugin = { name: "acme", version: "1.0.0", apiVersion: PLUGIN_API_VERSION };
    expect(() => assertPluginManifest({ ...plugin, settings: { fields } })).not.toThrow();
    expect(() => assertPluginManifest({ ...plugin, settings: { fields: [{ ...fields[1], default: "yes" } as unknown as PluginSettingField] } })).toThrow(/Plugin "acme": setting "certificates"/);
  });
});

describe("plugin section icons", () => {
  it("take a built-in name, or the plugin's own path data", () => {
    expect(navIcon("academic")).toBe("academic");
    expect(navIcon({ paths: ["M0 0h16v16H0Z"], fillRule: "evenodd" })).toEqual({ paths: ["M0 0h16v16H0Z"], viewBox: "0 0 16 16", fillRule: "evenodd" });
    expect(navIcon({ paths: ["M0 0L24 24"], viewBox: "0 0 24 24" })).toMatchObject({ viewBox: "0 0 24 24", fillRule: "nonzero" });
  });

  it("ignore anything that isn't plain path data, so the default shows", () => {
    for (const icon of ["Bad Name", { paths: [] }, { paths: ['M0 0" onload="x'] }, { paths: ["<script>"] }, { paths: ["M0 0"], viewBox: "0 0 16 16; x" }, { paths: Array(9).fill("M0 0") }, 42, null]) {
      expect(navIcon(icon), JSON.stringify(icon)).toBeUndefined();
    }
  });
});
