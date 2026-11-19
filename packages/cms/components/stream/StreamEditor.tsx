"use client";

import { useFieldText, usePluginWord, useSchemaText, useT } from "../i18n";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Menu, MenuButton, MenuItem, MenuItems, MenuSeparator } from "@headlessui/react";
import { AdjustmentsHorizontalIcon, ArrowDownIcon, ArrowUpIcon, EllipsisVerticalIcon, PlusIcon } from "@heroicons/react/16/solid";
import { createContext, createElement, Fragment, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MAX_BLOCK_DEPTH, type Block } from "../../core/blocks/limits";
import { cn } from "../../lib/utils";
import type { BlockFieldProps } from "../../core/extend/admin";
import { useAdminClient, useAdminSlots, useSitePreview } from "../admin-client";
import { BlockIcon } from "../blocks/block-icons";
import FieldValueInput from "../fields/FieldValueInput";
import RichTextEditor from "../fields/RichTextEditor";
import { isShown } from "../fields/show-if";
import { issueFor, type BlockLayoutInfo, type BlockTypeInfo, type EditorCatalog, type IssueMap } from "../fields/types";
import { PluginBoundary, runPluginAction } from "../PluginBoundary";
import { Alert, Button } from "../ui/kit";
import { blockElement, EditorSelectionContext, focusFirstInput, ToolbarSlotProvider, useEditorSelection, useSelectionState } from "./editor-context";
import { canFrame, embedUrl } from "./embed";
import Inserter from "./Inserter";
import SaveLayout from "./SaveLayout";
import { BlockPreview, CanvasEmbed, CanvasMedia, SiteFrame, siteRenders, themeRenders } from "./site-canvas";
import {
  addableTypes, blockPlacement, blockSummary, canAdd, defaultBlockType, duplicateAt, insertAt, moveTo, newBlock, removeAt, typedValue, withFreshIds,
  type StreamConfig,
} from "./stream-ops";

export type { StreamConfig } from "./stream-ops";

/** True inside a stream whose blocks are fixed, nested lists included: nothing can be added, moved or removed. */
const FixedContext = createContext(false);

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const keys = (combo: string) => (isMac() ? combo.replace("Mod", "⌘").replace("Alt", "⌥").replace("Shift", "⇧").replace(/\+/g, "") : combo.replace("Mod", "Ctrl"));

interface ListProps {
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
  config: StreamConfig;
  catalog: EditorCatalog;
  layouts: BlockLayoutInfo[];
  issues: IssueMap;
  path: string;
  depth: number;
  label: string;
  /** The block holding this list, for Escape to select. */
  parentId: string | null;
}

/** What a list does to its blocks, shared by each block's toolbar, menu and keyboard shortcuts. */
interface ListActions {
  move: (index: number, offset: number) => void;
  duplicate: (index: number) => void;
  remove: (index: number) => void;
  insertNear: (index: number) => void;
  canDuplicate: (index: number) => boolean;
}

/** One line of text that grows with its content, with no box around it. */
function BareText({ value, onChange, label, placeholder, multiline, lead, inherit, className, readOnly, id }: { value: unknown; onChange: (value: string) => void; label: string; placeholder?: string; multiline: boolean; lead: boolean; inherit?: boolean; className?: string; readOnly?: boolean; id: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const text = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [text]);
  return (
    <textarea
      ref={ref}
      id={id}
      rows={1}
      aria-label={label}
      placeholder={placeholder ?? label}
      readOnly={readOnly}
      className={cn("cms-bare", inherit ? "cms-bare-inherit" : lead ? "cms-bare-lead" : "cms-bare-small", className)}
      value={text}
      onChange={(event) => onChange(multiline ? event.target.value : event.target.value.replace(/\n/g, " "))}
      // A one-line field keeps to one line, and Enter does nothing rather than adding a break the API would refuse.
      onKeyDown={(event) => { if (!multiline && event.key === "Enter") event.preventDefault(); }}
    />
  );
}

interface CanvasFieldProps {
  block: Block;
  field: BlockTypeInfo["fields"][number];
  lead: boolean;
  path: string;
  list: ListProps;
  setField: (name: string, value: unknown) => void;
  selected: boolean;
  /** Inside a plugin's block editor: text takes the typography around it. */
  inherit?: boolean;
  className?: string;
  placeholder?: string;
}

