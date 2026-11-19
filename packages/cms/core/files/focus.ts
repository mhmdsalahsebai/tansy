/**
 * An image's focal point: where its subject is, so a thumbnail that has to crop keeps that
 * point instead of the middle. Whole percentages from the left and from the top, which survive
 * any resize, so the same point works for every thumbnail size and for a replaced picture.
 *
 * No server-only import here: the dashboard's picker and a theme's `object-position` use the
 * same two helpers as the thumbnail renderer, so they can't disagree about what 30/70 means.
 */

export interface FileFocus {
  x: number;
  y: number;
}

export const CENTRE: FileFocus = { x: 50, y: 50 };

export type FocusedFile = { focusX: number | null; focusY: number | null };

/** The file's focal point, or null when it has none, which means the middle. */
export function fileFocusOf(file: FocusedFile): FileFocus | null {
  if (file.focusX === null || file.focusY === null) return null;
  return { x: clampPercent(file.focusX), y: clampPercent(file.focusY) };
}

export const clampPercent = (value: number) => Math.min(100, Math.max(0, Math.round(value)));

/** Ready for CSS `object-position`, so a theme crops in the browser the way a thumbnail does. */
export const objectPosition = (focus: FileFocus | null) => {
  const { x, y } = focus ?? CENTRE;
  return `${x}% ${y}%`;
};

/** Part of a thumbnail's key, so changing the focal point can't serve the old crop. Empty for none. */
export const focusKeyPart = (focus: FileFocus | null) => (focus ? `@${focus.x}-${focus.y}` : "");

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The largest part of `source` with `target`'s proportions, centred on the focal point and kept
 * inside the picture. Cropping to proportions and then resizing is what "cover" does; doing the
 * crop here is what lets the focal point decide which part survives.
 */
export function focusCrop(source: { width: number; height: number }, target: { width: number; height: number }, focus: FileFocus | null): CropRect {
  const aspect = target.width / target.height;
  let width = source.width;
  let height = Math.round(width / aspect);
  if (height > source.height) {
    height = source.height;
    width = Math.min(source.width, Math.round(height * aspect));
  }
  width = Math.max(1, Math.min(width, source.width));
  height = Math.max(1, Math.min(height, source.height));
  const centre = focus ?? CENTRE;
  const place = (percent: number, span: number, whole: number) => Math.min(Math.max(Math.round((percent / 100) * whole - span / 2), 0), whole - span);
  return { left: place(centre.x, width, source.width), top: place(centre.y, height, source.height), width, height };
}
