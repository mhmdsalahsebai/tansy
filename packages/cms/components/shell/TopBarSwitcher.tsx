"use client";

import { useEffect, useState } from "react";
import { ArrowsUpDownIcon } from "@heroicons/react/16/solid";
import type { PluginSwitcher } from "../../core/extend/admin-nav";
import { api } from "../../lib/client/api";
import { useT } from "../i18n";

/** A `<select>` can't hold null, so "none" travels as this. Scope values never start with a space. */
const NONE = " none";

interface Choice { value: string | null; label: string }
interface Choices { current: string | null; options: Choice[] }

/** What the plugin's `options` route answered, or null when it isn't the agreed shape. */
function choicesFrom(data: unknown): Choices | null {
  if (!data || typeof data !== "object") return null;
  const { current, options } = data as { current?: unknown; options?: unknown };
  if (!Array.isArray(options)) return null;
  const valid = options.filter((option): option is Choice => Boolean(option) && typeof option === "object" && (typeof option.value === "string" || option.value === null) && typeof option.label === "string");
  return { current: typeof current === "string" ? current : null, options: valid };
}

/**
 * A plugin's choice for every page, such as the tenant someone works in (AdminSwitcher). It
 * offers only what the plugin's route returns, and asks the plugin's other route to change it.
 * Every page then reloads, since what each one shows can depend on the choice.
 */
export function TopBarSwitcher({ switcher }: { switcher: PluginSwitcher }) {
  const { t } = useT();
  const [choices, setChoices] = useState<Choices | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(switcher.options, { headers: { accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => live && setChoices(choicesFrom(data)))
      .catch(() => live && setChoices(null));
    return () => { live = false; };
  }, [switcher.options]);

  if (!choices?.options.length) return null;
  const known = choices.options.some((option) => option.value === choices.current);

  const choose = async (raw: string) => {
    setBusy(true);
    setFailed(false);
    try {
      await api(switcher.select, { method: "POST", body: { value: raw === NONE ? null : raw } });
      window.location.reload();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <label className="cms-topbar-switcher" title={failed ? t("scope.switchFailed") : switcher.label}>
      <ArrowsUpDownIcon className="cms-icon" aria-hidden="true" />
      <span className="cms-sr-only">{switcher.label}</span>
      <select value={choices.current ?? NONE} disabled={busy} aria-invalid={failed || undefined} onChange={(event) => void choose(event.target.value)}>
        {!known && <option value={choices.current ?? NONE} disabled>—</option>}
        {choices.options.map((option) => <option key={option.value ?? NONE} value={option.value ?? NONE}>{option.label}</option>)}
      </select>
      {failed && <span role="alert" className="cms-sr-only">{t("scope.switchFailed")}</span>}
    </label>
  );
}
