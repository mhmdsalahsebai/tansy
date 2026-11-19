"use client";

import { useState } from "react";
import { useT } from "../i18n";
import { Alert, Button, Card } from "../ui/kit";
import { api, errorText } from "../../lib/client/api";
import { apiPath } from "../../lib/paths";
import type { Collection } from "../../types/content";

/** Turns review on or off for one collection. Saved on its own, like the localization card. */
export function ReviewCard({ collection, onSaved }: { collection: Collection; onSaved: (current: Collection) => void }) {
  const { t } = useT();
  const [on, setOn] = useState(collection.reviewRequired === true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const changed = on !== (collection.reviewRequired === true);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      onSaved(await api<Collection>(apiPath(`/collections/${collection.id}`), { method: "PATCH", body: { reviewRequired: on } }));
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={t("review.cardTitle")} actions={<Button variant="secondary" loading={saving} disabled={!changed} onClick={() => void save()}>{t("review.saveSetting")}</Button>}>
      <div className="cms-stack-3">
        {error && <Alert>{error}</Alert>}
        {saved && !changed && <Alert kind="success">{t("review.settingSaved")}</Alert>}
        <label className="cms-check-label">
          <input type="checkbox" className="cms-check" checked={on} onChange={(event) => setOn(event.target.checked)} />
          {t("review.require")}
        </label>
        <p className="cms-hint">{t("review.requireHint")}</p>
      </div>
    </Card>
  );
}