/** A field edited where it shows: text without a box, rich text inline, media as itself, nested blocks in place, and anything else with its normal control. */
function CanvasField({ block, field, lead, path, list, setField, selected, inherit, className, placeholder }: CanvasFieldProps) {
  const { catalog, issues, depth } = list;
  const config = (field.config ?? null) as Record<string, unknown> | null;
  const { t } = useT();
  const label = useFieldText().label({ name: field.name, config });
  const input = catalog.fieldTypes.find((type) => type.type === field.type)?.input ?? "text";
  const value = Object.hasOwn(block.value, field.name) ? block.value[field.name] : undefined;
  const error = field.type === "stream" ? issues[path] : issueFor(issues, path);
  const id = `field-${block.id}-${field.name}`;
  const admin = useAdminClient().fieldAdmin.find((definition) => definition.type === field.type);
  const custom = Boolean(admin?.Input);

  let control: ReactNode;
  if (admin?.Canvas) {
    control = (
      <PluginBoundary plugin={admin.plugin}>
        {createElement(admin.Canvas, { id, field: { name: field.name, type: field.type, config }, value, onChange: (next: unknown) => setField(field.name, next), path, error, disabled: false, readOnly: false, selected })}
      </PluginBoundary>
    );
  } else if (!custom && input === "text") control = <BareText id={id} value={value} onChange={(text) => setField(field.name, text)} label={config?.required ? t("stream.required", { label }) : label} placeholder={placeholder} multiline={Boolean(config?.multiline)} lead={lead} inherit={inherit} className={className} />;
  else if (!custom && input === "richtext") {
    const editor = <RichTextEditor id={id} variant="bare" value={value} onChange={(next) => setField(field.name, next)} label={label} placeholder={placeholder ?? `${label}…`} allowedFeatures={config?.allowedFeatures as string[] | Record<string, boolean> | undefined} />;
    control = className ? <div className={className}>{editor}</div> : editor;
  } else if (!custom && input === "code") {
    control = <BareText id={id} value={value} onChange={(text) => setField(field.name, text)} label={label} placeholder={placeholder} multiline lead={false} inherit={inherit} className={cn("cms-bare-code", className)} />;
  } else if (!custom && (input === "image" || input === "file" || input === "gallery")) {
    control = <CanvasMedia id={id} kind={input} value={value} onChange={(next) => setField(field.name, next)} allowedTypes={config?.allowedTypes as string[] | undefined} label={placeholder ?? label} selected={selected} />;
  }
  else if (!custom && input === "stream") {
    control = (
      <div className="cms-bk-inner">
        <span className="cms-bk-inner-label">{label}</span>
        <StreamEditor value={value} onChange={(next) => setField(field.name, next)} config={(config ?? {}) as StreamConfig} catalog={catalog} issues={issues} path={path} depth={depth + 1} label={label} parentId={block.id} />
      </div>
    );
  } else {
    control = <FieldValueInput field={{ id: `${block.id}-${field.name}`, name: field.name, type: field.type, config }} input={input} value={value} onChange={(next) => setField(field.name, next)} error={error} catalog={catalog} issues={issues} issuePath={path} depth={depth + 1} />;
    return <div data-canvas-field data-path={path} className="cms-bk-field">{control}</div>;
  }
  return (
    <div data-canvas-field data-path={path} className={cn("cms-bk-field", inherit && "cms-bk-field-inherit")}>
      {control}
      {error && <p className="cms-error cms-mt-1">{error}</p>}
    </div>
  );
}

interface BlockFieldContextValue {
  block: Block;
  fields: BlockTypeInfo["fields"];
  at: string;
  list: ListProps;
  setField: (name: string, value: unknown) => void;
  selected: boolean;
}

const BlockFieldContext = createContext<BlockFieldContextValue | null>(null);

/** The `Field` a plugin's block editor places. One component for every block, so its controls keep their state as the block re-renders. */
function BlockField({ name, className, placeholder }: BlockFieldProps) {
  const context = useContext(BlockFieldContext);
  const field = context?.fields.find((item) => item.name === name);
  if (!context || !field) return null;
  return <CanvasField block={context.block} field={field} lead={false} path={`${context.at}.value.${name}`} list={context.list} setField={context.setField} selected={context.selected} inherit className={className} placeholder={placeholder} />;
}

