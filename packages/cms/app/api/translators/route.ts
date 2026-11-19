import { route } from "../../../core/authz/guard";
import { translators } from "../../../core/i18n/translate";

/** The machine translators plugins provide, for the editor's "Translate from …" button. */
export const GET = route({ access: "authenticated" }, async () => ({ items: translators().map(({ name, label }) => ({ name, label })) }));
