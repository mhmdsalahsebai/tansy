import type { ComponentType, SVGProps } from "react";
import {
  AtSymbolIcon, Bars3BottomLeftIcon, CalendarIcon, CheckIcon, ClockIcon, CodeBracketIcon, DocumentIcon, DocumentTextIcon,
  GlobeAltIcon, HashtagIcon, LightBulbIcon, LinkIcon, PhotoIcon, RadioIcon, Square2StackIcon, VariableIcon,
  QueueListIcon,
} from "@heroicons/react/24/outline";

/** Icons for built-in types. Custom types get a default icon. */
export const fieldIcons: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  text: DocumentTextIcon,
  rich_text: Bars3BottomLeftIcon,
  code: CodeBracketIcon,
  number: HashtagIcon,
  email: AtSymbolIcon,
  url: GlobeAltIcon,
  date: CalendarIcon,
  datetime: ClockIcon,
  image: PhotoIcon,
  file: DocumentIcon,
  gallery: Square2StackIcon,
  checkbox: CheckIcon,
  radio: RadioIcon,
  reference: LinkIcon,
  boolean: LightBulbIcon,
  json: VariableIcon,
  stream: QueueListIcon,
};