function BlockMenu({ index, list, actions, label }: { index: number; list: ListProps; actions: ListActions; label: string }) {
  const { t } = useT();
  const canInsert = addableTypes(list.blocks, list.config, list.catalog).length > 0;
  const items: Array<{ label: string; keys?: string; run: () => void; disabled?: boolean; danger?: boolean } | "separator"> = [
    { label: t("stream.duplicate"), keys: keys("Mod+Shift+D"), run: () => actions.duplicate(index), disabled: !actions.canDuplicate(index) },
    { label: t("stream.addBefore"), keys: keys("Mod+Alt+T"), run: () => actions.insertNear(index), disabled: !canInsert },
    { label: t("stream.addAfter"), keys: keys("Mod+Alt+Y"), run: () => actions.insertNear(index + 1), disabled: !canInsert },
    "separator",
    { label: t("stream.moveToTop"), run: () => actions.move(index, -index), disabled: index === 0 },
    { label: t("stream.moveToBottom"), run: () => actions.move(index, list.blocks.length - 1 - index), disabled: index === list.blocks.length - 1 },
    "separator",
    { label: t("stream.removeBlock", { label }), keys: keys("Shift+Alt+Z"), run: () => actions.remove(index), danger: true },
  ];
  return (
    <Menu>
      <MenuButton className="cms-bk-tool" aria-label={t("stream.moreOptions")} title={t("stream.moreOptions")}><EllipsisVerticalIcon className="cms-icon" aria-hidden="true" /></MenuButton>
      <MenuItems anchor={{ to: "bottom end", gap: 6 }} className="cms-menu">
        {items.map((item, at) => item === "separator" ? <MenuSeparator key={at} className="cms-menu-sep" /> : (
          <MenuItem key={item.label} disabled={item.disabled}>
            <button type="button" className={cn("cms-menu-row", item.danger && "cms-menu-row-danger")} onClick={item.run}>
              <span>{item.label}</span>
              {item.keys && <kbd className="cms-kbd">{item.keys}</kbd>}
            </button>
          </MenuItem>
        ))}
      </MenuItems>
    </Menu>
  );
}

/**
 * Values set earlier in the same event, by block id. Several fields set at once, as a
 * plugin's editor may, then build on each other rather than on the value the render saw.
 */
const pendingValues = new Map<string, Block["value"]>();

