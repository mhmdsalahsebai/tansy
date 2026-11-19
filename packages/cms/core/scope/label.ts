import "server-only";
import { pluginWord, type Translate } from "../i18n/messages";
import { scopeProvider } from "./provider";

/**
 * What the installed scope provider calls a value, such as "Tenant", in the reader's interface
 * language: the plugin's `scopeLabel` word, else the provider's own label. Null without one.
 */
export function scopeLabelIn(t: Translate): string | null {
  const active = scopeProvider();
  return active ? pluginWord(t, active.plugin, "scopeLabel", active.provider.label) : null;
}
