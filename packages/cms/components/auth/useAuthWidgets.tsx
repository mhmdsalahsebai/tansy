"use client";

import { createElement, useCallback, useMemo, useState } from "react";
import { useAdminClient } from "../admin-client";
import { CaptchaWidget } from "../captcha/CaptchaWidget";
import type { AuthWidgetProps } from "../../core/extend/admin";
import type { CaptchaAuthForm, CaptchaWidgetConfig } from "../../core/captcha/types";

export interface EnabledWidget { id: string; props: Record<string, unknown> }

/** The site's CAPTCHA and the forms it guards, from /api/auth-config. */
export interface AuthCaptcha { widget: CaptchaWidgetConfig; forms: CaptchaAuthForm[] }

function Slot({ widget, form, attempt, onHeaders }: { widget: EnabledWidget; form: AuthWidgetProps["form"]; attempt: number; onHeaders: (id: string, headers: Record<string, string>) => void }) {
  const setHeaders = useCallback((headers: Record<string, string>) => onHeaders(widget.id, headers), [onHeaders, widget.id]);
  const { authWidgets } = useAdminClient();
  const component = authWidgets.find((item) => item.id === widget.id)?.component;
  return component ? createElement(component, { form, config: widget.props, attempt, setHeaders }) : null;
}

/** Whatever the server's extensions switched on, and the headers those widgets want sent. */
export function useAuthWidgets(enabled: EnabledWidget[] | undefined, form: AuthWidgetProps["form"], captcha?: AuthCaptcha | null) {
  const [byWidget, setByWidget] = useState<Record<string, Record<string, string>>>({});
  const [attempt, setAttempt] = useState(0);
  const onHeaders = useCallback((id: string, headers: Record<string, string>) => setByWidget((current) => ({ ...current, [id]: headers })), []);
  const headers = useMemo(() => Object.assign({}, ...Object.values(byWidget)) as Record<string, string>, [byWidget]);
  const onAnswer = useCallback((answer: string | null) => onHeaders("core:captcha", answer ? { "x-captcha-response": answer } : {}), [onHeaders]);
  const slot = (
    <>
      {enabled?.map((widget) => <Slot key={widget.id} widget={widget} form={form} attempt={attempt} onHeaders={onHeaders} />)}
      {captcha?.forms.includes(form) && <CaptchaWidget config={captcha.widget} attempt={attempt} onAnswer={onAnswer} />}
    </>
  );
  return { headers, slot, failed: () => setAttempt((value) => value + 1) };
}