function BlockItem({ block, index, list, actions, autoFocus, onFocused }: { block: Block; index: number; list: ListProps; actions: ListActions; autoFocus: boolean; onFocused: () => void }) {
  const fixed = useContext(FixedContext);
  const { blocks, onChange, catalog, issues, path } = list;
  const { t } = useT();
  const schemaText = useSchemaText();
  const word = usePluginWord();
  const selection = useEditorSelection()!;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: block.id, disabled: fixed });
  const element = useRef<HTMLDivElement | null>(null);
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  const pluginActions = useAdminSlots().blockActions.filter((action) => !action.blocks || action.blocks.includes(block.type));
  const blockEditor = useAdminClient().blockEditors.find((editor) => editor.blocks.includes(block.type));
  const site = useSitePreview();
  const valueKey = useMemo(() => JSON.stringify(block.value), [block.value]);
  const [emptyFor, setEmptyFor] = useState<string | null>(null);

  const at = `${path}.${index}`;
  const selected = selection.selected === block.id;
  const definition = catalog.blockTypes.find((type) => type.name === block.type);
  const label = definition ? schemaText.block(definition) : block.type;
  const missingField = definition?.fields.some((field) => !catalog.fieldTypes.some((type) => type.type === field.type)) ?? false;
  const current = definition?.version === block.v && !missingField ? definition : undefined;
  const invalid = Object.keys(issues).some((key) => key === at || key.startsWith(`${at}.`));
  const blockIssue = issues[`${at}.type`] ?? issues[`${at}.id`];

  useEffect(() => {
    if (!autoFocus) return;
    focusFirstInput(element.current);
    onFocused();
  }, [autoFocus, onFocused]);

  const replace = (next: Block) => onChange(blocks.map((item) => (item.id === block.id ? next : item)));
  const setField = (name: string, value: unknown) => {
    const next = { ...(pendingValues.get(block.id) ?? block.value) };
    if (value === "" || value === undefined) delete next[name];
    else next[name] = value;
    if (!pendingValues.has(block.id)) queueMicrotask(() => pendingValues.delete(block.id));
    pendingValues.set(block.id, next);
    replace({ ...block, value: next });
  };
  // Keeps the values that still have a field, and the save validates them against the new definition.
  const update = () => {
    if (!definition) return;
    const names = new Set(definition.fields.map((field) => field.name));
    replace({ ...block, v: definition.version, value: Object.fromEntries(Object.entries(block.value).filter(([key]) => names.has(key))) });
  };

  const valueOf = (name: string) => (Object.hasOwn(block.value, name) ? block.value[name] : undefined);
  const visible = (current?.fields ?? []).filter((field) => isShown(field.config, valueOf) || issueFor(issues, `${at}.value.${field.name}`));
  const canvasFields = visible.filter((field) => blockPlacement(catalog, field) === "canvas");
  const settingsFields = visible.filter((field) => blockPlacement(catalog, field) === "settings");
  const settingsInvalid = settingsFields.some((field) => issueFor(issues, `${at}.value.${field.name}`));
  const inputOf = (type: string) => catalog.fieldTypes.find((info) => info.type === type)?.input;
  // A video link set in the sidebar shows on the canvas as the site embeds it, when the page may frame it.
  const embeds = settingsFields.flatMap((field) => {
    const src = inputOf(field.type) === "url" ? embedUrl(valueOf(field.name)) : null;
    return src && canFrame(src, site?.frames) ? [{ name: field.name, src }] : [];
  });

  /*
   * How the block shows, as in Gutenberg. A plugin's editor shows it as the site does and is
   * edited in place. Otherwise the site's own rendering shows while the block isn't being
   * edited, and its fields while it is. A block whose content is all in its settings keeps
   * the rendering, as there's nothing to type on the canvas. When the theme restyles a block,
   * the theme's rendering is what visitors get, so it shows until the block is selected.
   */
  const usePluginEditor = Boolean(current && blockEditor) && (selected || !themeRenders(site, block.type));
  const usePreview = Boolean(current && site && siteRenders(site, block.type)) && !usePluginEditor && (!selected || !canvasFields.length) && !invalid && emptyFor !== valueKey;
  const edit = () => {
    selection.select(block.id);
    if (canvasFields.length) requestAnimationFrame(() => focusFirstInput(element.current));
    else selection.showSettings?.();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.shiftKey && event.code === "KeyD") actions.duplicate(index);
    else if (mod && event.altKey && event.code === "KeyT") actions.insertNear(index);
    else if (mod && event.altKey && event.code === "KeyY") actions.insertNear(index + 1);
    else if (event.shiftKey && event.altKey && !mod && event.code === "KeyZ") actions.remove(index);
    else if (event.altKey && event.shiftKey && event.key === "ArrowUp") actions.move(index, -1);
    else if (event.altKey && event.shiftKey && event.key === "ArrowDown") actions.move(index, 1);
    else if (event.key === "Escape" && !event.defaultPrevented) {
      // Up one level, as in most block editors: from inside a field to its block, then to the block around it.
      if (document.activeElement !== element.current) element.current?.focus();
      else if (list.parentId) {
        selection.select(list.parentId);
        blockElement(list.parentId)?.focus();
      } else {
        selection.select(null);
        element.current?.blur();
      }
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const settings = settingsFields.map((field) => {
    const key = `${at}.value.${field.name}`;
    return (
      <div key={field.name} data-path={key}>
        <FieldValueInput
          field={{ id: `${block.id}-${field.name}`, name: field.name, type: field.type, config: (field.config ?? null) as Record<string, unknown> | null }}
          input={catalog.fieldTypes.find((type) => type.type === field.type)?.input ?? "text"}
          value={valueOf(field.name)}
          onChange={(value) => setField(field.name, value)}
          error={issueFor(issues, key)}
          catalog={catalog}
          issues={issues}
          issuePath={key}
          depth={list.depth + 1}
        />
      </div>
    );
  });

  const inspector = selected && selection.inspector && createPortal(
    <div className="cms-inspector" key={block.id}>
      <div className="cms-inspector-head">
        <span className="cms-inspector-icon"><BlockIcon name={definition?.icon} /></span>
        <div className="cms-min-0">
          <p className="cms-text-sm cms-semibold cms-strong">{label}</p>
          <p className="cms-hint cms-truncate">{blockSummary(block) || t("stream.position", { index: index + 1, count: blocks.length, list: list.label })}</p>
        </div>
      </div>
      {settings.length ? <div className="cms-stack-4">{settings}</div> : <p className="cms-muted">{current ? t("stream.noSettings") : t("stream.cantEdit")}</p>}
    </div>,
    selection.inspector,
  );

  const fields = (
    <>
      {embeds.map((embed) => <CanvasEmbed key={embed.name} src={embed.src} title={label} />)}
      {canvasFields.map((field, at2) => <CanvasField key={field.name} block={block} field={field} lead={at2 === 0} path={`${at}.value.${field.name}`} list={list} setField={setField} selected={selected} />)}
      {current && !canvasFields.length && !embeds.length && (
        <button type="button" className="cms-bk-placeholder" onClick={() => { selection.select(block.id); selection.showSettings?.(); }}>
          <BlockIcon name={definition?.icon} />
          <span className="cms-medium cms-strong">{label}</span>
          <span className="cms-truncate">{settingsFields.map((field) => valueOf(field.name)).filter((value) => value !== undefined && value !== "").map(String).join(" · ") || t("stream.editInSettings")}</span>
        </button>
      )}
    </>
  );

  let content: ReactNode = fields;
  if (usePluginEditor && blockEditor && current) {
    content = (
      <SiteFrame site={site}>
        <PluginBoundary plugin={blockEditor.plugin} fallback={fields}>
          <BlockFieldContext.Provider value={{ block, fields: current.fields, at, list, setField, selected }}>
            {createElement(blockEditor.component, { block: { id: block.id, type: block.type, value: block.value }, setField, selected, Field: BlockField })}
          </BlockFieldContext.Provider>
        </PluginBoundary>
      </SiteFrame>
    );
  } else if (usePreview && site) {
    content = (
      <PluginBoundary plugin="site" fallback={fields}>
        <BlockPreview block={block} site={site} label={label} onEdit={edit} onEmpty={() => setEmptyFor(valueKey)} />
      </PluginBoundary>
    );
  }

  return (
    <div
      ref={(node) => { setNodeRef(node); element.current = node; }}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("cms-bk", selected && "cms-bk-selected", invalid && "cms-bk-invalid", isDragging && "cms-bk-dragging")}
      data-testid="block-card"
      data-block-type={block.type}
      data-block-id={block.id}
      data-path={at}
      tabIndex={-1}
      role="group"
      aria-label={t("stream.blockGroup", { label })}
      onFocusCapture={() => selection.select(block.id)}
      onPointerDownCapture={() => selection.select(block.id)}
      onKeyDown={onKeyDown}
    >
      {selected && (
        <div className="cms-bk-toolbar" role="toolbar" aria-label={t("stream.blockTools", { label })} onPointerDown={(event) => event.stopPropagation()}>
          <span className="cms-bk-tool-group">
            <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners} aria-label={t("stream.dragLabel", { label })} title={t("stream.drag")} className="cms-bk-type cms-drag">
              <BlockIcon name={definition?.icon} />
              <span>{label}</span>
            </button>
          </span>
          <span className="cms-bk-tool-group">
            <button type="button" className="cms-bk-tool" aria-label={t("stream.moveUp")} title={t("stream.withKeys", { label: t("stream.moveUp"), keys: keys("Alt+Shift+↑") })} disabled={fixed || index === 0} onClick={() => actions.move(index, -1)}><ArrowUpIcon className="cms-icon" aria-hidden="true" /></button>
            <button type="button" className="cms-bk-tool" aria-label={t("stream.moveDown")} title={t("stream.withKeys", { label: t("stream.moveDown"), keys: keys("Alt+Shift+↓") })} disabled={fixed || index === blocks.length - 1} onClick={() => actions.move(index, 1)}><ArrowDownIcon className="cms-icon" aria-hidden="true" /></button>
          </span>
          <span ref={setToolbarSlot} className="cms-bk-format" />
          {pluginActions.length > 0 && (
            <span className="cms-bk-tool-group">
              {pluginActions.map((action) => <button key={action.id} type="button" className="cms-bk-tool cms-bk-tool-text" onClick={() => void runPluginAction(action.plugin, () => action.run({ block: { id: block.id, type: block.type, value: block.value }, setValue: (value) => replace({ ...block, value }) }), () => undefined)}>{word(action.plugin, `actions.${action.id}`, action.label)}</button>)}
            </span>
          )}
          <span className="cms-bk-tool-group">
            {selection.showSettings && settingsFields.length > 0 && <button type="button" className={cn("cms-bk-tool", settingsInvalid && "cms-danger")} aria-label={t("stream.blockSettings")} title={t("stream.blockSettings")} onClick={selection.showSettings}><AdjustmentsHorizontalIcon className="cms-icon" aria-hidden="true" /></button>}
            {!fixed && <BlockMenu index={index} list={list} actions={actions} label={label} />}
          </span>
        </div>
      )}

      <ToolbarSlotProvider value={selected ? toolbarSlot : null}>
        <div className="cms-bk-body">
          {blockIssue && <p className="cms-error">{blockIssue}</p>}
          {(!definition || missingField) && <Alert kind="warning">{definition ? t("stream.pluginMissing") : t("stream.typeMissing")}</Alert>}
          {definition && !missingField && !current && (
            <div className="cms-notice cms-notice-action">
              <span>{t("stream.olderVersion", { block: label })}</span>
              <Button variant="secondary" onClick={update}>{t("stream.updateBlock")}</Button>
            </div>
          )}
          {content}
          {/* Outside the record editor there's no sidebar, so settings open under the block. */}
          {selected && !selection.inspector && settings.length > 0 && <div className="cms-bk-settings cms-stack-4">{settings}</div>}
          {settingsInvalid && !selected && <p className="cms-error">{t("stream.settingsNeedAttention")}</p>}
        </div>
      </ToolbarSlotProvider>
      {inspector}
    </div>
  );
}

