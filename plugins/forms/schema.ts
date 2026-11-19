import { defineBlock, type PluginBlock } from "tansy/plugin";

/** The collections Forms creates on first install. Owners can change all of it afterwards. */
export const FORMS = "forms-forms";
export const SUBMISSIONS = "forms-submissions";
export const COLLECTIONS = [FORMS, SUBMISSIONS] as const;

/** A field's name is the key its answer is stored under, so it's kept plain. */
const NAME = {
  name: "name",
  type: "text",
  config: { required: true, maxLength: 40, pattern: "^[a-z][a-z0-9_]*$", patternError: "Use lowercase letters, numbers and underscores, starting with a letter, such as company_name.", description: "Where the answer is stored. Each field in a form needs its own.", labels: { ar: "الاسم" }, descriptions: { ar: "المفتاح الذي تُحفظ تحته الإجابة. لكل حقل في النموذج اسمه الخاص." } },
};
const LABEL = { name: "label", type: "text", config: { required: true, maxLength: 200, labels: { ar: "التسمية" } } };
const HELP = { name: "help", type: "text", config: { maxLength: 300, description: "Shown under the field.", labels: { ar: "المساعدة" }, descriptions: { ar: "تظهر تحت الحقل." } } };
const REQUIRED = { name: "required", type: "boolean", config: { labels: { ar: "مطلوب" } } };
const PLACEHOLDER = { name: "placeholder", type: "text", config: { maxLength: 200, labels: { ar: "النص المؤقت" } } };

/** The fields a form is built from, in its `fields` stream. They belong to the plugin, so the server knows how to check each one. */
export const FIELD_BLOCKS: PluginBlock[] = [
  defineBlock({ name: "forms_text", label: "Short answer", labels: { ar: "إجابة قصيرة" }, category: "Form fields", defaults: { name: "name", label: "Name", required: true }, fields: [NAME, LABEL, REQUIRED, PLACEHOLDER, { name: "maxLength", type: "number", config: { min: 1, max: 1000, format: "integer", description: "200 when left empty.", labels: { ar: "أقصى طول" }, descriptions: { ar: "200 إن تُرك فارغًا." } } }, HELP] }),
  defineBlock({ name: "forms_email", label: "Email", labels: { ar: "بريد إلكتروني" }, category: "Form fields", defaults: { name: "email", label: "Email", required: true }, fields: [NAME, LABEL, REQUIRED, PLACEHOLDER, HELP] }),
  defineBlock({ name: "forms_textarea", label: "Long answer", labels: { ar: "إجابة طويلة" }, category: "Form fields", defaults: { name: "message", label: "Message", required: true }, fields: [NAME, LABEL, REQUIRED, PLACEHOLDER, { name: "maxLength", type: "number", config: { min: 1, max: 10000, format: "integer", description: "5,000 when left empty.", labels: { ar: "أقصى طول" }, descriptions: { ar: "5,000 إن تُرك فارغًا." } } }, HELP] }),
  defineBlock({ name: "forms_select", label: "Choice", labels: { ar: "اختيار" }, category: "Form fields", defaults: { name: "topic", label: "Topic", options: "Sales\nSupport" }, fields: [NAME, LABEL, REQUIRED, { name: "options", type: "text", config: { required: true, multiline: true, maxLength: 5000, description: "One choice per line.", labels: { ar: "الخيارات" }, descriptions: { ar: "خيار في كل سطر." } } }, HELP] }),
  defineBlock({ name: "forms_checkbox", label: "Checkbox", labels: { ar: "مربع اختيار" }, category: "Form fields", defaults: { name: "consent", label: "You may contact me about this message", required: true }, fields: [NAME, LABEL, { ...REQUIRED, config: { ...REQUIRED.config, description: "The box must be ticked to send, as for consent.", descriptions: { ar: "يجب تحديد المربع للإرسال، كما في الموافقة." } } }, HELP] }),
  defineBlock({ name: "forms_number", label: "Number", labels: { ar: "رقم" }, category: "Form fields", defaults: { name: "quantity", label: "Quantity" }, fields: [NAME, LABEL, REQUIRED, { name: "min", type: "number", config: { labels: { ar: "الحد الأدنى" } } }, { name: "max", type: "number", config: { labels: { ar: "الحد الأقصى" } } }, HELP] }),
];

export const FIELD_BLOCK_NAMES = FIELD_BLOCKS.map((block) => block.name);

/** A field the plugin's code reads or writes, by collection: the contract Extensions checks. */
export const CONTRACT = {
  [FORMS]: { title: "text", fields: "stream", submitLabel: "text", successMessage: "text", notify: "text", captcha: "boolean" },
  [SUBMISSIONS]: { form: "reference", data: "json", email: "email", page: "text", state: "radio" },
};

const LOCKED = { createRule: null, updateRule: null, deleteRule: null };

export function formsSchema() {
  return {
    version: 1,
    collections: [
      {
        slug: FORMS,
        name: "Forms",
        description: "Contact forms and other forms visitors fill in. Put one on a page with the Form block.",
        urlPattern: null,
        // Visitors can open a published form, never list them, and only the plugin's route takes answers.
        rules: { listRule: null, viewRule: 'status = "published"', ...LOCKED },
        fields: [
          { name: "title", type: "text", config: { required: true, maxLength: 200 } },
          { name: "fields", type: "stream", config: { allowedBlocks: FIELD_BLOCK_NAMES, description: "What the form asks, in order." } },
          { name: "submitLabel", type: "text", config: { maxLength: 60, description: "The button. Send when left empty." } },
          { name: "successMessage", type: "text", config: { multiline: true, maxLength: 1000, description: "Shown once it's sent." } },
          // Hidden, so the addresses never reach visitors.
          { name: "notify", type: "text", config: { hidden: true, maxLength: 1000, description: "Who gets each submission, separated by commas. Empty uses the addresses under Forms → Settings." } },
          { name: "captcha", type: "boolean", config: { defaultValue: true, description: "Ask for the site's CAPTCHA, once one is set up under Extensions → CAPTCHA." } },
        ],
      },
      {
        slug: SUBMISSIONS,
        name: "Submissions",
        description: "What visitors sent through forms. Only staff with permissions on this collection see them.",
        urlPattern: null,
        rules: { listRule: null, viewRule: null, ...LOCKED },
        fields: [
          { name: "form", type: "reference", config: { collection: FORMS, displayField: "title", required: true } },
          { name: "email", type: "email", config: { description: "The visitor's address, from the form's first email field. Notifications reply to it." } },
          { name: "data", type: "json", config: { required: true, description: "The answers, by field name." } },
          { name: "page", type: "text", config: { maxLength: 300, description: "The page the form was sent from." } },
          { name: "state", type: "radio", config: { options: [{ label: "New", value: "new" }, { label: "Done", value: "done" }, { label: "Spam", value: "spam" }], defaultValue: "new" } },
        ],
      },
    ],
    // Here rather than in the plugin's blocks, because it links to a collection this document creates.
    blocks: [{ name: "forms_embed", label: "Form", labels: { ar: "نموذج" }, icon: null, fields: [{ name: "form", type: "reference", config: { collection: FORMS, displayField: "title", required: true } }] }],
  };
}
