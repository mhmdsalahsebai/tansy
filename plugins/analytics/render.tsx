import { defineRenderers, type EveryPageProps } from "tansy/react";
import type { TrackerConfig } from "./tracker";
import { AnalyticsTracker } from "./tracker-view";

export { AnalyticsTracker, type AnalyticsTrackerProps } from "./tracker-view";
export type { TrackerConfig } from "./tracker";

/** On every page, with what the plugin's settings say to load. A new address is a new page view. */
function Tracker({ page, props }: EveryPageProps) {
  return <AnalyticsTracker config={props as unknown as TrackerConfig} path={`${page.locale ?? ""}:${page.path}`} />;
}

export default defineRenderers({
  everyPage: { "analytics-tracker": Tracker },
});
