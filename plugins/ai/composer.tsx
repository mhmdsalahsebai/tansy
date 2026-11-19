"use client";

import { useT } from "tansy/admin";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { chatModels, chatRoles, type AiStatus, type ModelChoice, type ProviderChoice, type Reasoning, type RoleChoice } from "./api";
import { ArrowUp, Brain, Check, ChevronDown, Search, Shield, StopSquare, useDismiss } from "./parts";
import { ModelIcon, ProviderIcon } from "./workflow/icons";
import { AttachButton, PendingFiles, type Attachments } from "./attach";

/**
 * What the person chose in the chat. `provider` null is the site's provider, `model` null
 * that provider's own model, and `role` null the site's role.
 */
export interface Choice { provider: string | null; model: string | null; reasoning: Reasoning; role: string | null }

/** The provider the chat uses: the one chosen while it's still set up, else the site's. */
export function activeProvider(status: AiStatus, provider: string | null): ProviderChoice {
  const site: ProviderChoice = { id: status.provider ?? "", label: status.providerLabel ?? "", icon: status.providerIcon, model: status.model, listsModels: Boolean(status.listsModels) };
  return (provider && status.providers?.find((item) => item.id === provider)) || site;
}

/** Picks the chat's provider, when more than one is set up. Choosing another starts on its own model. */
export function ProviderMenu({ status, value, onChange }: { status: AiStatus; value: string | null; onChange: (provider: string | null) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(root, open, close);
  const providers = status.providers ?? [];
  if (!status.ready || !status.chooseModel || providers.length < 2) return null;
  const current = activeProvider(status, value);
  return (
    <div ref={root} className="ai-menu-root">
      <button type="button" className="ai-pill" aria-haspopup="menu" aria-expanded={open} title={t("ext.ai.composer.provider")} onClick={() => setOpen(!open)}>
        <ProviderIcon provider={current.id} icon={current.icon} size={16} /><span className="ai-pill-text">{current.label}</span><ChevronDown />
      </button>
      {open && (
        <div className="ai-menu ai-menu-providers" role="menu" aria-label={t("ext.ai.composer.provider")}>
          <p className="ai-menu-heading">{t("ext.ai.composer.provider")}</p>
          {providers.map((provider) => {
            const selected = provider.id === current.id;
            return (
              <button key={provider.id} type="button" role="menuitemradio" aria-checked={selected} className="ai-menu-item" onClick={() => { onChange(provider.id === status.provider ? null : provider.id); close(); }}>
                <ProviderIcon provider={provider.id} icon={provider.icon} size={18} />
                <span className="ai-menu-text"><span className="ai-menu-label">{provider.label}</span>{provider.id === status.provider && <span className="ai-menu-detail">{t("ext.ai.composer.siteProvider")}</span>}</span>
                {selected && <Check />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const REASONING: Reasoning[] = ["provider-default", "none", "low", "medium", "high"];

/** "anthropic/claude-opus-5-5" as "claude-opus-5-5", for a button with little room. The full id is its title. */
const shortName = (id: string) => id.split("/").pop() || id;

/** At most this many models in the menu at once; searching narrows the rest. */
const SHOWN = 200;

/** Picks the chat's model from what the chosen provider lists, or any id typed in. */
function ModelMenu({ status, provider, value, onChange }: { status: AiStatus; provider: ProviderChoice; value: string | null; onChange: (model: string | null) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<ModelChoice[] | string | null>(null);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const close = useCallback(() => { setOpen(false); setQuery(""); setActive(0); }, []);
  useDismiss(root, open, close);

  useEffect(() => {
    if (!open || models !== null || !provider.listsModels) return;
    let live = true;
    void chatModels(provider.id === status.provider ? null : provider.id).then((result) => { if (live) setModels("options" in result ? result.options : result.error); });
    return () => { live = false; };
  }, [open, models, provider.listsModels, provider.id, status.provider]);

  const options = useMemo(() => {
    const words = query.trim().toLowerCase();
    const all = Array.isArray(models) ? models : [];
    const found = words ? all.filter((model) => `${model.value} ${model.label ?? ""}`.toLowerCase().includes(words)) : all;
    const typed = query.trim();
    const items: Array<{ value: string | null; label: string; detail?: string }> = [];
    if (!words) items.push({ value: null, label: provider.id === status.provider ? t("ext.ai.composer.siteModel") : t("ext.ai.composer.providerModel"), detail: provider.model });
    if (typed && !all.some((model) => model.value === typed)) items.push({ value: typed, label: t("ext.ai.composer.useTyped", { model: typed }) });
    for (const model of found.slice(0, SHOWN)) items.push({ value: model.value, label: model.label && model.label !== model.value ? model.label : model.value, detail: model.label && model.label !== model.value ? model.value : undefined });
    return items;
  }, [models, query, provider.id, provider.model, status.provider, t]);

  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);

  const pick = (model: string | null) => { onChange(model); close(); };
  const current = value ?? provider.model ?? "";

  return (
    <div ref={root} className="ai-menu-root">
      <button type="button" className="ai-pill" aria-haspopup="listbox" aria-expanded={open} title={current} onClick={() => (open ? close() : setOpen(true))}>
        <ModelIcon model={current} provider={provider.id} icon={provider.icon} size={16} /><span className="ai-pill-text">{shortName(current) || t("ext.ai.composer.model")}</span><ChevronDown />
      </button>
      {open && (
        <div className="ai-menu ai-menu-models" role="dialog" aria-label={t("ext.ai.composer.model")}>
          <label className="ai-menu-search">
            <Search />
            <input
              autoFocus
              value={query}
              placeholder={t("ext.ai.composer.searchModels")}
              aria-label={t("ext.ai.composer.searchModels")}
              onChange={(event) => { setQuery(event.target.value); setActive(0); }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") { event.preventDefault(); setActive((at) => Math.min(at + 1, options.length - 1)); }
                else if (event.key === "ArrowUp") { event.preventDefault(); setActive((at) => Math.max(at - 1, 0)); }
                else if (event.key === "Enter") { event.preventDefault(); const option = options[active]; if (option) pick(option.value); }
              }}
            />
          </label>
          <ul ref={list} className="ai-menu-list" role="listbox" aria-label={t("ext.ai.composer.model")}>
            {options.map((option, index) => {
              const selected = option.value === value;
              return (
                <li key={option.value ?? "site"} role="option" aria-selected={selected} data-index={index} className={index === active ? "ai-menu-item ai-menu-active" : "ai-menu-item"} onPointerMove={() => setActive(index)} onClick={() => pick(option.value)}>
                  <ModelIcon model={option.value ?? provider.model ?? ""} provider={provider.id} icon={provider.icon} size={18} />
                  <span className="ai-menu-text"><span className="ai-menu-label">{option.label}</span>{option.detail && <span className="ai-menu-detail">{option.detail}</span>}</span>
                  {selected && <Check />}
                </li>
              );
            })}
          </ul>
          {provider.listsModels && models === null && <p className="ai-menu-note" role="status">{t("ext.ai.composer.loadingModels")}</p>}
          {typeof models === "string" && <p className="ai-menu-note" role="status">{models}</p>}
          {Array.isArray(models) && query.trim() && options.length <= 1 && <p className="ai-menu-note">{t("ext.ai.composer.noModels")}</p>}
        </div>
      )}
    </div>
  );
}

/** The role the assistant acts with in this chat. Any role can only narrow the person's own access. */
function RoleMenu({ status, value, onChange }: { status: AiStatus; value: string | null; onChange: (role: string | null) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [roles, setRoles] = useState<RoleChoice[] | string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(root, open, close);
  // Listed once, so the pill can show the role's name rather than its id.
  useEffect(() => { void chatRoles().then((result) => setRoles("options" in result ? result.options : result.error)); }, []);
  const list = Array.isArray(roles) ? roles : [];
  const labelOf = (name: string | undefined) => list.find((role) => role.value === name)?.label ?? name ?? "";
  const current = labelOf(value ?? status.role);
  return (
    <div ref={root} className="ai-menu-root">
      <button type="button" className={value ? "ai-pill ai-pill-on" : "ai-pill"} aria-haspopup="menu" aria-expanded={open} title={t("ext.ai.composer.roleTitle")} onClick={() => setOpen(!open)}>
        <Shield /><span className="ai-pill-text">{current || t("ext.ai.composer.role")}</span><ChevronDown />
      </button>
      {open && (
        <div className="ai-menu ai-menu-roles" role="menu" aria-label={t("ext.ai.composer.role")}>
          <p className="ai-menu-heading">{t("ext.ai.composer.roleTitle")}</p>
          <div className="ai-menu-scroll">
            <button type="button" role="menuitemradio" aria-checked={value === null} className="ai-menu-item" onClick={() => { onChange(null); close(); }}>
              <span className="ai-menu-text"><span className="ai-menu-label">{t("ext.ai.composer.siteRole")}</span><span className="ai-menu-detail">{labelOf(status.role)}</span></span>
              {value === null && <Check />}
            </button>
            {list.map((role) => (
              <button key={role.value} type="button" role="menuitemradio" aria-checked={role.value === value} className="ai-menu-item" title={role.description} onClick={() => { onChange(role.value); close(); }}>
                <span className="ai-menu-text"><span className="ai-menu-label">{role.label}</span>{role.description && <span className="ai-menu-detail">{role.description}</span>}</span>
                {role.value === value && <Check />}
              </button>
            ))}
          </div>
          {roles === null && <p className="ai-menu-note" role="status">{t("ext.ai.composer.loadingRoles")}</p>}
          {typeof roles === "string" && <p className="ai-menu-note" role="status">{t("ext.ai.composer.rolesFailed")}</p>}
        </div>
      )}
    </div>
  );
}

/** How long the model thinks before it answers. */
function ThinkingMenu({ value, onChange }: { value: Reasoning; onChange: (value: Reasoning) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(root, open, close);
  const on = value !== "none" && value !== "provider-default";
  return (
    <div ref={root} className="ai-menu-root">
      <button type="button" className={on ? "ai-pill ai-pill-on" : "ai-pill"} aria-haspopup="menu" aria-expanded={open} title={t("ext.ai.composer.thinking")} onClick={() => setOpen(!open)}>
        <Brain /><span className="ai-pill-text">{value === "provider-default" ? t("ext.ai.composer.thinking") : t(`ext.ai.composer.reasoning.${value}`)}</span><ChevronDown />
      </button>
      {open && (
        <div className="ai-menu ai-menu-thinking" role="menu" aria-label={t("ext.ai.composer.thinking")}>
          <p className="ai-menu-heading">{t("ext.ai.composer.thinking")}</p>
          {REASONING.map((level) => (
            <button key={level} type="button" role="menuitemradio" aria-checked={level === value} className="ai-menu-item" onClick={() => { onChange(level); close(); }}>
              <span className="ai-menu-text"><span className="ai-menu-label">{t(`ext.ai.composer.reasoning.${level}`)}</span><span className="ai-menu-detail">{t(`ext.ai.composer.reasoningHint.${level}`)}</span></span>
              {level === value && <Check />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The box people type in: grows with the text, sends on Enter, and turns its button into Stop while answering. */
export function Composer({ value, onChange, onSend, onStop, busy, disabled, autoFocus, status, choice, onChoice, inputRef, attachments }: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
  autoFocus?: boolean;
  status: AiStatus;
  choice: Choice;
  onChoice: (choice: Choice) => void;
  /** The text box, for a suggestion that puts words in it and leaves the cursor at their end. */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** Files going with the next message. */
  attachments: Attachments;
}) {
  const { t } = useT();
  const own = useRef<HTMLTextAreaElement>(null);
  const box = inputRef ?? own;
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 288)}px`;
  }, [value]);
  // Back to typing once an answer ends.
  useEffect(() => { if (!busy && !disabled && autoFocus) box.current?.focus({ preventScroll: true }); }, [busy, disabled, autoFocus]);
  const [dragging, setDragging] = useState(false);
  const canAttach = status.ready && !disabled && Boolean(attachments.capabilities);
  const sendable = (Boolean(value.trim()) || attachments.ready) && !attachments.uploading;
  return (
    <form
      className={dragging ? "ai-compose ai-compose-drop" : "ai-compose"}
      onSubmit={(event) => { event.preventDefault(); if (sendable) onSend(); }}
      onClick={(event) => { if (event.target === event.currentTarget) box.current?.focus(); }}
      onDragOver={(event) => { if (canAttach && event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(event) => { if (!canAttach) return; event.preventDefault(); setDragging(false); attachments.add(Array.from(event.dataTransfer.files)); }}
    >
      {dragging && <p className="ai-drop-note" aria-hidden="true">{t("ext.ai.attach.drop")}</p>}
      <PendingFiles attachments={attachments} />
      <textarea
        ref={box}
        className="ai-input"
        rows={1}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-label={t("ext.ai.assistant.placeholder")}
        placeholder={t("ext.ai.assistant.placeholder")}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (sendable) onSend(); } }}
        onPaste={(event) => {
          // A picture pasted from the clipboard is attached, as in other chat apps. Text pastes as usual.
          const files = Array.from(event.clipboardData.files);
          if (!canAttach || !files.length) return;
          event.preventDefault();
          attachments.add(files);
        }}
      />
      <div className="ai-compose-bar">
        <div className="ai-compose-tools">
          {status.ready && <AttachButton attachments={attachments} disabled={disabled} />}
          {status.ready && status.chooseModel && (
            <>
              <ModelMenu key={choice.provider ?? "site"} status={status} provider={activeProvider(status, choice.provider)} value={choice.model} onChange={(model) => onChoice({ ...choice, model })} />
              <ThinkingMenu value={choice.reasoning} onChange={(reasoning) => onChoice({ ...choice, reasoning })} />
            </>
          )}
          {status.ready && !status.chooseModel && status.model && <span className="ai-pill ai-pill-static" title={status.model}><ModelIcon model={status.model} provider={status.provider ?? ""} icon={status.providerIcon} size={16} /><span className="ai-pill-text">{shortName(status.model)}</span></span>}
          {status.ready && status.chooseRole && <RoleMenu status={status} value={choice.role} onChange={(role) => onChoice({ ...choice, role })} />}
        </div>
        {busy
          ? <button type="button" className="ai-send ai-send-stop" aria-label={t("ext.ai.assistant.stop")} title={t("ext.ai.assistant.stop")} onClick={onStop}><StopSquare /></button>
          : <button type="submit" className="ai-send" aria-label={t("ext.ai.assistant.send")} title={`${t("ext.ai.assistant.send")} · ${t("ext.ai.assistant.hint")}`} disabled={disabled || !sendable}><ArrowUp /></button>}
      </div>
    </form>
  );
}
