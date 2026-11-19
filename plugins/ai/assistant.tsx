"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, generateId, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from "ai";
import { adminPath, apiPath, PageHeader, useT } from "tansy/admin";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type WheelEvent } from "react";
import { aiStatus, deleteChat, listChats, loadChat, type AiStatus, type ChatSummary, type Reasoning } from "./api";
import { activeProvider, Composer, ProviderMenu, type Choice } from "./composer";
import { SentFiles, useAttachments } from "./attach";
import { History } from "./history";
import { AnswerParts, ArrowDown, CopyButton, Panel, Plus, Retry, Spark, textOf } from "./parts";
import { ModelIcon } from "./workflow/icons";
import "./ai.css";

/** Only the most recent messages go up, so a long chat stays under the request size limit. */
const HISTORY = 40;

/**
 * Starting points on an empty chat. A complete request is sent as it is; the start of one
 * goes in the box for the person to finish, so a click never asks for something they didn't.
 */
const SUGGESTIONS: Array<{ key: string; send: boolean }> = [
  { key: "collections", send: true },
  { key: "drafts", send: true },
  { key: "post", send: false },
  { key: "course", send: false },
];

/** The open chat's id, in the address, so a reload or a shared link opens it again. */
const CHAT_PARAM = "chat";
const CHAT_ID = /^[A-Za-z0-9_-]{1,64}$/;

function chatInAddress(): string | null {
  const id = new URL(window.location.href).searchParams.get(CHAT_PARAM);
  return id && CHAT_ID.test(id) ? id : null;
}

function showChatInAddress(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set(CHAT_PARAM, id);
  else url.searchParams.delete(CHAT_PARAM);
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
}

/* This browser's own conveniences: the chats panel open or shut, and the last model and thinking chosen. Gone in a private window, which is fine. */
const SIDE_KEY = "tansy.ai.side";
const CHOICE_KEY = "tansy.ai.choice";
const REASONING = new Set<Reasoning>(["provider-default", "none", "low", "medium", "high"]);

/**
 * The model and thinking the next request asks for. The transport reads it when it sends,
 * which includes the sends that follow an approval, so it lives outside React's render.
 * There is one assistant on a page.
 */
const picked: { choice: Choice } = { choice: { provider: null, model: null, reasoning: "provider-default", role: null } };

function remembered<T>(key: string): T | null {
  try {
    const value = window.localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}

function remember(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be off. Nothing depends on it.
  }
}

/** The chats panel sits beside the chat from this width, and over it below. */
const WIDE = "(min-width: 64rem)";

/** How close to the bottom, in pixels, still counts as at the bottom. */
const BOTTOM = 8;

/**
 * Keeps the newest text in view while an answer streams, until the person scrolls up to read,
 * and again once they scroll back down. Only the person's own scrolling stops it: content
 * growing never does, and the chat scrolls itself rather than the page, so nothing else
 * fights it for the scroll position.
 */
function useFollow(mounted: boolean, messages: unknown, chatStatus: unknown) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastTop = useRef(0);
  const [atBottom, setAtBottom] = useState(true);

  const toBottom = useCallback((smooth = false) => {
    const element = scroller.current;
    if (!element) return;
    following.current = true;
    setAtBottom(true);
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (gap <= BOTTOM) following.current = true;
    else if (element.scrollTop < lastTop.current - 1) following.current = false;
    lastTop.current = element.scrollTop;
    setAtBottom(gap <= BOTTOM * 4);
  }, []);

  // A wheel or a key up means the person wants to read, even before the scroll moves.
  const onWheel = useCallback((event: WheelEvent<HTMLDivElement>) => { if (event.deltaY < 0) following.current = false; }, []);

  useEffect(() => {
    const element = content.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const box = scroller.current;
      if (box && following.current) box.scrollTop = box.scrollHeight;
      onScroll();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [mounted, onScroll]);

  useLayoutEffect(() => {
    const box = scroller.current;
    if (box && following.current) box.scrollTop = box.scrollHeight;
  }, [mounted, messages, chatStatus]);

  /** Follow again from the next change, as after switching chats. */
  const resume = useCallback(() => { following.current = true; }, []);

  return { scroller, content, toBottom, onScroll, onWheel, atBottom, resume };
}

