"use client";

import type { ReactNode } from "react";
import { AdminClientProvider } from "tansy/admin";
import plugins, { sitePreview } from "@/.tansy/admin.client";

export function CmsAdminClient({ enabled, children }: { enabled: string[]; children: ReactNode }) {
  return <AdminClientProvider plugins={plugins} enabled={enabled} sitePreview={sitePreview}>{children}</AdminClientProvider>;
}
