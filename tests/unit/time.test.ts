import { describe, expect, it } from "vitest";
import { relativeTime } from "@/lib/time";

const now = Date.parse("2026-06-01T12:00:00Z");
const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();

describe("relativeTime", () => {
  it("names the largest whole unit, past and future", () => {
    expect(relativeTime(at(-10_000), now)).toBe("just now");
    expect(relativeTime(at(-5 * 60_000), now)).toBe("5 minutes ago");
    expect(relativeTime(at(2 * 3_600_000), now)).toBe("in 2 hours");
    expect(relativeTime(at(-86_400_000), now)).toBe("yesterday");
    expect(relativeTime(at(3 * 86_400_000), now)).toBe("in 3 days");
    expect(relativeTime(at(-400 * 86_400_000), now)).toBe("last year");
  });
});
