"use client";

import { createContext, useContext, useMemo, useState } from "react";

export interface EditorSelection {
  /** The selected block, at any depth. */
  selected: string | null;
  select: (id: string | null) => void;
  /** Where the selected block's settings render. Null outside the record editor, so they show under the block instead. */
  inspector: HTMLElement | null;
  /** Brings the settings sidebar into view, where it can be hidden. */
  showSettings?: () => void;
}

export const EditorSelectionContext = createContext<EditorSelection | null>(null);

export const useEditorSelection = () => useContext(EditorSelectionContext);

/** One selection shared by every stream on a page and the sidebar that shows its settings. */
export function useSelectionState(inspector: HTMLElement | null, onChange?: (id: string | null) => void, showSettings?: () => void): EditorSelection {
  const [selected, setSelected] = useState<string | null>(null);
  return useMemo(() => ({
    selected,
    inspector,
    showSettings,
    // Focus events bubble from inner blocks to outer ones, so the last call, the innermost block, wins.
    select: (id) => {
      setSelected(id);
      if (id !== selected) onChange?.(id);
    },
  }), [selected, inspector, onChange, showSettings]);
}

const ToolbarSlot = createContext<HTMLElement | null>(null);

/** The selected block's toolbar, where its rich text puts formatting buttons, as one toolbar per block reads better than two. */
export const ToolbarSlotProvider = ToolbarSlot.Provider;
export const useToolbarSlot = () => useContext(ToolbarSlot);

export const blockElement = (id: string | null) => (id ? document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`) : null);

/** Scrolls a block into view and moves focus to it. */
export function revealBlock(id: string) {
  const element = blockElement(id);
  if (!element) return;
  element.scrollIntoView({ block: "center", behavior: "smooth" });
  element.focus({ preventScroll: true });
}

const TYPABLE = "input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=true]";

/** Focuses the first thing a person can type into inside an element, waiting for editors that mount late. */
export function focusFirstInput(element: HTMLElement | null, { canvasOnly = true, attempts = 10 } = {}) {
  if (!element) return;
  const selector = canvasOnly ? TYPABLE.split(", ").map((part) => `[data-canvas-field] ${part}`).join(", ") : TYPABLE;
  const target = element.querySelector<HTMLElement>(selector);
  if (target) {
    target.focus();
    placeCaretAtEnd(target);
    return;
  }
  if (attempts > 0) requestAnimationFrame(() => focusFirstInput(element, { canvasOnly, attempts: attempts - 1 }));
  else element.focus();
}

function placeCaretAtEnd(target: HTMLElement) {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    try { target.setSelectionRange(target.value.length, target.value.length); } catch { /* Some input types have no caret. */ }
    return;
  }
  if (!target.isContentEditable) return;
  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
