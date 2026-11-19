"use client";

import { useState } from "react";
import { issuesOf, type IssueMap } from "../fields/types";
import { useT } from "../i18n";
import { Alert, Button, Card, Field, Input, PageHeader } from "../ui/kit";
import { api, errorText } from "../../lib/client/api";
import slugify from "../../lib/slugify";
import { adminPath, apiPath } from "../../lib/paths";

interface Props {
  /** Set when editing. */
  existing?: { id: number; name: string; viewQuery: string };
}

/** Creates a view collection, or changes the query of an existing one. */
export default function ViewForm({ existing }: Props) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState(existing?.viewQuery ?? "");
  const [issues, setIssues] = useState<IssueMap>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setIssues({});
    try {
      const saved = existing
        ? await api<{ id: number }>(apiPath(`/collections/${existing.id}/view`), { method: "PUT", body: { query } })
        : await api<{ id: number }>(apiPath("/collections/views"), { method: "POST", body: { name, slug, description: description || undefined, query } });
      window.location.assign(adminPath(`/collections/${saved.id}`));
    } catch (err) {
      setIssues(issuesOf(err));
      setError(errorText(err));
      setSaving(false);
    }
  };

  return (
    <div className="cms-p-6">
      <PageHeader title={existing ? t("viewForm.editTitle", { name: existing.name }) : t("viewForm.createTitle")} description={t("viewForm.description")} />
      <form onSubmit={submit} className="cms-stack-6">
        {error && <Alert>{error}</Alert>}
        <Card>
          {!existing && (
            <>
              <Field label={t("viewForm.name")}><Input required value={name} onChange={(e) => { setName(e.target.value); setSlug(slugify(e.target.value)); }} /></Field>
              <Field label={t("viewForm.slug")}><Input required value={slug} onChange={(e) => setSlug(e.target.value)} /></Field>
              {issues.slug && <p className="cms-error">{issues.slug}</p>}
              <Field label={t("viewForm.descriptionLabel")}><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            </>
          )}
          <div>
            <label htmlFor="view-query" className="cms-label cms-mb-1">{t("viewForm.query")}</label>
            {/* eslint-disable-next-line i18n/no-literal-text -- An example query in SQL, the same in every language. */}
            <textarea id="view-query" required rows={10} spellCheck={false} className="cms-input cms-mono" value={query} placeholder={'SELECT p.id, p.title, count(c.id) AS comments\nFROM rec_posts p\nLEFT JOIN rec_comments c ON c.post = p.id\nGROUP BY p.id'} onChange={(e) => setQuery(e.target.value)} />
            <p className="cms-hint cms-mt-1">{t("viewForm.queryHint")}</p>
          </div>
        </Card>
        <div className="cms-flex cms-end"><Button type="submit" loading={saving}>{t(existing ? "viewForm.save" : "viewForm.create")}</Button></div>
      </form>
    </div>
  );
}
