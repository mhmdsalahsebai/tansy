import { defineRenderers, FieldValue, StreamField, type BlockProps, type FieldRenderProps } from "tansy/react";

function SeoLink({ value }: FieldRenderProps) {
  const link = value as { label: string; id: number };
  return <a href={`/link/${link.id}`}>{link.label}</a>;
}

function SeoCard({ value, renderers }: BlockProps) {
  return <p><FieldValue type="seo_link" value={value.link} renderers={renderers} /></p>;
}

function SeoSection({ value, components, renderers, fallback }: BlockProps) {
  return <section><h2>{String(value.title ?? "")}</h2><StreamField blocks={value.cards} components={components} renderers={renderers} fallback={fallback} /></section>;
}

export default defineRenderers({ blocks: { seo_card: SeoCard, seo_section: SeoSection }, fields: { seo_link: SeoLink } });
