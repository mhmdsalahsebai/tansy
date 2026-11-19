"use client";

import type { ReactNode } from "react";
import { PluginBoundary } from "../../../../components/PluginBoundary";

export default function PluginSlot({ plugin, children }: { plugin: string; children?: ReactNode }) {
  return <PluginBoundary plugin={plugin}>{children}</PluginBoundary>;
}
