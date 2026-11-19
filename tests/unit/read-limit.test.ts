import { describe, expect, it } from "vitest";
import { consumeReadLimit } from "@/core/http/read-limit";

describe("consumeReadLimit", () => {
  it("allows up to the maximum in a window, then refuses", () => {
    const allowed = Array.from({ length: 5 }, () => consumeReadLimit("a", 60, 3, 1000));
    expect(allowed).toEqual([true, true, true, false, false]);
  });
  it("opens a new window once the old one has passed", () => {
    expect(consumeReadLimit("b", 1, 1, 1000)).toBe(true);
    expect(consumeReadLimit("b", 1, 1, 1500)).toBe(false);
    expect(consumeReadLimit("b", 1, 1, 2000)).toBe(true);
  });
  it("counts each caller separately", () => {
    expect(consumeReadLimit("c", 60, 1, 1000)).toBe(true);
    expect(consumeReadLimit("d", 60, 1, 1000)).toBe(true);
    expect(consumeReadLimit("c", 60, 1, 1000)).toBe(false);
  });
});
