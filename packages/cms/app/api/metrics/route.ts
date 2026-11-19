import { route } from "../../../core/authz/guard";
import { METRICS_CONTENT_TYPE, metricsText } from "../../../core/ops/metrics";

/**
 * The instance's numbers in Prometheus's text format, for whatever watches this server
 * (docs/guides/operations.md). Counts of rows only, never their contents.
 *
 * `setting:read` rather than a scrape token of its own: an API key with that one permission is
 * the existing way to let a machine read something, and it is already audited and rate limited.
 */
export const GET = route({ access: "permission", permission: "setting:read", apiKey: true }, async () => {
  const text = await metricsText();
  return new Response(text, { headers: { "content-type": METRICS_CONTENT_TYPE, "cache-control": "no-store" } });
});
