import { createElement } from "react";
import { RichText, StreamField } from "tansy/react";
import { defineThemeComponents, type TemplateProps } from "tansy/theme";

const SYSTEM = new Set(["id", "title", "slug", "status", "createdAt", "updatedAt", "publishedAt", "createdById"]);

const isDoc = (value: unknown) => typeof value === "object" && value !== null && (value as { type?: unknown }).type === "doc";
const isStream = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null && "type" in item && "value" in item);

function Page({ record, stream }: TemplateProps) {
  if (!record) return null;
  return (
    <main>
      {typeof record.title === "string" && <h1>{record.title}</h1>}
      {Object.entries(record).filter(([name]) => !SYSTEM.has(name)).map(([name, value]) => {
        if (isDoc(value)) return <RichText key={name} doc={value} />;
        if (isStream(value)) return createElement(StreamField, { key: name, blocks: value, ...stream });
        return typeof value === "string" || typeof value === "number" ? <p key={name}>{value}</p> : null;
      })}
    </main>
  );
}

export default defineThemeComponents({ templates: { default: Page } });
