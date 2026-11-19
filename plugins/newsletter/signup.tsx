"use client";

import { useEffect, useId, useState, useSyncExternalStore, type FormEvent } from "react";
import { apiPath, CaptchaWidget, contentLocale, siteWords, type CaptchaWidgetConfig, type SiteWords } from "tansy/react";
import { siteMessages } from "./site-messages";

const ENGLISH: SiteWords = { locale: "en", messages: siteMessages.en };

interface Shared {
  /** The CMS's API, such as https://cms.example.com/api, for a site on another address. This app's own when left out. */
  api?: string;
  /** The page's words, `pickWords(words, "newsletter")` from a template or block. English without them. */
  words?: SiteWords;
}

const baseOf = (api?: string) => (api ?? apiPath("")).replace(/\/+$/, "");

type Answer = { message?: string; error?: { code?: string; message?: string } } | null;

async function post(url: string, body: unknown): Promise<{ ok: boolean; status: number; json: Answer }> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: response.ok, status: response.status, json: await response.json().catch(() => null) as Answer };
}

export interface SignupFormProps extends Shared {
  title?: string;
  text?: string;
  buttonLabel?: string;
  /** Ask for a name as well as the address. */
  askName?: boolean;
}

/**
 * The newsletter's sign-up form, through the plugin's routes. Works on any page, and on a
 * headless site given `api`. The server checks everything again, and answers the same
 * whether or not the address was on the list already.
 */
export function SignupForm({ title, text, buttonLabel, askName, api, words }: SignupFormProps) {
  const { t } = siteWords(words ?? ENGLISH);
  const locale = contentLocale(words);
  const base = baseOf(api);
  const id = useId();
  const [form, setForm] = useState<{ captcha: CaptchaWidgetConfig | null; token: string } | null>(null);
  const [version, setVersion] = useState(0);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [trap, setTrap] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`${base}/ext/newsletter/signup`, { cache: "no-store" }).then((response) => (response.ok ? response.json() : null)).then((json) => { if (live) setForm(json); }).catch(() => {});
    return () => { live = false; };
  }, [base, version]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setSending(true);
    setProblem(null);
    try {
      const result = await post(`${base}/ext/newsletter/subscribe`, { email, ...(askName && name ? { name } : {}), token: form.token, website: trap, page: window.location.pathname, ...(answer ? { answer } : {}), ...(locale ? { locale } : {}) });
      if (result.ok) return setDone(result.json?.message ?? t("newsletter.checkInbox"));
      setProblem(result.status === 429 ? t("newsletter.tooMany") : result.json?.error?.message ?? t("newsletter.failed"));
      if (result.json?.error?.code === "FORM_EXPIRED") setVersion((value) => value + 1);
      if (form.captcha) setAttempt((value) => value + 1);
    } catch {
      setProblem(t("newsletter.offline"));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="nl-signup">
      {title && <h2>{title}</h2>}
      {text && <p className="nl-text">{text}</p>}
      {done !== null ? <p className="nl-done" role="status">{done}</p> : (
        <form className="nl-form" onSubmit={submit}>
          {askName && (
            <div className="nl-field">
              <label htmlFor={`${id}-name`}>{t("newsletter.name")}</label>
              <input id={`${id}-name`} name="name" autoComplete="name" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
            </div>
          )}
          <div className="nl-field">
            <label htmlFor={`${id}-email`}>{t("newsletter.email")}</label>
            <div className="nl-inline">
              <input id={`${id}-email`} name="email" type="email" required autoComplete="email" maxLength={254} placeholder={t("newsletter.emailPlaceholder")} value={email} onChange={(event) => setEmail(event.target.value)} />
              <button type="submit" disabled={!form || sending || (form.captcha !== null && !answer)}>{sending ? t("newsletter.subscribing") : buttonLabel || t("newsletter.subscribe")}</button>
            </div>
          </div>
          {/* People never see this. A script that fills in every field fills it in too. */}
          <div className="nl-trap" aria-hidden="true">
            <label htmlFor={`${id}-website`}>{t("newsletter.trap")}</label>
            <input id={`${id}-website`} name="website" tabIndex={-1} autoComplete="off" value={trap} onChange={(event) => setTrap(event.target.value)} />
          </div>
          {form?.captcha && <CaptchaWidget config={form.captcha} attempt={attempt} onAnswer={setAnswer} />}
          {problem && <p className="nl-error" role="alert">{problem}</p>}
        </form>
      )}
    </section>
  );
}

