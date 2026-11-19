"use client";

import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extensions";
import {
  ArrowUturnLeftIcon, ArrowUturnRightIcon, BoldIcon, ChatBubbleLeftIcon, CodeBracketIcon, H2Icon, H3Icon, ItalicIcon, LinkIcon,
  ListBulletIcon, NumberedListIcon, StrikethroughIcon, UnderlineIcon,
} from "@heroicons/react/16/solid";
import { useRef, useState, type ComponentType, type KeyboardEvent, type SVGProps } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";
import { featureSet, RICH_MARKS, RICH_NODES, safeHref, type RichNode } from "../../core/fields/rich-text";
import { useToolbarSlot } from "../stream/editor-context";
import { useT } from "../i18n";
import { Button } from "../ui/kit";
import type { en } from "../../core/i18n/catalogs/en";

interface Props {
  value: unknown;
  onChange: (value: unknown) => void;
  allowedFeatures?: string[] | Record<string, boolean>;
  label: string;
  /** "bare" has no border and shows its toolbar in the selected block's, for editing on the canvas. */
  variant?: "boxed" | "bare";
  placeholder?: string;
  id?: string;
  readOnly?: boolean;
}

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
type ToolName = Exclude<keyof typeof en.richText, "withKeys" | "formatting" | "linkUrl" | "apply" | "remove" | "badLink" | "link">;
interface Tool { feature: string; icon: Icon; title: ToolName; keys?: string; run: (editor: Editor) => void; active?: (editor: Editor) => boolean }

const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

const TOOLS: Tool[][] = [
  [
    { feature: "bold", icon: BoldIcon, title: "bold", keys: `${mod}B`, run: (e) => e.chain().focus().toggleBold().run(), active: (e) => e.isActive("bold") },
    { feature: "italic", icon: ItalicIcon, title: "italic", keys: `${mod}I`, run: (e) => e.chain().focus().toggleItalic().run(), active: (e) => e.isActive("italic") },
    { feature: "underline", icon: UnderlineIcon, title: "underline", keys: `${mod}U`, run: (e) => e.chain().focus().toggleUnderline().run(), active: (e) => e.isActive("underline") },
    { feature: "strike", icon: StrikethroughIcon, title: "strike", run: (e) => e.chain().focus().toggleStrike().run(), active: (e) => e.isActive("strike") },
    { feature: "code", icon: CodeBracketIcon, title: "code", run: (e) => e.chain().focus().toggleCode().run(), active: (e) => e.isActive("code") },
  ],
  [
    { feature: "heading", icon: H2Icon, title: "heading", keys: "## ", run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), active: (e) => e.isActive("heading", { level: 2 }) },
    { feature: "heading", icon: H3Icon, title: "subheading", keys: "### ", run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(), active: (e) => e.isActive("heading", { level: 3 }) },
    { feature: "bulletList", icon: ListBulletIcon, title: "bulletList", keys: "- ", run: (e) => e.chain().focus().toggleBulletList().run(), active: (e) => e.isActive("bulletList") },
    { feature: "orderedList", icon: NumberedListIcon, title: "orderedList", keys: "1. ", run: (e) => e.chain().focus().toggleOrderedList().run(), active: (e) => e.isActive("orderedList") },
    { feature: "blockquote", icon: ChatBubbleLeftIcon, title: "quote", keys: "> ", run: (e) => e.chain().focus().toggleBlockquote().run(), active: (e) => e.isActive("blockquote") },
  ],
];

const HISTORY: Tool[] = [
  { feature: "", icon: ArrowUturnLeftIcon, title: "undo", keys: `${mod}Z`, run: (e) => e.chain().focus().undo().run() },
  { feature: "", icon: ArrowUturnRightIcon, title: "redo", keys: `${mod}⇧Z`, run: (e) => e.chain().focus().redo().run() },
];

function ToolButton({ tool, editor }: { tool: Tool; editor: Editor }) {
  const { t } = useT();
  const active = tool.active?.(editor) ?? false;
  const name = t(`richText.${tool.title}`);
  const label = tool.keys ? t("richText.withKeys", { label: name, keys: tool.keys.trim() }) : name;
  return (
    <button
      type="button"
      title={label}
      aria-label={name}
      aria-pressed={tool.active ? active : undefined}
      // Keeps the selection in the editor, so the command applies to it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => tool.run(editor)}
      className={cn("cms-tool", active && "cms-tool-active")}
    >
      <tool.icon className="cms-icon" aria-hidden="true" />
    </button>
  );
}

