"use client";

import { useEffect, useRef } from "react";
import type { CaptchaWidgetConfig } from "../../core/captcha/types";

/** What Turnstile, hCaptcha and reCAPTCHA all define on their global. */
interface CaptchaApi {
  render(element: HTMLElement, options: Record<string, unknown>): string | number;
  reset(id?: string | number): void;
}

const scripts = new Map<string, Promise<void>>();
const apiOf = (global: string) => (window as unknown as Record<string, CaptchaApi | undefined>)[global];
const usable = (global: string) => typeof apiOf(global)?.render === "function";

/**
 * Loads the provider's script once per page. It's done when the provider calls `onload`,
 * or when the script has run and its global can already render. The script is trusted
 * through the page's nonce, under 'strict-dynamic'.
 */
function load(script: string, global: string): Promise<void> {
  if (usable(global)) return Promise.resolve();
  let loading = scripts.get(script);
  if (!loading) {
    loading = new Promise<void>((resolve, reject) => {
      const callback = `__cmsCaptchaLoaded${scripts.size}`;
      (window as unknown as Record<string, unknown>)[callback] = () => resolve();
      const element = document.createElement("script");
      const url = new URL(script);
      url.searchParams.set("onload", callback);
      element.src = url.toString();
      element.async = true;
      element.onload = () => { if (usable(global)) resolve(); };
      element.onerror = () => { scripts.delete(script); reject(new Error("The CAPTCHA could not be loaded.")); };
      document.head.appendChild(element);
    });
    scripts.set(script, loading);
  }
  return loading;
}

export interface CaptchaWidgetProps {
  /** From `captcha` in /api/auth-config, or a plugin's own route. */
  config: CaptchaWidgetConfig;
  /** The answer to send, or null when it expired or failed, so the form waits for a new one. */
  onAnswer: (answer: string | null) => void;
  /** Raise it after each failed submit: an answer works only once, so the widget starts again. */
  attempt?: number;
}

/**
 * The site's CAPTCHA, whichever provider it uses. Send its answer with the form, as the
 * `x-captcha-response` header for sign-in, or however the form's route asks.
 */
export function CaptchaWidget({ config, onAnswer, attempt = 0 }: CaptchaWidgetProps) {
  const element = useRef<HTMLDivElement>(null);
  const rendered = useRef<string | number | null>(null);
  const answer = useRef(onAnswer);
  const options = JSON.stringify(config.options ?? {});

  useEffect(() => { answer.current = onAnswer; }, [onAnswer]);

  useEffect(() => {
    let cancelled = false;
    load(config.script, config.global).then(() => {
      const api = apiOf(config.global);
      if (cancelled || !element.current || rendered.current !== null || !api) return;
      rendered.current = api.render(element.current, {
        ...(JSON.parse(options) as Record<string, unknown>),
        sitekey: config.siteKey,
        callback: (token: string) => answer.current(token),
        "expired-callback": () => answer.current(null),
        "error-callback": () => answer.current(null),
      });
    }).catch((error: unknown) => console.error(error));
    return () => { cancelled = true; };
  }, [config.script, config.global, config.siteKey, options]);

  useEffect(() => {
    if (attempt === 0 || rendered.current === null) return;
    apiOf(config.global)?.reset(rendered.current);
    answer.current(null);
  }, [attempt, config.global]);

  return <div ref={element} className="cms-captcha" data-provider={config.provider} />;
}
