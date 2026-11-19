import type { ReactNode } from "react";
import RootLayout from "../app/layout";
import type { CmsConfig } from "../core/auth/extensions";
import { provideCmsConfig } from "../core/config";

export { metadata } from "../app/layout";

/** The plugins this server runs, for the browser-side provider. */
export const enabledPlugins = (config: CmsConfig) => (config.plugins ?? []).map(({ name }) => name);

export function createRootLayout(config: CmsConfig) {
  provideCmsConfig(config);
  return function CmsRootLayout({ children }: { children: ReactNode }) {
    return <RootLayout>{children}</RootLayout>;
  };
}
