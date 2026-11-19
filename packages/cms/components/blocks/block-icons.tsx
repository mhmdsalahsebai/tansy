"use client";

import { ChatBubbleLeftIcon, CodeBracketIcon, DocumentTextIcon, LinkIcon, ListBulletIcon, MegaphoneIcon, MinusIcon, PhotoIcon, Squares2X2Icon, StarIcon, TableCellsIcon, VideoCameraIcon } from "@heroicons/react/24/outline";
import type { ComponentType, SVGProps } from "react";

export const BLOCK_ICONS: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  text: DocumentTextIcon,
  photo: PhotoIcon,
  video: VideoCameraIcon,
  code: CodeBracketIcon,
  link: LinkIcon,
  list: ListBulletIcon,
  quote: ChatBubbleLeftIcon,
  callout: MegaphoneIcon,
  grid: Squares2X2Icon,
  table: TableCellsIcon,
  star: StarIcon,
  divider: MinusIcon,
};

/** Icons are stored as free text through the API, so an unknown name simply shows nothing. */
export function BlockIcon({ name }: { name?: string | null }) {
  const Icon = name ? BLOCK_ICONS[name] : undefined;
  return Icon ? <Icon aria-hidden className="cms-icon cms-no-shrink cms-faded" /> : null;
}