/** The space between two blocks, which shows a button to add one there. */
function Gap({ index, open, onOpen, children }: { index: number; open: boolean; onOpen: (index: number) => void; children?: ReactNode }) {
  const { t } = useT();
  return (
    <div className={cn("cms-bk-gap", open && "cms-bk-gap-open")}>
      <button type="button" className="cms-bk-gap-btn" aria-label={t("stream.addHere")} title={t("stream.addHere")} onClick={() => onOpen(index)}>
        <PlusIcon className="cms-icon-xs" aria-hidden="true" />
      </button>
      {children}
    </div>
  );
}

function BlockList(props: ListProps) {
  const { blocks, onChange, config, catalog, layouts, issues, path, depth, label } = props;
  const { t } = useT();
  const schemaText = useSchemaText();
  const dndId = useId();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const selection = useEditorSelection()!;
  const [inserter, setInserter] = useState<{ index: number; query: string } | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [removed, setRemoved] = useState<{ block: Block; index: number; label: string } | null>(null);
  const [draft, setDraft] = useState("");

  const labelOf = (block: Block) => {
    const type = catalog.blockTypes.find((item) => item.name === block.type);
    return type ? schemaText.block(type) : block.type;
  };
  // A synced stream's translation keeps the default language's blocks: no adding, moving or removing.
  const fixed = useContext(FixedContext);
  const addable = !fixed && depth <= MAX_BLOCK_DEPTH ? addableTypes(blocks, config, catalog) : [];
  const fittingLayouts = fixed ? [] : layouts.filter((layout) => canAdd(blocks, layout.blocks, config));
  const defaultType = defaultBlockType(addable, catalog);
  const canInsert = addable.length > 0 || fittingLayouts.length > 0;

  useEffect(() => {
    if (!removed) return;
    const timer = setTimeout(() => setRemoved(null), 8000);
    return () => clearTimeout(timer);
  }, [removed]);

  const insert = (index: number, added: Block[]) => {
    onChange(insertAt(blocks, index, added));
    setInserter(null);
    setFocusId(added[0]?.id ?? null);
    if (added[0]) selection.select(added[0].id);
  };

  const actions: ListActions = {
    move: (index, offset) => {
      if (fixed) return;
      const to = Math.max(0, Math.min(blocks.length - 1, index + offset));
      if (to === index) return;
      onChange(moveTo(blocks, index, to));
      setAnnouncement(t("stream.moved", { label: labelOf(blocks[index]), position: to + 1, count: blocks.length }));
    },
    duplicate: (index) => {
      if (!actions.canDuplicate(index)) return;
      const next = duplicateAt(blocks, index);
      onChange(next);
      setFocusId(next[index + 1].id);
      selection.select(next[index + 1].id);
      setAnnouncement(t("stream.duplicated", { label: labelOf(blocks[index]) }));
    },
    remove: (index) => {
      if (fixed) return;
      const block = blocks[index];
      onChange(removeAt(blocks, index));
      setRemoved({ block, index, label: labelOf(block) });
      setAnnouncement(t("stream.removed", { label: labelOf(block) }));
      // Focus moves to a neighbour, or back to the list's own owner when it empties.
      const neighbour = blocks[index + 1] ?? blocks[index - 1];
      selection.select(neighbour?.id ?? props.parentId);
      requestAnimationFrame(() => blockElement(neighbour?.id ?? props.parentId)?.focus());
    },
    insertNear: (index) => {
      if (fixed) return;
      if (defaultType) insert(index, [newBlock(defaultType)]);
      else if (canInsert) setInserter({ index, query: "" });
    },
    canDuplicate: (index) => !fixed && canAdd(blocks, [blocks[index]], config),
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (fixed || !over || active.id === over.id) return;
    const from = blocks.findIndex((b) => b.id === active.id);
    const to = blocks.findIndex((b) => b.id === over.id);
    onChange(moveTo(blocks, from, to));
    setAnnouncement(t("stream.moved", { label: labelOf(blocks[from]), position: to + 1, count: blocks.length }));
  };

  const onFocused = useCallback(() => setFocusId(null), []);

  const typeInAppender = (text: string) => {
    if (!text) return setDraft("");
    if (text.startsWith("/")) {
      setInserter({ index: blocks.length, query: text.slice(1) });
      setDraft("");
    } else if (defaultType) {
      insert(blocks.length, [newBlock(defaultType, typedValue(defaultType, catalog, text))]);
      setDraft("");
    } else {
      setInserter({ index: blocks.length, query: text });
      setDraft("");
    }
  };

  const panel = (index: number) => inserter?.index === index && (
    <Inserter
      types={addable}
      layouts={fittingLayouts}
      initialQuery={inserter.query}
      onPickType={(type) => insert(index, [newBlock(type)])}
      onPickLayout={(layout) => insert(index, withFreshIds(layout.blocks))}
      onClose={() => setInserter(null)}
      align={index === blocks.length ? "start" : "center"}
    />
  );

  return (
    <div className={cn("cms-bk-list", depth > 1 && "cms-bk-list-nested")} data-testid="block-list" data-path={path}>
      <DndContext id={dndId} sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={blocks.map((block) => block.id)} strategy={verticalListSortingStrategy}>
          {blocks.map((block, index) => (
            <Fragment key={block.id}>
              {canInsert && index > 0 ? <Gap index={index} open={inserter?.index === index} onOpen={(at) => setInserter({ index: at, query: "" })}>{panel(index)}</Gap> : index > 0 && <div className="cms-bk-gap" />}
              <BlockItem block={block} index={index} list={props} actions={actions} autoFocus={focusId === block.id} onFocused={onFocused} />
            </Fragment>
          ))}
        </SortableContext>
      </DndContext>
      {issues[path] && <p className="cms-error cms-mt-2">{issues[path]}</p>}
      {canInsert && (
        <div className={cn("cms-bk-appender", !blocks.length && depth === 1 && "cms-bk-appender-empty")}>
          <input
            aria-label={t("stream.addTo", { label })}
            className="cms-bk-appender-input"
            placeholder={defaultType ? t("stream.startWriting") : t("stream.typeSlash")}
            value={draft}
            onChange={(event) => typeInAppender(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); setInserter({ index: blocks.length, query: "" }); } }}
          />
          <button type="button" className="cms-bk-add" aria-label={t("stream.addBlockTo", { label })} title={t("stream.addBlock")} aria-expanded={inserter?.index === blocks.length} onClick={() => setInserter(inserter?.index === blocks.length ? null : { index: blocks.length, query: "" })}>
            <PlusIcon className="cms-icon" aria-hidden="true" />
          </button>
          {panel(blocks.length)}
        </div>
      )}
      {!canInsert && !blocks.length && <p className="cms-hint">{t("stream.noTypes")}</p>}
      <p className="cms-sr-only" aria-live="polite">{announcement}</p>
      {removed && createPortal(
        <div className="cms-toast" role="status">
          <span>{t("stream.removed", { label: removed.label })}</span>
          <button type="button" className="cms-toast-action" onClick={() => { insert(Math.min(removed.index, blocks.length), [removed.block]); setRemoved(null); }}>{t("stream.undo")}</button>
        </div>,
        document.body,
      )}
    </div>
  );
}