/** The assistant page: a chat that works on the CMS as the signed-in person, asking before every change. */
export function Assistant() {
  const { t } = useT();
  const [status, setStatus] = useState<AiStatus | null | undefined>(undefined);
  const [input, setInput] = useState("");
  // Each chat is saved under its id as its answers end, and listed under History. A new id makes useChat start a new chat, with these messages.
  const [session, setSession] = useState<{ id: string; messages: UIMessage[] }>(() => ({ id: generateId(), messages: [] }));
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [choice, setChoiceState] = useState<Choice>(picked.choice);
  const refreshChats = useCallback(() => { void listChats().then((list) => { setChats(list); setChatsLoaded(true); }); }, []);

  const setChoice = (next: Choice) => {
    picked.choice = next;
    setChoiceState(next);
    // The role isn't kept: each visit starts on the site's role, the safe one.
    remember(CHOICE_KEY, { provider: next.provider, model: next.model, reasoning: next.reasoning });
  };

  const { messages, sendMessage, addToolApprovalResponse, status: chatStatus, stop, error, clearError, regenerate } = useChat({
    id: session.id,
    messages: session.messages,
    transport: new DefaultChatTransport({
      api: apiPath("/ext/ai/chat"),
      prepareSendMessagesRequest: ({ id, messages: all }) => {
        const { provider, model, reasoning, role } = picked.choice;
        return { body: { chatId: id, messages: all.slice(-HISTORY), ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(role ? { role } : {}), reasoning } };
      },
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => refreshChats(),
  });

  const busy = chatStatus === "submitted" || chatStatus === "streaming";
  const attachments = useAttachments(status?.chooseModel ? choice.model : null, Boolean(status?.ready), status?.chooseModel ? choice.provider : null);
  const { scroller, content, toBottom, onScroll, onWheel, atBottom, resume } = useFollow(Boolean(status), messages, chatStatus);

  const narrow = () => !window.matchMedia(WIDE).matches;
  const showSide = (open: boolean) => {
    setSideOpen(open);
    if (!narrow()) remember(SIDE_KEY, open);
  };

  const switchTo = (id: string, saved: UIMessage[]) => {
    void stop();
    clearError();
    setInput("");
    attachments.clear();
    if (narrow()) setSideOpen(false);
    resume();
    setSession({ id, messages: saved });
    showChatInAddress(saved.length ? id : null);
  };

  const openChat = async (id: string) => {
    if (id === session.id) { if (narrow()) setSideOpen(false); return; }
    const chat = await loadChat<UIMessage>(id);
    if (chat) switchTo(id, chat.messages);
    else refreshChats();
  };

  const newChat = () => switchTo(generateId(), []);

  const removeChat = async (id: string) => {
    if (!(await deleteChat(id))) return;
    if (id === session.id) newChat();
    refreshChats();
  };

  useEffect(() => {
    void aiStatus().then((value) => {
      setStatus(value);
      const saved = remembered<Partial<Choice>>(CHOICE_KEY);
      // A provider no longer set up falls back to the site's, with its model.
      const provider = typeof saved?.provider === "string" && value?.providers?.some((item) => item.id === saved.provider && item.id !== value.provider) ? saved.provider : null;
      const sameProvider = (saved?.provider ?? null) === provider;
      const next: Choice = {
        provider,
        model: sameProvider && typeof saved?.model === "string" && saved.model ? saved.model : null,
        reasoning: saved?.reasoning && REASONING.has(saved.reasoning) ? saved.reasoning : value?.reasoning ?? "provider-default",
        role: null,
      };
      picked.choice = next;
      setChoiceState(next);
      setSideOpen(window.matchMedia(WIDE).matches && remembered<boolean>(SIDE_KEY) !== false);
    });
    refreshChats();
    const id = chatInAddress();
    if (id) {
      void loadChat<UIMessage>(id).then((chat) => {
        if (chat) setSession({ id, messages: chat.messages });
        else showChatInAddress(null);
      });
    }
  }, [refreshChats]);

  // A new chat from anywhere with Ctrl/Cmd + Shift + O, as in other chat apps.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "o") { event.preventDefault(); newChat(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const send = useCallback((text: string) => {
    if ((!text.trim() && !attachments.ready) || busy || attachments.uploading) return;
    clearError();
    toBottom();
    const files = attachments.take();
    void sendMessage(files.length ? { text: text.trim(), files } : { text: text.trim() });
    setInput("");
    showChatInAddress(session.id);
  }, [busy, clearError, sendMessage, session.id, toBottom, attachments]);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** Puts the start of a request in the box, with the cursor after it, for the person to finish. */
  const startWith = (text: string) => {
    const value = `${text.trimEnd()} `;
    setInput(value);
    requestAnimationFrame(() => {
      const box = inputRef.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(value.length, value.length);
    });
  };

  if (status === undefined) return <div className="ai-app" aria-busy="true" />;
  if (status === null) return <div className="cms-gutter"><PageHeader title={t("ext.ai.assistant.title")} /><p className="cms-empty">{t("ext.ai.assistant.noAccess")}</p></div>;

  const composer = (
    <Composer inputRef={inputRef} value={input} onChange={setInput} onSend={() => send(input)} onStop={() => stop()} busy={busy} disabled={!status.ready} autoFocus={status.ready} status={status} choice={choice} onChoice={setChoice} attachments={attachments} />
  );
  const last = messages[messages.length - 1];
  const waiting = busy && (!last || last.role !== "assistant" || !last.parts.some((part) => (part.type === "text" && part.text) || part.type === "reasoning" || part.type === "dynamic-tool"));
  const title = chats.find((chat) => chat.id === session.id)?.title ?? (messages[0] ? textOf(messages[0]) : "");
  const empty = messages.length === 0;
  const notice = !status.ready && <p className="ai-notice">{t("ext.ai.assistant.notSetUp")} <a href={adminPath("/extensions/ai/settings")}>{t("ext.ai.assistant.settingsLink")}</a>.</p>;

  return (
    <div className={sideOpen ? "ai-app ai-app-side" : "ai-app"}>
      {sideOpen && <button type="button" className="ai-scrim" aria-label={t("ext.ai.history.hide")} tabIndex={-1} onClick={() => showSide(false)} />}
      {sideOpen && <History chats={chats} loaded={chatsLoaded} current={empty ? undefined : session.id} onOpen={(id) => void openChat(id)} onDelete={(id) => void removeChat(id)} onNew={newChat} onClose={() => showSide(false)} />}
      <div className="ai-main">
        <header className="ai-bar">
          {!sideOpen && <button type="button" className="ai-ghost ai-ghost-icon" aria-label={t("ext.ai.history.show")} title={t("ext.ai.history.show")} onClick={() => showSide(true)}><Panel /></button>}
          <h1 className="ai-bar-title" title={title || undefined}>{empty ? t("ext.ai.assistant.title") : title}</h1>
          <ProviderMenu status={status} value={choice.provider} onChange={(provider) => setChoice({ ...choice, provider, model: null })} />
          {!empty && <button type="button" className="ai-ghost" title={`${t("ext.ai.assistant.newChat")} (Ctrl+Shift+O)`} onClick={newChat}><Plus /><span className="ai-hide-sm">{t("ext.ai.assistant.newChat")}</span></button>}
        </header>
        <div ref={scroller} className="ai-scroll" onScroll={onScroll} onWheel={onWheel}>
          <div ref={content} className={empty ? "ai-column ai-column-empty" : "ai-column"}>
            {empty
              ? (
                <div className="ai-start">
                  <div className="ai-hero">
                    <Spark className="ai-hero-mark" />
                    <p className="ai-hero-title">{t("ext.ai.assistant.greeting")}</p>
                  </div>
                  {notice}
                  {composer}
                  {status.ready && (
                    <div className="ai-chips" role="list">
                      {SUGGESTIONS.map(({ key, send: complete }) => {
                        const text = t(`ext.ai.assistant.suggestions.${key}`);
                        return (
                          <button key={key} type="button" role="listitem" className="ai-chip" title={complete ? text : t("ext.ai.assistant.fillHint", { text })} onClick={() => (complete ? send(text) : startWith(text))}>
                            {t(`ext.ai.assistant.suggestionLabels.${key}`)}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <p className="ai-welcome">{t("ext.ai.assistant.welcome")}</p>
                </div>
              )
              : (
                <div className="ai-thread" aria-live="polite">
                  {notice}
                  {messages.map((message, index) => {
                    if (message.role === "user") {
                      const text = textOf(message);
                      return (
                        <div key={message.id} className="ai-row ai-row-user">
                          <SentFiles message={message} />
                          {text && <div className="ai-bubble">{text}</div>}
                          <div className="ai-row-actions"><CopyButton text={text} /></div>
                        </div>
                      );
                    }
                    const text = textOf(message);
                    const isLast = index === messages.length - 1;
                    const streaming = busy && isLast;
                    const { model, provider } = (message.metadata as { model?: unknown; provider?: unknown } | undefined) ?? {};
                    const answeredBy = activeProvider(status, typeof provider === "string" ? provider : null);
                    return (
                      <div key={message.id} className="ai-row ai-row-assistant">
                        <AnswerParts message={message} respond={(id, approved) => void addToolApprovalResponse({ id, approved })} />
                        {streaming && <span className="ai-cursor" aria-hidden="true"><Spark /></span>}
                        {!streaming && (text || isLast) && (
                          <div className="ai-row-actions">
                            {text && <CopyButton text={text} />}
                            {isLast && !busy && <button type="button" className="ai-ghost ai-ghost-icon" aria-label={t("ext.ai.assistant.regenerate")} title={t("ext.ai.assistant.regenerate")} onClick={() => { clearError(); toBottom(); void regenerate(); }}><Retry /></button>}
                            {typeof model === "string" && <span className="ai-model-tag" title={model}><ModelIcon model={model} provider={answeredBy.id} icon={answeredBy.icon} size={14} />{model.split("/").pop()}</span>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {waiting && (
                    <div className="ai-row ai-row-assistant" role="status">
                      <span className="ai-waiting"><Spark className="ai-waiting-mark" /><span className="ai-shimmer">{t("ext.ai.assistant.thinking")}</span></span>
                    </div>
                  )}
                  {error && (
                    <div className="ai-failure" role="alert">
                      <span>{error.message || t("ext.ai.assistant.failed")}</span>
                      <button type="button" className="ai-ghost" onClick={() => { clearError(); toBottom(); void regenerate(); }}><Retry /><span>{t("ext.ai.assistant.retry")}</span></button>
                    </div>
                  )}
                </div>
              )}
          </div>
        </div>
        {!empty && (
          <div className="ai-dock">
            <div className="ai-column">
              {!atBottom && (
                <button type="button" className="ai-jump" aria-label={t("ext.ai.assistant.jumpToLatest")} title={t("ext.ai.assistant.jumpToLatest")} onClick={() => toBottom(true)}><ArrowDown /></button>
              )}
              {composer}
              <p className="ai-foot">{t("ext.ai.assistant.foot")}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
