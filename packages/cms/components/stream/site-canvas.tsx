"use client";

import { DocumentIcon, PhotoIcon } from "@heroicons/react/24/outline";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { Block } from "../../core/blocks/limits";
import type { SitePreview } from "../../core/extend/admin";
import { siteTokenDeclarations } from "../../core/theme/tokens";
import { useApi } from "../../lib/client/api";
import { apiPath } from "../../lib/paths";
import { cn } from "../../lib/utils";
import FileValueInput from "../fields/FileValueInput";
import { formatBytes, type FileInfo } from "../fields/types";
import { StreamField } from "./StreamField";
import { useT } from "../i18n";

const own = <T,>(map: Record<string, T> | undefined, name: string) => (map && Object.hasOwn(map, name) ? map[name] : undefined);

/** Whether the theme renders this block itself, rather than leaving it to its plugin. */
export const themeRenders = (site: SitePreview | null, type: string) => Boolean(own(site?.theme?.blocks, type));

/** Whether the site has a component for this block, from its theme or a plugin. */
export const siteRenders = (site: SitePreview | null, type: string) => Boolean(own(site?.theme?.blocks, type) ?? own(site?.renderers.blocks, type));

/**
 * Wraps canvas content in the site's root class, tokens and font, so the theme's and
 * plugins' styles apply as they do on the site. Their stylesheets are scoped to their own
 * classes, so nothing leaks into the dashboard.
 */
export function SiteFrame({ site, children }: { site: SitePreview | null; children: ReactNode }) {
  const tokens = siteTokenDeclarations(site?.tokens ?? {});
  return (
    // A theme may give its root a full-screen height, which a single block mustn't take.
    <div className={cn("cms-site-frame site-root", site?.theme?.fontClassName)} style={{ minHeight: 0 }} data-site-frame="">
      {/* React keeps one copy of a style with an href, however many blocks render it. */}
      {tokens && <style href="site-tokens" precedence="default">{`.cms-site-frame{${tokens}}`}</style>}
      {children}
    </div>
  );
}

const SHOWS_SOMETHING = "img, picture, video, audio, iframe, svg, canvas, hr, object";

/**
 * A block as the site renders it, shown while it isn't being edited. It can't be used,
 * so links, forms and players do nothing until the block is selected. A block that renders
 * nothing, such as a new one, is reported so the editor shows its fields instead.
 */
export function BlockPreview({ block, site, label, onEdit, onEmpty }: { block: Block; site: SitePreview; label: string; onEdit: () => void; onEmpty: () => void }) {
  const { t } = useT();
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = content.current;
    if (element && !element.textContent?.trim() && !element.querySelector(SHOWS_SOMETHING)) onEmpty();
  });
  return (
    <div className="cms-bk-preview" data-testid="block-preview">
      <SiteFrame site={site}>
        <div ref={content} inert>
          <StreamField blocks={[block]} theme={site.theme ?? undefined} renderers={site.renderers} />
        </div>
      </SiteFrame>
      <button
        type="button"
        className="cms-bk-preview-hit"
        aria-label={t("stream.editBlock", { label })}
        // Before the block swaps to its fields, so focus lands in them rather than on this button.
        onPointerDown={(event) => { event.preventDefault(); onEdit(); }}
        onClick={(event) => { if (event.detail === 0) onEdit(); }}
      />
    </div>
  );
}

const RASTER = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];

function MediaItem({ fileId }: { fileId: string }) {
  const { t } = useT();
  const { data, error } = useApi<FileInfo>(apiPath(`/files/${encodeURIComponent(fileId)}/info`));
  const href = apiPath(`/files/${encodeURIComponent(fileId)}`);
  if (data && RASTER.includes(data.type)) {
    // eslint-disable-next-line @next/next/no-img-element -- access-checked API URL, which next/image can't fetch with the viewer's session
    return <img className="cms-media-img" src={apiPath(`/files/${encodeURIComponent(fileId)}?thumb=800x0`)} alt={data.alt} width={data.width ?? undefined} height={data.height ?? undefined} />;
  }
  if (data?.type.startsWith("video/")) return <video className="cms-media-img" src={href} controls preload="metadata" />;
  if (data?.type.startsWith("audio/")) return <audio className="cms-media-audio" src={href} controls preload="metadata" />;
  return (
    <span className="cms-media-file">
      <DocumentIcon className="cms-media-file-icon" aria-hidden="true" />
      <span className="cms-min-0">
        <span className="cms-block cms-truncate cms-medium cms-strong">{data?.name ?? (error ? t("stream.fileUnavailable") : t("stream.loading"))}</span>
        {data && <span className="cms-faded">{t("pickers.fileMeta", { type: data.type, size: formatBytes(data.size) })}</span>}
      </span>
    </span>
  );
}

/**
 * Images and files on a block's canvas: the media itself, with the controls to change it
 * once the block is selected, and a placeholder to add some while it's empty.
 */
export function CanvasMedia({ id, kind, value, onChange, allowedTypes, label, selected }: {
  id: string;
  kind: "image" | "file" | "gallery";
  value: unknown;
  onChange: (value: unknown) => void;
  allowedTypes?: string[];
  label: string;
  selected: boolean;
}) {
  const files = (Array.isArray(value) ? value : typeof value === "string" && value ? [value] : []).filter((item): item is string => typeof item === "string");
  const controls = <FileValueInput id={id} kind={kind} value={value} onChange={onChange} allowedTypes={allowedTypes} />;
  if (!files.length) {
    return (
      <div className="cms-media-empty">
        <span className="cms-media-empty-head">
          {kind === "file" ? <DocumentIcon className="cms-icon" aria-hidden="true" /> : <PhotoIcon className="cms-icon" aria-hidden="true" />}
          <span className="cms-medium cms-strong">{label}</span>
        </span>
        {controls}
      </div>
    );
  }
  return (
    <div className="cms-media">
      <div className={cn(kind === "gallery" && files.length > 1 && "cms-media-grid")}>
        {files.map((fileId) => <MediaItem key={fileId} fileId={fileId} />)}
      </div>
      {selected && <div className="cms-media-controls">{controls}</div>}
    </div>
  );
}

/** A video from a link, shown on the canvas as the site will embed it. */
export function CanvasEmbed({ src, title }: { src: string; title: string }) {
  return (
    <div className="cms-media-embed">
      <iframe src={src} title={title} loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" />
    </div>
  );
}
