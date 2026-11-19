"use client";

import { useId, useState, type FormEvent } from "react";
import { apiPath, type SiteWords } from "tansy/react";
import { blogWords } from "./site-messages";

export interface PublicComment { id: number; name: string; body: string; parent: number | null; createdAt: string; pending?: boolean }

type Words = ReturnType<typeof blogWords>;

function CommentForm({ postId, parent, onPosted, onCancel, words }: { postId: number; parent: number | null; onPosted(comment: PublicComment): void; onCancel?(): void; words: Words }) {
  const { t } = words;
  const id = useId();
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setError(null);
    try {
      const response = await fetch(apiPath("/collections/blog-comments/records"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ post: postId, name, body, ...(parent ? { parent } : {}) }),
      });
      const json = await response.json().catch(() => null) as { id?: number; state?: string; createdAt?: string } | null;
      if (response.status === 401 || response.status === 403) return setError(t("blog.signIn"));
      if (!response.ok || typeof json?.id !== "number") return setError(t("blog.failed"));
      onPosted({ id: json.id, name, body, parent, createdAt: json.createdAt ?? new Date().toISOString(), pending: json.state !== "approved" });
      setBody("");
    } catch {
      setError(t("blog.offline"));
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="bl-form" onSubmit={submit}>
      <label htmlFor={`${id}-name`}>{t("blog.name")}</label>
      <input id={`${id}-name`} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required autoComplete="name" />
      <label htmlFor={`${id}-body`}>{parent ? t("blog.reply") : t("blog.comment")}</label>
      <textarea id={`${id}-body`} value={body} onChange={(event) => setBody(event.target.value)} maxLength={5000} rows={4} required />
      {error && <p className="bl-error" role="alert">{error}</p>}
      <p className="bl-actions">
        <button type="submit" disabled={sending}>{sending ? t("blog.posting") : parent ? t("blog.postReply") : t("blog.postComment")}</button>
        {onCancel && <button type="button" onClick={onCancel}>{t("blog.cancel")}</button>}
      </p>
    </form>
  );
}

function Entry({ comment, children, words }: { comment: PublicComment; children?: React.ReactNode; words: Words }) {
  return (
    <li className="bl-comment">
      <p className="bl-meta"><strong>{comment.name}</strong> · <time dateTime={comment.createdAt}>{comment.createdAt ? words.formatDate(comment.createdAt) : ""}</time>{comment.pending && <> · {words.t("blog.waiting")}</>}</p>
      {/* Plain text: line breaks are kept by CSS, and nothing is read as markup. */}
      <p className="bl-comment-body">{comment.body}</p>
      {children}
    </li>
  );
}

/** Approved comments from the page, plus the reader's own new ones. Replies go one level deep. */
export function Comments({ postId, initial, words: given }: { postId: number; initial: PublicComment[]; words?: SiteWords }) {
  const words = blogWords(given);
  const { t } = words;
  const [comments, setComments] = useState(initial);
  const [replyingTo, setReplyingTo] = useState<number | null>(null);
  const add = (comment: PublicComment) => {
    setComments((current) => [...current, comment]);
    setReplyingTo(null);
  };
  const topLevel = comments.filter((comment) => !comment.parent);

  return (
    <section className="bl-comments" aria-labelledby="bl-comments-title">
      <h2 id="bl-comments-title">{t("blog.comments")}</h2>
      {topLevel.length === 0 && <p className="bl-muted">{t("blog.noComments")}</p>}
      <ol className="bl-thread">
        {topLevel.map((comment) => {
          const replies = comments.filter((reply) => reply.parent === comment.id);
          return (
            <Entry key={comment.id} comment={comment} words={words}>
              {replies.length > 0 && <ol className="bl-thread">{replies.map((reply) => <Entry key={reply.id} comment={reply} words={words} />)}</ol>}
              {!comment.pending && (replyingTo === comment.id
                ? <CommentForm postId={postId} parent={comment.id} onPosted={add} onCancel={() => setReplyingTo(null)} words={words} />
                : <button type="button" className="bl-link" onClick={() => setReplyingTo(comment.id)}>{t("blog.reply")}</button>)}
            </Entry>
          );
        })}
      </ol>
      <h3>{t("blog.leaveComment")}</h3>
      <CommentForm postId={postId} parent={null} onPosted={add} words={words} />
    </section>
  );
}
