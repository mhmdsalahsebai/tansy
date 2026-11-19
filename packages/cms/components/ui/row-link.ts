"use client";

import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";

/** Clicks on these do their own thing, so the row leaves them alone. Mark any other element with `data-no-open`. */
const CONTROLS = "a, button, input, select, textarea, label, summary, [data-no-open]";

/**
 * Makes a whole table row open its page, as its title link does. A click on a control,
 * or one that ends a text selection, is left alone. Ctrl or ⌘ opens a new tab.
 * Give the row the `cms-row-link` class, and keep a real link in it for keyboards.
 */
export function useRowLink() {
  const router = useRouter();
  return (href: string) => (event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if ((event.target as HTMLElement).closest(CONTROLS)) return;
    if (window.getSelection()?.toString()) return;
    if (event.metaKey || event.ctrlKey) window.open(href, "_blank", "noopener");
    else router.push(href);
  };
}
