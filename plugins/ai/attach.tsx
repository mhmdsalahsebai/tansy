"use client";

import type { FileUIPart, UIMessage } from "ai";
import { adminPath, useT } from "tansy/admin";
import { useCallback, useEffect, useRef, useState } from "react";
import { addToFiles, chatCapabilities, deleteAttachment, uploadAttachment, type ChatCapabilities } from "./api";
import { attachmentType, MAX_ATTACHMENTS } from "./media";
import { Check, Cross, Icon, type ToolPart } from "./parts";

/* Files in the chat: attaching them to a message, showing them on it, and the pictures the assistant draws. */

export const Paperclip = () => <Icon><path d="m13 7.5-5.3 5.3a3.25 3.25 0 0 1-4.6-4.6l5.6-5.6a2.1 2.1 0 0 1 3 3l-5.6 5.6a1 1 0 0 1-1.4-1.4l5.2-5.2" /></Icon>;
const FileIcon = () => <Icon><path d="M9 1.75H4.5a1.5 1.5 0 0 0-1.5 1.5v9.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V5.75L9 1.75Z" /><path d="M9 1.75v4h4" /></Icon>;
const Download = () => <Icon><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" /></Icon>;

/** A file on its way into the next message. */
export interface Pending {
  key: string;
  name: string;
  mediaType: string;
  status: "uploading" | "ready" | "failed";
  /** A picture's preview while it uploads, from the browser's own copy. */
  preview?: string;
  id?: string;
  url?: string;
  error?: string;
}

const megabytes = (bytes: number) => Math.round(bytes / 1024 / 1024);

/**
 * The files the person is attaching, uploaded as soon as they're chosen so sending is quick,
 * and what the chat's model reads, so only files it can take are offered.
 */
export function useAttachments(model: string | null, enabled: boolean, provider: string | null = null) {
  const { t } = useT();
  const [capabilities, setCapabilities] = useState<ChatCapabilities | null>(null);
  const [items, setItems] = useState<Pending[]>([]);
  const counter = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void chatCapabilities(model, provider).then((value) => { if (live) setCapabilities(value); });
    return () => { live = false; };
  }, [model, enabled, provider]);

  const patch = (key: string, value: Partial<Pending>) => setItems((list) => list.map((item) => (item.key === key ? { ...item, ...value } : item)));

  // The list as last rendered, so adding files can count it without starting uploads inside a state update.
  const current = useRef(items);
  useEffect(() => { current.current = items; }, [items]);

  const add = useCallback((files: File[]) => {
    if (!capabilities || !files.length) return;
    const room = MAX_ATTACHMENTS - current.current.filter((item) => item.status !== "failed").length;
    const next: Pending[] = [];
    files.forEach((file, index) => {
      const key = `f${counter.current++}`;
      const mediaType = attachmentType(file.type, file.name);
      const fail = (error: string) => { next.push({ key, name: file.name, mediaType: file.type, status: "failed", error }); };
      if (index >= room) return fail(t("ext.ai.attach.tooMany", { count: MAX_ATTACHMENTS }));
      if (!mediaType) return fail(t("ext.ai.attach.unsupported"));
      if (!capabilities.accept.includes(mediaType)) return fail(t("ext.ai.attach.notRead", { model: capabilities.model.split("/").pop() ?? capabilities.model }));
      if (file.size > capabilities.maxBytes) return fail(t("ext.ai.attach.tooLarge", { size: megabytes(capabilities.maxBytes) }));
      const preview = mediaType.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      next.push({ key, name: file.name, mediaType, status: "uploading", preview });
      uploadAttachment(file, file.name, mediaType).then(
        (saved) => patch(key, { status: "ready", id: saved.id, url: saved.url, name: saved.name }),
        (error: unknown) => patch(key, { status: "failed", error: error instanceof Error ? error.message : t("ext.ai.attach.failed") }),
      );
    });
    setItems((list) => [...list, ...next]);
  }, [capabilities, t]);

  const remove = useCallback((key: string) => {
    const item = current.current.find((entry) => entry.key === key);
    if (item?.preview) URL.revokeObjectURL(item.preview);
    if (item?.id) void deleteAttachment(item.id);
    setItems((list) => list.filter((entry) => entry.key !== key));
  }, []);

  /** The ready files as message parts, and an empty list for the next message. Failed ones are dropped. */
  const take = useCallback((): FileUIPart[] => {
    const ready = items.filter((item) => item.status === "ready" && item.url);
    for (const item of items) if (item.preview) URL.revokeObjectURL(item.preview);
    setItems([]);
    return ready.map((item) => ({ type: "file", mediaType: item.mediaType, filename: item.name, url: item.url! }));
  }, [items]);

  /** Forgets the list without deleting what was uploaded, as when switching chats. */
  const clear = useCallback(() => {
    for (const item of current.current) if (item.preview) URL.revokeObjectURL(item.preview);
    setItems([]);
  }, []);

  return {
    capabilities,
    items,
    add,
    remove,
    take,
    clear,
    uploading: items.some((item) => item.status === "uploading"),
    ready: items.some((item) => item.status === "ready"),
  };
}

export type Attachments = ReturnType<typeof useAttachments>;

