"use client";

import { useT } from "tansy/admin";
import { useMemo, useState } from "react";
import type { ChatSummary } from "./api";
import { Cross, Plus, Search, Trash } from "./parts";

type Group = "today" | "yesterday" | "week" | "month" | "older";
const GROUPS: Group[] = ["today", "yesterday", "week", "month", "older"];

const DAY = 24 * 60 * 60 * 1000;

/** Which heading a chat goes under, by when it was last used, from the start of today. */
export function groupOf(updatedAt: string, now = new Date()): Group {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const at = new Date(updatedAt).getTime();
  if (at >= today) return "today";
  if (at >= today - DAY) return "yesterday";
  if (at >= today - 7 * DAY) return "week";
  if (at >= today - 30 * DAY) return "month";
  return "older";
}

/** One saved chat. Delete asks again in place, so a stray click loses nothing. */
function ChatRow({ chat, current, onOpen, onDelete }: { chat: ChatSummary; current: boolean; onOpen: () => void; onDelete: () => void }) {
  const { t } = useT();
  const [confirming, setConfirming] = useState(false);
  return (
    <li className={current ? "ai-chat ai-chat-current" : "ai-chat"} onMouseLeave={() => setConfirming(false)}>
      <button type="button" className="ai-chat-open" aria-current={current ? "page" : undefined} title={chat.title} onClick={onOpen}>
        <span className="ai-chat-name">{chat.title}</span>
      </button>
      {confirming
        ? (
          <span className="ai-chat-confirm">
            <button type="button" className="ai-chat-delete" onClick={onDelete}>{t("ext.ai.history.delete")}</button>
            <button type="button" className="ai-ghost ai-ghost-icon" aria-label={t("ext.ai.history.cancel")} title={t("ext.ai.history.cancel")} onClick={() => setConfirming(false)}><Cross /></button>
          </span>
        )
        : <button type="button" className="ai-ghost ai-ghost-icon ai-chat-action" aria-label={t("ext.ai.assistant.deleteChat", { title: chat.title })} title={t("ext.ai.assistant.deleteChat", { title: chat.title })} onClick={() => setConfirming(true)}><Trash /></button>}
    </li>
  );
}

/** Saved chats, newest first under day headings, with a search, as a side panel of the assistant. */
export function History({ chats, loaded, current, onOpen, onDelete, onNew, onClose }: {
  chats: ChatSummary[];
  loaded: boolean;
  current?: string;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const words = query.trim().toLowerCase();
    const found = words ? chats.filter((chat) => chat.title.toLowerCase().includes(words)) : chats;
    const now = new Date();
    const by = new Map<Group, ChatSummary[]>();
    for (const chat of found) {
      const group = groupOf(chat.updatedAt, now);
      by.set(group, [...(by.get(group) ?? []), chat]);
    }
    return GROUPS.filter((group) => by.has(group)).map((group) => ({ group, chats: by.get(group)! }));
  }, [chats, query]);

  return (
    <aside className="ai-side" aria-label={t("ext.ai.history.title")}>
      <div className="ai-side-head">
        <button type="button" className="ai-side-new" onClick={onNew}><span className="ai-side-new-mark"><Plus /></span>{t("ext.ai.assistant.newChat")}</button>
        <button type="button" className="ai-ghost ai-ghost-icon ai-side-close" aria-label={t("ext.ai.history.hide")} title={t("ext.ai.history.hide")} onClick={onClose}><Cross /></button>
      </div>
      {chats.length > 0 && (
        <label className="ai-side-search">
          <Search />
          <input type="search" value={query} placeholder={t("ext.ai.history.search")} aria-label={t("ext.ai.history.search")} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} />
        </label>
      )}
      <nav className="ai-side-list">
        {groups.map(({ group, chats: list }) => (
          <section key={group} className="ai-side-group" aria-label={t(`ext.ai.history.groups.${group}`)}>
            <h2 className="ai-side-heading">{t(`ext.ai.history.groups.${group}`)}</h2>
            <ul>
              {list.map((chat) => <ChatRow key={chat.id} chat={chat} current={chat.id === current} onOpen={() => onOpen(chat.id)} onDelete={() => onDelete(chat.id)} />)}
            </ul>
          </section>
        ))}
        {loaded && chats.length === 0 && <p className="ai-side-empty">{t("ext.ai.history.empty")}</p>}
        {chats.length > 0 && groups.length === 0 && <p className="ai-side-empty">{t("ext.ai.history.noMatches")}</p>}
      </nav>
    </aside>
  );
}
