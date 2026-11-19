/** Whether a field's `showIf` lets it show. Display only: the server validates a hidden value like any other. */
export function isShown(config: unknown, valueOf: (name: string) => unknown) {
  const rule = (config as { showIf?: { field?: string; equals?: unknown } } | null)?.showIf;
  if (!rule?.field) return true;
  const value = valueOf(rule.field);
  if (rule.equals !== undefined) return JSON.stringify(value) === JSON.stringify(rule.equals);
  return value !== undefined && value !== null && value !== "" && value !== false;
}
