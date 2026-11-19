import type { ReactNode } from "react";

// Pages need a per-request nonce to pass the Content Security Policy.
export const dynamic = "force-dynamic";

export default function SiteLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
