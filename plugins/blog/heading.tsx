import { createElement, type ReactNode } from "react";
import { headingTag } from "./text";

/** A heading at `level`, kept between h2 and h6, for the parts whose level the theme sets. No hooks, so server and client parts share it. */
export function Heading({ level, id, className, children }: { level?: number; id?: string; className: string; children: ReactNode }) {
  return createElement(headingTag(level), { id, className }, children);
}
