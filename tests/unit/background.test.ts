import { describe, expect, it } from "vitest";
import { backgroundBudgetMs, backgroundMode } from "@/core/background/mode";
import { assertBackgroundCaller } from "@/core/background/endpoint";

describe("how background work starts", () => {
  it("runs on timers unless the host stops functions between requests, or it's set", () => {
    expect(backgroundMode({})).toBe("timers");
    expect(backgroundMode({ VERCEL: "1" })).toBe("external");
    expect(backgroundMode({ AWS_LAMBDA_FUNCTION_NAME: "cms" })).toBe("external");
    expect(backgroundMode({ VERCEL: "1", TANSY_BACKGROUND: "timers" })).toBe("timers");
    expect(backgroundMode({ TANSY_BACKGROUND: " External " })).toBe("external");
    expect(() => backgroundMode({ TANSY_BACKGROUND: "cron" })).toThrow(/timers/);
  });

  it("works for four minutes a call unless told otherwise, within sane bounds", () => {
    expect(backgroundBudgetMs({})).toBe(240_000);
    expect(backgroundBudgetMs({ TANSY_BACKGROUND_SECONDS: "55" })).toBe(55_000);
    expect(backgroundBudgetMs({ TANSY_BACKGROUND_SECONDS: "2" })).toBe(240_000);
    expect(backgroundBudgetMs({ TANSY_BACKGROUND_SECONDS: "nope" })).toBe(240_000);
  });
});

describe("the background endpoint's caller", () => {
  const env = { CRON_SECRET: "a-long-enough-secret" };

  it("must send the secret as a bearer token", () => {
    expect(() => assertBackgroundCaller("Bearer a-long-enough-secret", env)).not.toThrow();
    expect(() => assertBackgroundCaller("Bearer a-long-enough-secreT", env)).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => assertBackgroundCaller("a-long-enough-secret", env)).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => assertBackgroundCaller(null, env)).toThrow(expect.objectContaining({ status: 401 }));
  });

  it("refuses everyone until a long enough secret is set", () => {
    expect(() => assertBackgroundCaller("Bearer ", {})).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => assertBackgroundCaller("Bearer short", { CRON_SECRET: "short" })).toThrow(expect.objectContaining({ status: 503 }));
  });
});

describe("a pass shared across scope values", async () => {
  const { shareOf } = await import("@/core/extend/jobs");
  const pass = (left: number, now: number) => ({ deadline: now + left, timeLeft: () => left });

  it("gives each value an even share of what's left, but never less than a long job needs", () => {
    const now = 1_000_000;
    expect(shareOf(pass(240_000, now), 2, now).deadline).toBe(now + 120_000);
    expect(shareOf(pass(240_000, now), 10, now).deadline).toBe(now + 90_000);
    expect(shareOf(pass(60_000, now), 10, now).deadline).toBe(now + 60_000);
    expect(shareOf(pass(240_000, now), 1, now).deadline).toBe(now + 240_000);
    expect(shareOf({ deadline: null, timeLeft: () => Infinity }, 5, now).deadline).toBeNull();
  });
});
