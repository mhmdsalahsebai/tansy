"use client";

import Link from "next/link";
import { useState } from "react";
import { useT } from "../../../../components/i18n";
import FieldListEditor from "../../../../components/fields/FieldListEditor";
import { issuesOf, toRequest, type DraftField, type FieldTypeInfo, type IssueMap } from "../../../../components/fields/types";
import { Alert, Button, Card, Field, Input, PageHeader, PageSkeleton } from "../../../../components/ui/kit";
import { api, errorText, useApi } from "../../../../lib/client/api";
import slugify from "../../../../lib/slugify";
import { adminPath, apiPath } from "../../../../lib/paths";

type Kind = "base" | "singleton" | "menu";

const KINDS = ["base", "singleton", "menu"] as const satisfies readonly Kind[];

const MENU_FIELDS = [{ name: "items", type: "stream", config: { allowedBlocks: ["menu_item"] } }];

export default function CreateCollectionPage({ canCreateView }: { canCreateView: boolean }) {
  const { t } = useT();
  const types = useApi<FieldTypeInfo[]>(apiPath("/field-types"));
  const collections = useApi<Array<{ id: number; name: string }>>(apiPath("/collections"));
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [fields, setFields] = useState<DraftField[]>([]);
  const [kind, setKind] = useState<Kind>("base");
  const [urlPattern, setUrlPattern] = useState("");
  const [issues, setIssues] = useState<IssueMap>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setIssues({});
    try {
      const created = await api<{ id: number }>(apiPath("/collections"), { method: "POST", body: { name, slug, description: description || undefined, type: kind === "base" ? "base" : "singleton", urlPattern: (kind !== "menu" && urlPattern.trim()) || null, fields: kind === "menu" ? MENU_FIELDS : toRequest(fields) } });
      window.location.assign(adminPath(`/collections/${created.id}`));
    } catch (err) {
      setIssues(issuesOf(err));
      setError(errorText(err));
      setSaving(false);
    }
  };

  if (types.error) return <Alert>{types.error}</Alert>;
  if (!types.data) return <PageSkeleton kind="form" />;

  return (
    <div className="cms-gutter">
      <PageHeader
        title={t("schemaEditor.createTitle")}
        description={t("schemaEditor.createDescription")}
        actions={canCreateView ? <Link className="cms-nowrap cms-text-sm cms-link" href={adminPath("/collections/create-view")}>{t("schemaEditor.createView")}</Link> : undefined}
      />
      <form onSubmit={submit} className="cms-stack-6">
        {error && <Alert>{error}</Alert>}
        <Card>
          <Field label={t("schemaEditor.type")} hint={t(`schemaEditor.kinds.${kind}Hint`)}>
            <select aria-label={t("schemaEditor.type")} className="cms-input" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {KINDS.map((value) => <option key={value} value={value}>{t(`schemaEditor.kinds.${value}`)}</option>)}
            </select>
          </Field>
          <Field label={t("schemaEditor.name")}>
            <Input required value={name} placeholder={t("schemaEditor.namePlaceholder")} onChange={(e) => { setName(e.target.value); setSlug(slugify(e.target.value)); }} />
          </Field>
          <Field label={t("schemaEditor.slug")} hint={t("schemaEditor.slugHint")}>
            <Input required value={slug} placeholder="blog-posts" onChange={(e) => setSlug(e.target.value)} />
          </Field>
          {issues.slug && <p className="cms-error">{issues.slug}</p>}
          <Field label={t("schemaEditor.description")}>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          {kind !== "menu" && (
            <Field label={t("schemaEditor.urlPattern")} hint={t(kind === "singleton" ? "schemaEditor.urlSingletonOptional" : "schemaEditor.urlCollectionOptional")}>
              <Input value={urlPattern} placeholder={kind === "singleton" ? "/about" : "/blog/:slug"} onChange={(e) => setUrlPattern(e.target.value)} />
            </Field>
          )}
          {issues.urlPattern && <p className="cms-error">{issues.urlPattern}</p>}
        </Card>
        {kind !== "menu" && <FieldListEditor fields={fields} onChange={setFields} types={types.data} collections={collections.data ?? []} issues={issues} />}
        <div className="cms-flex cms-end">
          <Button type="submit" loading={saving}>{t("schemaEditor.create")}</Button>
        </div>
      </form>
    </div>
  );
}
