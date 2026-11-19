import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../../packages/cms/core/http/errors";
import { ScopeError } from "../../packages/cms/core/scope/plugin";

vi.mock("server-only", () => ({}));

describe("HttpError", () => {
  it("is recognised from another copy of its module, as plugins' are in development", async () => {
    vi.resetModules();
    const copy = await import("../../packages/cms/core/http/errors?copy" as string) as typeof import("../../packages/cms/core/http/errors");
    const thrown = new copy.HttpError(409, "ALREADY_MEMBER", "Already a member.");
    expect(copy.HttpError).not.toBe(HttpError);
    expect(thrown instanceof HttpError).toBe(true);
  });

  it("keeps subclasses to their own instances, and refuses look-alikes", () => {
    expect(new HttpError(400, "X", "x") instanceof ScopeError).toBe(false);
    expect(new ScopeError("x") instanceof HttpError).toBe(true);
    expect(Object.assign(new Error("x"), { status: 400, code: "X" }) instanceof HttpError).toBe(false);
    expect((null as unknown) instanceof HttpError).toBe(false);
  });
});
