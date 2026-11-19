const PROVIDER_FAILED = "The AI provider couldn't answer just now. Check AI → Settings, or try again in a moment.";

/**
 * Why the provider refused, in its own words when it gave them, such as a used-up quota or
 * an unknown model, so the owner can act on it. Anything that looks like a key is hidden.
 */
export function providerReason(error: unknown): string {
  let found = error as { statusCode?: unknown; responseBody?: unknown; message?: unknown; lastError?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; found && typeof found.statusCode !== "number" && depth < 5; depth++) {
    found = (found.lastError ?? found.cause) as typeof found;
  }
  if (!found || typeof found.statusCode !== "number") return PROVIDER_FAILED;
  let said = "";
  try {
    const body = JSON.parse(String(found.responseBody ?? "")) as { error?: { message?: unknown } | string; message?: unknown };
    said = String((typeof body.error === "object" ? body.error?.message : body.error) ?? body.message ?? "");
  } catch {
    said = typeof found.message === "string" ? found.message : "";
  }
  said = said.replace(/[A-Za-z0-9_\-*.]{24,}/g, "…").trim().slice(0, 300);
  if (found.statusCode === 401 || found.statusCode === 403) return `The AI provider refused the key${said ? `: ${said}` : ""}. Check it under AI → Settings.`;
  return said ? `The AI provider answered ${found.statusCode}: ${said}` : PROVIDER_FAILED;
}