interface Props {
  value: unknown;
  onChange: (value: unknown) => void;
  config: StreamConfig;
  catalog: EditorCatalog;
  issues: IssueMap;
  path: string;
  depth: number;
  label?: string;
  parentId?: string | null;
}

function StreamBody({ value, onChange, config, catalog, issues, path, depth, label: given, parentId = null }: Props) {
  const { t } = useT();
  const label = given ?? t("stream.thisField");
  const blocks = Array.isArray(value) ? (value as Block[]) : [];
  const [unsavedId] = useState(() => crypto.randomUUID());
  const [layouts, setLayouts] = useState<BlockLayoutInfo[]>(catalog.blockLayouts ?? []);
  // One allowed block, at most once, is a group of fields: nothing is stored until it's filled in.
  const only = config.max === 1 && config.allowedBlocks?.length === 1 ? catalog.blockTypes.find((type) => type.name === config.allowedBlocks![0]) : undefined;
  const inline = only !== undefined && (!blocks.length || blocks[0].type === only.name);

  if (inline) {
    const block = blocks[0] ?? { id: unsavedId, type: only.name, v: only.version, value: { ...only.defaults } };
    return <InlineBlock block={block} type={only} catalog={catalog} issues={issues} path={`${path}.0`} depth={depth} onChange={(next) => onChange(Object.keys(next.value).length ? [next] : "")} />;
  }

  const list = <BlockList blocks={blocks} onChange={(next) => onChange(next.length ? next : "")} config={config} catalog={catalog} layouts={layouts} issues={issues} path={path} depth={depth} label={label} parentId={parentId} />;
  if (depth > 1) return list;
  if (config.fixed) return <FixedContext.Provider value={true}><div className="cms-stream">{list}</div></FixedContext.Provider>;
  return (
    <div className="cms-stream">
      {list}
      {catalog.canSaveLayouts && blocks.length > 0 && <div className="cms-stream-foot"><SaveLayout blocks={blocks} onSaved={(layout) => setLayouts((current) => [...current, layout])} /></div>}
    </div>
  );
}

