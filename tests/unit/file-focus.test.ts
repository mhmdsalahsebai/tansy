import { describe, expect, it } from "vitest";
import { CENTRE, clampPercent, fileFocusOf, focusCrop, focusKeyPart, objectPosition } from "@/core/files/focus";

/**
 * An image's focal point: the part a thumbnail keeps when it has to crop. The same two helpers
 * decide the server's crop and a theme's `object-position`, so the browser and the thumbnail
 * can't disagree.
 */

describe("a file's focal point", () => {
  it("is null until both percentages are set, and is kept in range", () => {
    expect(fileFocusOf({ focusX: null, focusY: null })).toBeNull();
    expect(fileFocusOf({ focusX: 30, focusY: null })).toBeNull();
    expect(fileFocusOf({ focusX: 30, focusY: 70 })).toEqual({ x: 30, y: 70 });
    expect(fileFocusOf({ focusX: -10, focusY: 400 })).toEqual({ x: 0, y: 100 });
    expect(clampPercent(50.4)).toBe(50);
  });

  it("reads as CSS, and as part of a thumbnail's key so a new point can't serve the old crop", () => {
    expect(objectPosition(null)).toBe("50% 50%");
    expect(objectPosition({ x: 30, y: 70 })).toBe("30% 70%");
    expect(objectPosition(CENTRE)).toBe("50% 50%");
    expect(focusKeyPart(null)).toBe("");
    expect(focusKeyPart({ x: 30, y: 70 })).toBe("@30-70");
  });
});

describe("the crop a focal point asks for", () => {
  const wide = { width: 1000, height: 500 };
  const square = { width: 300, height: 300 };

  it("takes the largest part with the thumbnail's proportions", () => {
    // A square thumbnail of a wide picture keeps its full height.
    expect(focusCrop(wide, square, null)).toEqual({ left: 250, top: 0, width: 500, height: 500 });
    // A wide thumbnail of a tall picture keeps its full width.
    expect(focusCrop({ width: 400, height: 1200 }, { width: 800, height: 400 }, null)).toEqual({ left: 0, top: 500, width: 400, height: 200 });
  });

  it("centres that part on the focal point", () => {
    expect(focusCrop(wide, square, { x: 20, y: 50 })).toEqual({ left: 0, top: 0, width: 500, height: 500 });
    expect(focusCrop(wide, square, { x: 50, y: 50 })).toEqual({ left: 250, top: 0, width: 500, height: 500 });
    expect(focusCrop({ width: 500, height: 1000 }, square, { x: 50, y: 10 })).toEqual({ left: 0, top: 0, width: 500, height: 500 });
    expect(focusCrop({ width: 500, height: 1000 }, square, { x: 50, y: 40 })).toEqual({ left: 0, top: 150, width: 500, height: 500 });
  });

  it("never leaves the picture, whatever the point", () => {
    for (const x of [0, 1, 49, 50, 99, 100]) {
      for (const y of [0, 33, 100]) {
        const crop = focusCrop(wide, square, { x, y });
        expect(crop.left).toBeGreaterThanOrEqual(0);
        expect(crop.top).toBeGreaterThanOrEqual(0);
        expect(crop.left + crop.width).toBeLessThanOrEqual(wide.width);
        expect(crop.top + crop.height).toBeLessThanOrEqual(wide.height);
      }
    }
  });

  it("asks for at least one pixel from a picture smaller than the thumbnail", () => {
    const crop = focusCrop({ width: 10, height: 4 }, { width: 800, height: 400 }, { x: 90, y: 90 });
    expect(crop.width).toBeGreaterThan(0);
    expect(crop.height).toBeGreaterThan(0);
    expect(crop.left + crop.width).toBeLessThanOrEqual(10);
  });
});
