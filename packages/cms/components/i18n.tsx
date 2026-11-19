"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import { setErrorMessages } from "../lib/client/api";
import { ADMIN_CATALOGS, ADMIN_DEFAULT } from "../core/i18n/catalogs";
import type { en } from "../core/i18n/catalogs/en";
import { formatters, type MessageValues, type Messages } from "../core/i18n/messages";
import { pickLabel as pick } from "../core/i18n/labels";

/** "nav.Collections", "shell.signOut": every key in the English catalog, so a typo fails `tsc`. */
type Keys<T, Prefix extends string = ""> = { [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Keys<T[K], `${Prefix}${K}.`> }[keyof T & string];
export type AdminMessageKey = Keys<typeof en> | `ext.${string}`;

interface I18nState { locale: string; direction: "ltr" | "rtl"; messages: Messages }

const I18nContext = createContext<I18nState>({ locale: ADMIN_DEFAULT, direction: "ltr", messages: ADMIN_CATALOGS[ADMIN_DEFAULT] as unknown as Messages });

/** The interface language's `t()`, for code that runs outside a component, such as a plugin's bulk action. */
let outside = formatters(ADMIN_DEFAULT, ADMIN_CATALOGS[ADMIN_DEFAULT] as unknown as Messages);

/**
 * `t()` outside a component, such as in a bulk action's `run`, in the person's interface
 * language. Inside a component, use `useT()`.
 */
export const translate = (key: string, values?: MessageValues) => outside.t(key, values);

/** Set once by the dashboard's layout, from the person's interface language. */
export function AdminI18nProvider({ locale, direction, messages, children }: I18nState & { children: ReactNode }) {
  const value = useMemo(() => ({ locale, direction, messages }), [locale, direction, messages]);
  // In the browser only: errorText() is a plain function, called from handlers rather than render.
  // Handlers run after this, on someone's click, so they read the right language.
  useEffect(() => {
    outside = formatters(locale, messages);
  }, [locale, messages]);
  useEffect(() => {
    const errors = (messages as { errors?: Record<string, string> }).errors;
    setErrorMessages(locale === ADMIN_DEFAULT || !errors ? null : { messages: errors, fallback: errors.INTERNAL_ERROR ?? "" });
    return () => setErrorMessages(null);
  }, [locale, messages]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** The interface language and its direction. */
export const useAdminLocale = () => {
  const { locale, direction } = useContext(I18nContext);
  return { locale, direction };
};

interface TextConfig { label?: unknown; labels?: unknown; description?: unknown; descriptions?: unknown }

/** A field's label and description in the interface language, from `labels` and `descriptions`, else `label` and `description`. */
export function useFieldText() {
  const { locale } = useContext(I18nContext);
  return useMemo(() => ({
    label: (field: { name: string; config?: unknown }) => {
      const config = (field.config ?? {}) as TextConfig;
      return pick(config.labels, locale) ?? (typeof config.label === "string" && config.label ? config.label : field.name);
    },
    description: (field: { config?: unknown }) => {
      const config = (field.config ?? {}) as TextConfig;
      return pick(config.descriptions, locale) ?? (typeof config.description === "string" ? config.description : undefined);
    },
    /** A radio, select or multiselect choice's label, from its `labels`. */
    choice: (option: { label: string; value: string; labels?: unknown }) => pick(option.labels, locale) ?? (option.label || option.value),
  }), [locale]);
}

/** A collection's name or a block's label in the interface language, from its `labels`. */
export function useSchemaText() {
  const { locale } = useContext(I18nContext);
  return useMemo(() => ({
    collection: (collection: { name: string; labels?: unknown }) => pick(collection.labels, locale) ?? collection.name,
    block: (block: { label: string; labels?: unknown }) => pick(block.labels, locale) ?? block.label,
  }), [locale]);
}

/**
 * `t()` and the `Intl` formatters in the person's interface language, for client
 * components. A plugin's words are under `ext.<plugin>`: `t("ext.blog.moderate")`.
 */
export function useT() {
  const { locale, messages } = useContext(I18nContext);
  return useMemo(() => {
    const format = formatters(locale, messages);
    return { ...format, locale, t: (key: AdminMessageKey, values?: MessageValues) => format.t(key, values) };
  }, [locale, messages]);
}

/**
 * Looks up a key built at runtime, such as a field type's, and shows `fallback` when the
 * catalog has none: a plugin's type or option keeps the words its plugin registered.
 */
export function useTOr() {
  const { locale, messages } = useContext(I18nContext);
  return useMemo(() => {
    const { t } = formatters(locale, messages);
    return (key: string, fallback: string, values?: MessageValues) => {
      const text = t(key, values);
      return text === key ? fallback : text;
    };
  }, [locale, messages]);
}

/** A word a plugin registered in code, from its `messages` under `ext.<plugin>.<key>`, else as registered. */
export function usePluginWord() {
  const tOr = useTOr();
  return useCallback((plugin: string, key: string, fallback: string) => tOr(`ext.${plugin}.${key}`, fallback), [tOr]);
}

/**
 * A field type's name and description: from the catalog for a built-in type, from its
 * plugin's `messages` under `fieldTypes.<type>` for a plugin's, else as registered.
 */
export function useFieldTypeText() {
  const tOr = useTOr();
  return useMemo(() => {
    const text = (info: { type: string; plugin?: string }, part: "label" | "description", registered: string) =>
      tOr(`fieldEditor.types.${info.type}.${part}`, info.plugin ? tOr(`ext.${info.plugin}.fieldTypes.${info.type}.${part}`, registered) : registered);
    return {
      label: (info: { type: string; label: string; plugin?: string }) => text(info, "label", info.label),
      description: (info: { type: string; description?: string; plugin?: string }) => (info.description ? text(info, "description", info.description) : undefined),
    };
  }, [tOr]);
}

/**
 * `useT()` for plugins, through tansy/admin: the same words and formatters, looked up
 * by any string key, such as "ext.blog.moderate". Core's own components use `useT`, whose
 * keys `tsc` checks against the English catalog.
 */
export const usePluginT = useT as () => Omit<ReturnType<typeof useT>, "t"> & { t: (key: string, values?: MessageValues) => string };

