"use client";

import { usePathname } from "next/navigation";
import { adminPath } from "../../lib/paths";
import { PageSkeleton } from "../ui/kit";

type Kind = "table" | "form" | "cards";

/** Pages whose body is a form, by the address under the dashboard. Anything not listed is a list. */
const FORMS = [/^\/settings$/, /^\/users\/(fields|[^/]+)$/, /^\/blocks\/[^/]+$/, /^\/collections\/(create|create-view)$/, /^\/collections\/[^/]+\/(schema|rules|view)$/, /^\/collections\/[^/]+\/content\/[^/]+(\/history)?$/, /^\/extensions\/[^/]+\/settings$/];
const CARDS = [/^$/, /^\/extensions(\/directory)?$/];

export function skeletonKind(address: string): Kind {
  if (CARDS.some((pattern) => pattern.test(address))) return "cards";
  if (FORMS.some((pattern) => pattern.test(address))) return "form";
  return "table";
}

/**
 * What every dashboard page shows while the server prepares it: the page's shape, a header and
 * then a table, a form or cards, so the switch to the real page doesn't jump.
 */
export function DashboardLoading() {
  const pathname = usePathname() ?? "";
  const base = adminPath();
  const address = pathname.startsWith(base) ? pathname.slice(base.length).replace(/\/$/, "") : pathname;
  return <PageSkeleton kind={skeletonKind(address)} />;
}