/** The files waiting to go with the next message. */
export function PendingFiles({ attachments }: { attachments: Attachments }) {
  const { t } = useT();
  if (!attachments.items.length) return null;
  return (
    <ul className="ai-files ai-files-pending" aria-label={t("ext.ai.attach.attached")}>
      {attachments.items.map((item) => (
        <li key={item.key} className={`ai-file ai-file-${item.status}`} title={item.error ?? item.name}>
          {item.preview
            // eslint-disable-next-line @next/next/no-img-element -- the browser's own copy of a file being attached, which next/image can't load
            ? <img className="ai-file-thumb" src={item.preview} alt="" />
            : <span className="ai-file-thumb ai-file-thumb-icon"><FileIcon /></span>}
          <span className="ai-file-text">
            <span className="ai-file-name">{item.name}</span>
            <span className="ai-file-note">{item.status === "uploading" ? t("ext.ai.attach.uploading") : item.status === "failed" ? item.error : ""}</span>
          </span>
          {item.status === "uploading" && <span className="ai-spinner" aria-hidden="true" />}
          <button type="button" className="ai-file-remove" aria-label={t("ext.ai.attach.remove", { name: item.name })} title={t("ext.ai.attach.remove", { name: item.name })} onClick={() => attachments.remove(item.key)}><Cross /></button>
        </li>
      ))}
    </ul>
  );
}

/** The button that opens the file picker, offering only what the model reads. */
export function AttachButton({ attachments, disabled }: { attachments: Attachments; disabled: boolean }) {
  const { t } = useT();
  const input = useRef<HTMLInputElement>(null);
  const accept = attachments.capabilities?.accept ?? [];
  if (!attachments.capabilities) return null;
  return (
    <>
      <button type="button" className="ai-pill ai-pill-icon" aria-label={t("ext.ai.attach.button")} title={t("ext.ai.attach.hint")} disabled={disabled} onClick={() => input.current?.click()}><Paperclip /></button>
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept={[...accept, ".md", ".markdown", ".csv", ".txt"].join(",")}
        onChange={(event) => { attachments.add(Array.from(event.target.files ?? [])); event.target.value = ""; }}
      />
    </>
  );
}

/** The files on a message the person sent: pictures as thumbnails, anything else by name. */
export function SentFiles({ message }: { message: UIMessage }) {
  const files = message.parts.filter((part): part is FileUIPart => part.type === "file");
  if (!files.length) return null;
  return (
    <ul className="ai-files ai-files-sent">
      {files.map((file, index) => (
        <li key={index}>
          <a className={file.mediaType.startsWith("image/") ? "ai-file ai-file-image" : "ai-file"} href={file.url} target="_blank" rel="noreferrer" title={file.filename}>
            {file.mediaType.startsWith("image/")
              // eslint-disable-next-line @next/next/no-img-element -- the person's own attachment, served behind their session, which next/image can't fetch
              ? <img className="ai-file-picture" src={file.url} alt={file.filename ?? ""} loading="lazy" />
              : <><span className="ai-file-thumb ai-file-thumb-icon"><FileIcon /></span><span className="ai-file-text"><span className="ai-file-name">{file.filename ?? file.mediaType}</span></span></>}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** A picture the assistant drew: shown in the chat, with a download and a way into the site's files. */
export function PictureCard({ part }: { part: ToolPart }) {
  const { t } = useT();
  const [added, setAdded] = useState<"no" | "adding" | "yes" | string>("no");
  const output = part.state === "output-available" ? (part.output as { image?: { url: string; name: string }; error?: { message?: string } } | null) : null;
  const prompt = (part.input as { prompt?: unknown } | undefined)?.prompt;
  if (part.state === "output-error" || output?.error) {
    return <div className="ai-tool ai-tool-failed"><p className="ai-tool-error">{t("ext.ai.picture.failed")} {part.state === "output-error" ? part.errorText : output?.error?.message}</p></div>;
  }
  if (!output?.image) {
    return <div className="ai-picture ai-picture-working" role="status"><span className="ai-spinner" aria-hidden="true" /><span className="ai-shimmer">{t("ext.ai.picture.drawing")}</span></div>;
  }
  const { url, name } = output.image;
  const add = () => {
    setAdded("adding");
    addToFiles(url, name).then(() => setAdded("yes"), (error: unknown) => setAdded(error instanceof Error ? error.message : t("ext.ai.picture.addFailed")));
  };
  return (
    <figure className="ai-picture">
      <a href={url} target="_blank" rel="noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element -- a picture kept behind the person's session, which next/image can't fetch */}
        <img src={url} alt={typeof prompt === "string" ? prompt : ""} loading="lazy" />
      </a>
      <figcaption className="ai-picture-bar">
        <a className="ai-ghost" href={url} download={name}><Download /><span>{t("ext.ai.picture.download")}</span></a>
        {added === "yes"
          ? <a className="ai-ghost" href={adminPath("/files")}><Check /><span>{t("ext.ai.picture.added")}</span></a>
          : <button type="button" className="ai-ghost" disabled={added === "adding"} onClick={add}><FileIcon /><span>{added === "adding" ? t("ext.ai.picture.adding") : t("ext.ai.picture.addToFiles")}</span></button>}
        {added !== "no" && added !== "adding" && added !== "yes" && <span className="ai-tool-error" role="alert">{added}</span>}
      </figcaption>
    </figure>
  );
}
