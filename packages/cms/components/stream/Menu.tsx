import { safeHref } from "../../core/fields/rich-text";
import { redirectTarget } from "../../core/urls/path";

export interface MenuLink {
  id: string;
  type: string;
  value: Record<string, unknown>;
}

/** A site path or an allowed outside link. Checked here as well as on save, since this renders whatever the API returned. */
const menuHref = (url: unknown) => (typeof url === "string" && url.startsWith("/") ? redirectTarget(url) : safeHref(url));

/** Renders a stream of `menu_item` blocks as nested lists. Works in server components. An item with an unusable link shows as plain text. */
export function Menu({ items, className }: { items: unknown; className?: string }) {
  if (!Array.isArray(items) || !items.length) return null;
  return (
    <ul className={className}>
      {(items as MenuLink[]).filter((item) => item.type === "menu_item").map(({ id, value }) => {
        const href = menuHref(value.url);
        const label = String(value.label ?? "");
        return (
          <li key={id}>
            {href ? <a href={href} {...(value.newTab === true ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{label}</a> : label}
            <Menu items={value.children} />
          </li>
        );
      })}
    </ul>
  );
}
