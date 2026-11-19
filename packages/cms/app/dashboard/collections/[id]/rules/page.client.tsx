"use client";

import { useEffect, useState } from "react";
import { useT } from "../../../../../components/i18n";
import { Alert, Button, Card, PageHeader, PageSkeleton } from "../../../../../components/ui/kit";
import { api, useAction, useApi } from "../../../../../lib/client/api";
import type { Collection } from "../../../../../types/content";
import { adminPath, apiPath } from "../../../../../lib/paths";

const RULES = ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"] as const;
type RuleKey = (typeof RULES)[number];
type Rules = Record<RuleKey, string | null>;

export default function RulesClient({ id }: { id: string }) {
  const { t } = useT();
  const { data, error: loadError } = useApi<Collection>(apiPath(`/collections/${id}`));
  const [rules, setRules] = useState<Rules | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (!data) return;
    const timer = setTimeout(() => setRules({ listRule: data.listRule, viewRule: data.viewRule, createRule: data.createRule, updateRule: data.updateRule, deleteRule: data.deleteRule }));
    return () => clearTimeout(timer);
  }, [data]);

  if (loadError) return <div className="cms-gutter"><Alert>{loadError}</Alert></div>;
  if (!rules || !data) return <PageSkeleton kind="form" />;
  const set = (key: RuleKey, value: string | null) => { setSaved(false); setRules({ ...rules, [key]: value }); };

  return (
    <div>
      <PageHeader title={t("rules.title", { name: data.name })} description={t("rules.description")} back={{ href: adminPath(`/collections/${id}`), label: t("rules.back") }} />
      <div className="cms-gutter cms-stack-4">
        {error && <Alert>{error}</Alert>}
        {saved && <Alert kind="success">{t("rules.saved")}</Alert>}
        {RULES.map((key) => {
          const label = t(`rules.${key}`);
          const value = rules[key];
          const mode = value === null ? "locked" : value === "" ? "public" : "custom";
          return (
            <Card key={key} title={label} description={t(`rules.${key}Help`)}>
              <div className="cms-flex cms-gap-4 cms-text-sm cms-body">
                {(["locked", "public", "custom"] as const).map((option) => (
                  <label key={option} className="cms-row cms-gap-1">
                    <input type="radio" name={key} checked={mode === option} onChange={() => set(key, option === "locked" ? null : option === "public" ? "" : '@request.auth.id != ""')} />
                    {t(`rules.modes.${option}`)}
                  </label>
                ))}
              </div>
              {mode === "custom" && (
                <textarea aria-label={t("rules.ruleLabel", { rule: label })} rows={2} spellCheck={false} className="cms-input cms-mono" value={value ?? ""} onChange={(e) => set(key, e.target.value)} />
              )}
            </Card>
          );
        })}
        <p className="cms-hint">{t("rules.examples")} <code>status = &quot;published&quot;</code>, <code>@request.auth.id = createdById</code>, <code>@request.auth.role = &quot;member&quot; &amp;&amp; @request.body.status:changed = false</code></p>
        <Button loading={busy} onClick={async () => setSaved(await run(() => api(apiPath(`/collections/${id}/rules`), { method: "PUT", body: rules })))}>{t("rules.save")}</Button>
      </div>
    </div>
  );
}
