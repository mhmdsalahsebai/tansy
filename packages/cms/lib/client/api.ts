"use client";

import { useCallback, useEffect, useState } from "react";
import { accountPath, authPath } from "../paths";
import { apiPath } from "../paths";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Array<{ path: string; message: string }>) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return parseResponse<T>(response);
}

/** Sends the file's raw bytes. */
export async function uploadFile(file: File, options: { temporary?: boolean } = {}): Promise<{ id: string }> {
  const response = await fetch(apiPath(`/files/upload?name=${encodeURIComponent(file.name)}${options.temporary ? "&temporary=true" : ""}`), {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  return parseResponse(response);
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code: string = payload?.error?.code ?? "ERROR";
    if (code === "REAUTH_REQUIRED") {
      window.location.href = authPath(`signin?reauth=1&next=${encodeURIComponent(window.location.pathname)}`);
    } else if (code === "MFA_ENROLLMENT_REQUIRED") {
      window.location.href = accountPath("?enroll=mfa");
    }
    throw new ApiError(response.status, code, payload?.error?.message ?? "Request failed.", payload?.error?.details);
  }
  return payload as T;
}

/**
 * Errors by their stable code, in the interface language, set in the browser by the
 * dashboard's language provider. Null in English, whose server messages say more.
 */
let translatedErrors: { messages: Record<string, string>; fallback: string } | null = null;
export const setErrorMessages = (value: typeof translatedErrors) => { translatedErrors = value; };

export function errorText(error: unknown): string {
  if (error instanceof ApiError && Array.isArray(error.details) && error.details.length) {
    return error.details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join("\n");
  }
  if (error instanceof ApiError && translatedErrors) return translatedErrors.messages[error.code] ?? error.message;
  return error instanceof Error ? error.message : (translatedErrors?.fallback ?? "Something went wrong.");
}

export function useApi<T>(path: string | null) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let active = true;
    api<T>(path).then(
      (data) => { if (active) setState({ data, loading: false }); },
      (error) => { if (active) setState({ error: errorText(error), loading: false }); },
    );
    return () => { active = false; };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** Runs an action, tracking busy and error state for a form. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

/** Unwraps better-auth client results so they work with useAction. */
export async function unwrap<T>(promise: Promise<{ data: T; error: null } | { data: null; error: { message?: string; status?: number; code?: string } }>): Promise<T> {
  const result = await promise;
  // With its code, so errorText() shows it in the interface language.
  if (result.error) throw new ApiError(result.error.status ?? 0, result.error.code ?? "", result.error.message ?? "Request failed.");
  return result.data as T;
}