export default function RichTextEditor({ value, onChange, allowedFeatures, label, variant = "boxed", placeholder, id, readOnly }: Props) {
  const { t } = useT();
  const allowed = featureSet(allowedFeatures);
  const permits = (feature: string) => !feature || !allowed || allowed.has(feature);
  const [link, setLink] = useState<string | null>(null);
  const [linkError, setLinkError] = useState(false);
  const [focused, setFocused] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const slot = useToolbarSlot();
  const bare = variant === "bare";

  // Switching a feature off in the schema also stops it arriving by paste.
  const disabled = Object.fromEntries([...RICH_NODES, ...RICH_MARKS].filter((name) => !permits(name)).map((name) => [name, false]));
  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    editable: !readOnly,
    extensions: [
      StarterKit.configure({ ...disabled, ...(permits("link") ? { link: { openOnClick: false, isAllowedUri: (url: string) => safeHref(url) !== null } } : {}) }),
      Placeholder.configure({ placeholder: placeholder ?? "" }),
    ],
    content: value && typeof value === "object" ? (value as RichNode) : undefined,
    editorProps: { attributes: { class: cn("cms-rich-text", bare ? "cms-rte-bare-area" : "cms-editor-area"), "aria-label": label, ...(id ? { id } : {}) } },
    onUpdate: ({ editor: current }) => onChange(current.isEmpty ? "" : current.getJSON()),
    onFocus: () => setFocused(true),
    onBlur: ({ event }) => {
      // Moving into this editor's own toolbar, such as the link box, keeps it showing.
      if (!(event.relatedTarget instanceof Node && toolbarRef.current?.contains(event.relatedTarget))) setFocused(false);
    },
  });

  const openLink = () => {
    if (!editor) return;
    setLinkError(false);
    setLink(editor.getAttributes("link").href ?? "");
  };
  const applyLink = () => {
    if (!editor || link === null) return;
    if (link.trim() === "") editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else if (safeHref(link.trim())) editor.chain().focus().extendMarkRange("link").setLink({ href: link.trim() }).run();
    else return setLinkError(true);
    setLink(null);
  };
  const onLinkKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); applyLink(); }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setLink(null); editor?.commands.focus(); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && permits("link")) {
      event.preventDefault();
      openLink();
    }
  };

  const toolbar = editor && !readOnly && (
    <div ref={toolbarRef} role="toolbar" aria-label={t("richText.formatting", { label })} className={bare ? "cms-rte-toolbar" : "cms-editor-toolbar"}>
      {TOOLS.map((group, index) => {
        const tools = group.filter((tool) => permits(tool.feature));
        return tools.length ? <span key={index} className="cms-tool-group">{tools.map((tool) => <ToolButton key={tool.title} tool={tool} editor={editor} />)}</span> : null;
      })}
      {permits("link") && (
        <span className="cms-tool-group">
          <button type="button" title={t("richText.withKeys", { label: t("richText.link"), keys: `${mod}K` })} aria-label={t("richText.link")} aria-pressed={editor.isActive("link")} onMouseDown={(event) => event.preventDefault()} onClick={openLink} className={cn("cms-tool", editor.isActive("link") && "cms-tool-active")}>
            <LinkIcon className="cms-icon" aria-hidden="true" />
          </button>
        </span>
      )}
      {!bare && <span className="cms-tool-group cms-ml-auto">{HISTORY.map((tool) => <ToolButton key={tool.title} tool={tool} editor={editor} />)}</span>}
      {link !== null && (
        <div className="cms-link-box" role="group" aria-label={t("richText.link")}>
          <input autoFocus aria-label={t("richText.linkUrl")} placeholder="https://example.com" className="cms-input" value={link} onChange={(event) => { setLink(event.target.value); setLinkError(false); }} onKeyDown={onLinkKey} />
          <Button onClick={applyLink}>{link.trim() ? t("richText.apply") : t("richText.remove")}</Button>
          {linkError && <p className="cms-error cms-w-full">{t("richText.badLink")}</p>}
        </div>
      )}
    </div>
  );

  // On the canvas the toolbar joins the selected block's, and floats above the text anywhere else.
  const showBareToolbar = focused || link !== null;
  return (
    <div className={bare ? "cms-rte-bare" : "cms-editor"} data-testid="rich-text-editor" onKeyDown={onKeyDown}>
      {!bare && toolbar}
      {bare && showBareToolbar && toolbar && (slot ? createPortal(toolbar, slot) : <div className="cms-rte-float">{toolbar}</div>)}
      <EditorContent editor={editor} />
    </div>
  );
}
