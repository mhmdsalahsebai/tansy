"use client";

import { MagnifyingGlassIcon } from "@heroicons/react/16/solid";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/utils";
import { BLOCK_ICONS } from "../blocks/block-icons";
import type { BlockLayoutInfo, BlockTypeInfo } from "../fields/types";
import { matchesQuery } from "./stream-ops";
import { usePluginWord, useSchemaText, useT } from "../i18n";

const RECENT_KEY = "tansy:recent-blocks";
const RECENT_MAX = 6;

function readRecent(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function rememberRecent(name: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([name, ...readRecent().filter((item) => item !== name)].slice(0, RECENT_MAX)));
  } catch { /* Private windows can refuse storage. Recents are only a convenience. */ }
}

type Choice = { key: string; kind: "type"; type: BlockTypeInfo } | { key: string; kind: "layout"; layout: BlockLayoutInfo };

interface Props {
  types: BlockTypeInfo[];
  layouts?: BlockLayoutInfo[];
  initialQuery?: string;
  onPickType: (type: BlockTypeInfo) => void;
  onPickLayout?: (layout: BlockLayoutInfo) => void;
  onClose: () => void;
  /** Opens upward when there's no room below. */
  align?: "start" | "center";
}

/** Choosing a block: search, recently used, then each category, then saved layouts. Arrow keys move, Enter adds and Escape closes. */
export default function Inserter({ types, layouts = [], initialQuery = "", onPickType, onPickLayout, onClose, align = "start" }: Props) {
  const { t } = useT();
  const schemaText = useSchemaText();
  const word = usePluginWord();
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const [recent] = useState(readRecent);
  const [above, setAbove] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [onClose]);

  useEffect(() => {
    const box = panel.current?.getBoundingClientRect();
    if (box && box.bottom > window.innerHeight - 8 && box.top - box.height > 80) setAbove(true);
  }, []);

  const sections = useMemo(() => {
    const matching = types.filter((type) => matchesQuery(type, query));
    const result: Array<{ title: string; choices: Choice[] }> = [];
    if (!query) {
      const recentTypes = recent.flatMap((name) => types.filter((type) => type.name === name));
      if (recentTypes.length && types.length > RECENT_MAX) result.push({ title: t("stream.inserter.recent"), choices: recentTypes.map((type) => ({ key: `recent:${type.name}`, kind: "type", type })) });
    }
    const categories = [...new Set(matching.map((type) => type.category ?? ""))];
    // A category is a plugin's word, from its messages under `categories`.
    const categoryTitle = (category: string) => {
      const plugin = matching.find((type) => type.category === category && type.managedBy)?.managedBy;
      return plugin ? word(plugin, `categories.${category}`, category) : category;
    };
    for (const category of categories) {
      result.push({ title: (category && categoryTitle(category)) || (categories.length > 1 ? t("stream.inserter.other") : t("stream.inserter.blocks")), choices: matching.filter((type) => (type.category ?? "") === category).map((type) => ({ key: `type:${type.name}`, kind: "type", type })) });
    }
    const matchingLayouts = layouts.filter((layout) => layout.name.toLowerCase().includes(query.toLowerCase()));
    if (onPickLayout && matchingLayouts.length) result.push({ title: t("stream.inserter.layouts"), choices: matchingLayouts.map((layout) => ({ key: `layout:${layout.id}`, kind: "layout", layout })) });
    return result;
  }, [types, layouts, query, recent, onPickLayout, t, word]);

  const flat = sections.flatMap((section) => section.choices);
  const current = Math.min(active, Math.max(flat.length - 1, 0));

  const pick = (choice: Choice | undefined) => {
    if (!choice) return;
    if (choice.kind === "type") {
      rememberRecent(choice.type.name);
      onPickType(choice.type);
    } else onPickLayout?.(choice.layout);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    // Left and right stay in the search box, where they move the caret.
    if (step !== undefined && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.target !== event.currentTarget.querySelector("input"))) {
      event.preventDefault();
      setActive((current + step + flat.length) % Math.max(flat.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(flat[current]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "Tab") {
      onClose();
    }
  };

  useEffect(() => {
    panel.current?.querySelector(`[data-choice-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  let index = -1;
  return (
    <div ref={panel} className={cn("cms-inserter", above && "cms-inserter-above", align === "center" && "cms-inserter-center")} role="dialog" aria-label={t("stream.inserter.dialog")} onKeyDown={onKeyDown}>
      <div className="cms-inserter-search">
        <MagnifyingGlassIcon className="cms-icon cms-faint" aria-hidden="true" />
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={flat[current] ? `${listId}-${current}` : undefined}
          aria-label={t("stream.inserter.search")}
          placeholder={t("stream.inserter.search")}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
        />
      </div>
      <div id={listId} className="cms-inserter-body" role="listbox" aria-label={t("stream.inserter.list")}>
        {sections.map((section) => (
          <div key={section.title} role="group" aria-label={section.title}>
            <p className="cms-inserter-heading">{section.title}</p>
            <div className="cms-inserter-grid">
              {section.choices.map((choice) => {
                index += 1;
                const at = index;
                const Icon = (choice.kind === "type" && BLOCK_ICONS[choice.type.icon ?? ""]) || BLOCK_ICONS.grid;
                const label = choice.kind === "type" ? schemaText.block(choice.type) : choice.layout.name;
                return (
                  <button
                    key={choice.key}
                    id={`${listId}-${at}`}
                    type="button"
                    role="option"
                    aria-selected={at === current}
                    data-choice-index={at}
                    tabIndex={-1}
                    className={cn("cms-inserter-item", at === current && "cms-inserter-item-active")}
                    onMouseEnter={() => setActive(at)}
                    onClick={() => pick(choice)}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- A plugin's own image, which next/image would need configuring for. */}
                    {choice.kind === "type" && choice.type.previewImage ? <img src={choice.type.previewImage} alt="" className="cms-inserter-preview" /> : <Icon className="cms-icon-md" aria-hidden="true" />}
                    <span className="cms-inserter-label">{label}</span>
                    {choice.kind === "layout" && <span className="cms-hint">{t("stream.inserter.blockCount", { count: choice.layout.blocks.length })}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {!flat.length && <p className="cms-inserter-empty">{query ? t("stream.inserter.noMatch", { query }) : t("stream.noTypes")}</p>}
      </div>
    </div>
  );
}
