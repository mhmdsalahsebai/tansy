import type { SVGProps } from "react";

/** Line icons on a 24px grid, drawn in the current colour. Decorative: whatever holds one gives it a name. */
function Icon({ children, className = "sf:size-5", ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      {children}
    </svg>
  );
}

type Props = SVGProps<SVGSVGElement>;

export const ArrowUpRight = (props: Props) => <Icon {...props}><path d="M7 17 17 7M8 7h9v9" /></Icon>;
export const ChevronLeft = (props: Props) => <Icon {...props}><path d="m15 18-6-6 6-6" /></Icon>;
export const ChevronRight = (props: Props) => <Icon {...props}><path d="m9 18 6-6-6-6" /></Icon>;
export const ChevronDown = (props: Props) => <Icon {...props}><path d="m6 9 6 6 6-6" /></Icon>;
export const Bag = (props: Props) => <Icon {...props}><path d="M5 8h14l-1 12H6L5 8Z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></Icon>;
export const User = (props: Props) => <Icon {...props}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Icon>;
export const Search = (props: Props) => <Icon {...props}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>;
export const Send = (props: Props) => <Icon {...props}><path d="M21 3 10 14" /><path d="m21 3-7 18-4-7-7-4 18-7Z" /></Icon>;
export const Globe = (props: Props) => <Icon {...props}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z" /></Icon>;
export const Bars = (props: Props) => <Icon {...props}><path d="M4 7h16M4 12h16M4 17h10" /></Icon>;
export const Minus = (props: Props) => <Icon {...props}><path d="M5 12h14" /></Icon>;
export const Plus = (props: Props) => <Icon {...props}><path d="M12 5v14M5 12h14" /></Icon>;
export const Check = (props: Props) => <Icon {...props}><path d="m5 12 5 5 9-10" /></Icon>;
