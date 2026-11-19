import { defineRenderers, pickWords, RichText, type BlockProps, type SiteWords } from "tansy/react";
import type { TemplateProps } from "tansy/theme";
import { NewsletterManager, SignupForm } from "./signup";
import { siteMessages } from "./site-messages";
import "./newsletter.css";

export { NewsletterManager, SignupForm, type SignupFormProps } from "./signup";

const forParts = (words: SiteWords | undefined) => (words ? pickWords(words, "newsletter") : undefined);
const str = (value: unknown) => (typeof value === "string" ? value : "");

/** The Newsletter sign-up block, on any page. */
function SignupBlock({ value, words }: BlockProps) {
  return <SignupForm title={str(value.title) || undefined} text={str(value.text) || undefined} buttonLabel={str(value.buttonLabel) || undefined} askName={value.askName === true} words={forParts(words)} />;
}

/** The newsletter's own page: sign up, or confirm and unsubscribe from the links in its emails. */
function NewsletterPage({ record, words }: TemplateProps) {
  return (
    <main className="nl-page">
      <h1>{str(record?.title)}</h1>
      {record?.intro !== undefined && record?.intro !== null && <div className="nl-intro"><RichText doc={record.intro} /></div>}
      <NewsletterManager words={forParts(words)} />
    </main>
  );
}

export default defineRenderers({
  messages: siteMessages,
  blocks: { newsletter_signup: SignupBlock },
  templates: { "newsletter-page": NewsletterPage },
});
