"use client";

import { useT, type BlockEditorDefinition, type BlockEditorProps } from "tansy/admin";
import { embedUrl } from "./text";
import "./blog.css";

/*
 * The blog's blocks on the editor's canvas, built from the same markup and classes as
 * render.tsx, so they look as they will on the site and are edited in place.
 */

const text = (value: unknown) => (typeof value === "string" ? value : "");
const TONES = ["info", "tip", "warning"];

function TextEditor({ Field }: BlockEditorProps) {
  const { t } = useT();
  return <Field name="body" placeholder={t("ext.blog.editors.startWriting")} />;
}

function QuoteEditor({ block, selected, Field }: BlockEditorProps) {
  const { t } = useT();
  return (
    <blockquote className="bl-quote">
      <Field name="text" placeholder={t("ext.blog.editors.quote")} />
      {(selected || text(block.value.source)) && <div className="bl-quote-source"><Field name="source" placeholder={t("ext.blog.editors.source")} /></div>}
    </blockquote>
  );
}

function CalloutEditor({ block, Field }: BlockEditorProps) {
  const { t } = useT();
  const tone = TONES.includes(text(block.value.tone)) ? text(block.value.tone) : "info";
  return <aside className={`bl-callout bl-callout-${tone}`}><Field name="body" placeholder={t("ext.blog.editors.note")} /></aside>;
}

function ImageEditor({ block, selected, Field }: BlockEditorProps) {
  const { t } = useT();
  return (
    <figure className="bl-figure">
      <Field name="image" placeholder={t("ext.blog.editors.image")} />
      {(selected || text(block.value.caption)) && <figcaption><Field name="caption" placeholder={t("ext.blog.editors.caption")} /></figcaption>}
      {selected && <div className="bl-editor-note"><Field name="alt" placeholder={t("ext.blog.editors.alt")} /></div>}
    </figure>
  );
}

function EmbedEditor({ block, selected, Field }: BlockEditorProps) {
  const { t } = useT();
  const src = embedUrl(text(block.value.url));
  return (
    <figure className="bl-figure">
      {src
        // Inert until selected, so a click selects the block rather than playing the video.
        ? <div className="bl-embed" inert={!selected}><iframe src={src} title={text(block.value.caption) || t("ext.blog.editors.video")} loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" /></div>
        : <div className="bl-editor-placeholder"><p>{t("ext.blog.editors.pasteVideo")}</p><Field name="url" /></div>}
      {(selected || text(block.value.caption)) && <figcaption><Field name="caption" placeholder={t("ext.blog.editors.caption")} /></figcaption>}
    </figure>
  );
}

function CodeEditor({ block, selected, Field }: BlockEditorProps) {
  const { t } = useT();
  return (
    <div className="bl-code">
      <Field name="code" placeholder={t("ext.blog.editors.code")} />
      {(selected || text(block.value.language)) && <div className="bl-editor-note"><Field name="language" placeholder={t("ext.blog.editors.language")} /></div>}
    </div>
  );
}

export const blockEditors: BlockEditorDefinition[] = [
  { blocks: ["blog_text"], component: TextEditor },
  { blocks: ["blog_quote"], component: QuoteEditor },
  { blocks: ["blog_callout"], component: CalloutEditor },
  { blocks: ["blog_image"], component: ImageEditor },
  { blocks: ["blog_embed"], component: EmbedEditor },
  { blocks: ["blog_code"], component: CodeEditor },
];