/** A token after `#` in the page's address, as the newsletter's emails link to it. */
function fromHash(hash: string): { action: "confirm" | "unsubscribe"; token: string } | null {
  const match = /^#(confirm|unsubscribe)=([A-Za-z0-9.]{1,200})$/.exec(hash);
  return match ? { action: match[1] as "confirm" | "unsubscribe", token: match[2] } : null;
}

const onHashChange = (callback: () => void) => {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
};

/** The address's hash in the browser. Null on the server, which never sees it. */
const useHash = () => useSyncExternalStore(onHashChange, () => window.location.hash, () => null);

/**
 * The newsletter page's own part: confirming an address, or unsubscribing, from the links in
 * the newsletter's emails, and otherwise the sign-up form. A confirmation runs as the page
 * opens, which mail scanners that only fetch the link never do. Unsubscribing asks first.
 */
export function NewsletterManager({ api, words, signup }: Shared & { signup?: Omit<SignupFormProps, keyof Shared> }) {
  const { t } = siteWords(words ?? ENGLISH);
  const locale = contentLocale(words);
  const base = baseOf(api);
  const hash = useHash();
  const link = hash === null ? undefined : fromHash(hash);
  const action = link?.action;
  const token = link?.token;
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [holder, setHolder] = useState<{ email: string; unsubscribed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const query = locale ? `?locale=${encodeURIComponent(locale)}` : "";

  useEffect(() => {
    if (!action || !token) return;
    let live = true;
    if (action === "confirm") {
      post(`${base}/ext/newsletter/confirm`, { token, ...(locale ? { locale } : {}) })
        .then((result) => { if (live) setMessage({ text: result.json?.message ?? result.json?.error?.message ?? t("newsletter.failed"), error: !result.ok }); })
        .catch(() => { if (live) setMessage({ text: t("newsletter.offline"), error: true }); });
    } else {
      fetch(`${base}/ext/newsletter/unsubscribe/${token}${query}`, { cache: "no-store" })
        .then(async (response) => {
          const json = await response.json().catch(() => null) as { email?: string; unsubscribed?: boolean; error?: { message?: string } } | null;
          if (!live) return;
          if (response.ok && json) setHolder({ email: json.email ?? "", unsubscribed: json.unsubscribed === true });
          else setMessage({ text: json?.error?.message ?? t("newsletter.refusals.invalidLink"), error: true });
        })
        .catch(() => { if (live) setMessage({ text: t("newsletter.offline"), error: true }); });
    }
    return () => { live = false; };
    // Once per link, whatever the words.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, token, base]);

  async function unsubscribe() {
    if (link?.action !== "unsubscribe") return;
    setBusy(true);
    try {
      const result = await post(`${base}/ext/newsletter/unsubscribe/${link.token}${query}`, {});
      setMessage({ text: result.json?.message ?? result.json?.error?.message ?? t("newsletter.failed"), error: !result.ok });
    } catch {
      setMessage({ text: t("newsletter.offline"), error: true });
    } finally {
      setBusy(false);
    }
  }

  if (link === undefined) return null;
  if (!link) return <SignupForm {...signup} api={api} words={words} />;
  if (message) return <p className={message.error ? "nl-error nl-message" : "nl-done"} role="status">{message.text}</p>;
  if (link.action === "confirm") return <p className="nl-done" aria-busy="true">{t("newsletter.confirming")}</p>;
  if (!holder) return null;
  if (holder.unsubscribed) return <p className="nl-done">{t("newsletter.alreadyUnsubscribed")}</p>;
  return (
    <div className="nl-form">
      <p>{t("newsletter.unsubscribeQuestion", { email: holder.email })}</p>
      <p><button type="button" disabled={busy} onClick={() => void unsubscribe()}>{busy ? t("newsletter.unsubscribing") : t("newsletter.unsubscribeButton")}</button></p>
    </div>
  );
}
