import { defineRenderers, pickWords, siteWords, type BlockProps, type SiteWords } from "tansy/react";
import type { TemplateProps } from "tansy/theme";
import { FormView } from "./form";
import { fieldsOf, type FormField } from "./logic";
import { siteMessages } from "./site-messages";
import "./forms.css";

const forParts = (words: SiteWords | undefined) => (words ? pickWords(words, "forms") : undefined);

export { FormView, type FormViewProps } from "./form";

/** A reference arrives as an id, or as the record when expanded. */
const formId = (value: unknown) => {
  const id = value && typeof value === "object" ? (value as { id?: unknown }).id : value;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : null;
};

/** The Form block, on any page. */
function FormEmbed({ value, words }: BlockProps) {
  const id = formId(value.form);
  return id === null ? null : <FormView form={id} words={forParts(words)} />;
}

/** How a field looks while the form is built: the real control, which can't be used there. */
function FieldPreview({ block, words }: BlockProps) {
  const { t } = siteWords(words);
  const [field] = fieldsOf([block]) as [FormField | undefined];
  if (!field) return <p className="fm-help">{t("forms.namePreview")}</p>;
  const control = field.kind === "textarea" ? <textarea rows={3} disabled placeholder={field.placeholder} />
    : field.kind === "select" ? <select disabled><option>{field.placeholder || t("forms.choose")}</option>{field.options?.map((option) => <option key={option}>{option}</option>)}</select>
      : field.kind === "checkbox" ? null
        : <input type={field.kind === "email" ? "email" : field.kind === "number" ? "number" : "text"} disabled placeholder={field.placeholder} />;
  return (
    <div className="fm-form fm-preview">
      <div className="fm-field">
        {field.kind === "checkbox" ? <label className="fm-check"><input type="checkbox" disabled /><span>{field.label}</span></label> : <label>{field.label}{field.required && <span aria-hidden> *</span>}</label>}
        {control}
        {field.help && <p className="fm-help">{field.help}</p>}
      </div>
    </div>
  );
}

/** A form's own page, for an owner who gives the Forms collection an address. */
function FormPage({ record, words }: TemplateProps) {
  const id = formId(record?.id);
  return (
    <main className="fm-page">
      <h1>{typeof record?.title === "string" ? record.title : ""}</h1>
      {id !== null && <FormView form={id} words={forParts(words)} />}
    </main>
  );
}

export default defineRenderers({
  messages: siteMessages,
  blocks: {
    forms_embed: FormEmbed,
    forms_text: FieldPreview,
    forms_email: FieldPreview,
    forms_textarea: FieldPreview,
    forms_select: FieldPreview,
    forms_checkbox: FieldPreview,
    forms_number: FieldPreview,
  },
  templates: { "forms-forms": FormPage },
});
