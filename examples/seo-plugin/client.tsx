"use client";

import { defineAdminClient, defineFieldAdmin, type FieldInputProps } from "tansy/admin";

const MAX = 70;

function SeoTitleInput({ id, value, onChange }: FieldInputProps) {
  const text = typeof value === "string" ? value : "";
  return (
    <div>
      <input id={id} type="text" maxLength={MAX} className="cms-input cms-mt-1" value={text} onChange={(e) => onChange(e.target.value)} />
      <p className="cms-hint cms-mt-1">{text.length} of {MAX} characters</p>
    </div>
  );
}

/** An object value, edited with one control per property. */
function SeoLinkInput({ id, value, onChange, readOnly, disabled }: FieldInputProps) {
  const link = (value && typeof value === "object" ? value : {}) as { label?: string; id?: number };
  const set = (next: { label?: string; id?: number }) => onChange({ ...link, ...next });
  return (
    <div className="cms-grid cms-gap-3 cms-sm-2">
      <input id={id} type="text" placeholder="Link text" aria-label="Link text" className="cms-input cms-mt-1" readOnly={readOnly} disabled={disabled} value={link.label ?? ""} onChange={(e) => set({ label: e.target.value })} />
      <input type="number" min={1} placeholder="Record id" aria-label="Record id" className="cms-input cms-mt-1" readOnly={readOnly} disabled={disabled} value={link.id ?? ""} onChange={(e) => set({ id: Number(e.target.value) })} />
    </div>
  );
}

export default defineAdminClient({ fieldAdmin: [defineFieldAdmin({ type: "seo_title", Input: SeoTitleInput }), defineFieldAdmin({ type: "seo_link", Input: SeoLinkInput })] });
