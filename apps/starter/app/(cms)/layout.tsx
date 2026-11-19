import type { ReactNode } from "react";
import { createRootLayout, enabledPlugins } from "tansy/layout";
import config from "@/tansy.config";
import { CmsAdminClient } from "./admin-client-provider";

export { metadata } from "tansy/layout";

const RootLayout = createRootLayout(config);

export default function Layout({ children }: { children: ReactNode }) {
  return <RootLayout><CmsAdminClient enabled={enabledPlugins(config)}>{children}</CmsAdminClient></RootLayout>;
}