/** A stream limited to one block of one type, shown as that block's fields. */
function InlineBlock({ block, type, catalog, issues, path, depth, onChange }: { block: Block; type: BlockTypeInfo; catalog: EditorCatalog; issues: IssueMap; path: string; depth: number; onChange: (block: Block) => void }) {
  const valueOf = (name: string) => (Object.hasOwn(block.value, name) ? block.value[name] : undefined);
  return (
    <div className="cms-stack-4 cms-box cms-box-3 cms-mt-1" data-testid="block-card" data-block-type={block.type} data-path={path}>
      {type.fields.filter((field) => isShown(field.config, valueOf) || issueFor(issues, `${path}.value.${field.name}`)).map((field) => {
        const key = `${path}.value.${field.name}`;
        return (
          <div key={field.name} data-path={key}>
            <FieldValueInput
              field={{ id: `${block.id}-${field.name}`, name: field.name, type: field.type, config: (field.config ?? null) as Record<string, unknown> | null }}
              input={catalog.fieldTypes.find((info) => info.type === field.type)?.input ?? "text"}
              value={valueOf(field.name)}
              onChange={(value) => {
                const next = { ...block.value };
                if (value === "" || value === undefined) delete next[field.name];
                else next[field.name] = value;
                onChange({ ...block, value: next });
              }}
              error={field.type === "stream" ? issues[key] : issueFor(issues, key)}
              catalog={catalog}
              issues={issues}
              issuePath={key}
              depth={depth + 1}
            />
          </div>
        );
      })}
    </div>
  );
}

/** A stream field's blocks, edited on a canvas. Outside the record editor it keeps its own selection and shows settings under each block. */
export default function StreamEditor(props: Props) {
  const outer = useEditorSelection();
  const local = useSelectionState(null);
  if (outer) return <StreamBody {...props} />;
  return <EditorSelectionContext.Provider value={local}><StreamBody {...props} /></EditorSelectionContext.Provider>;
}
