"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import {
  AcademicCapIcon, ArrowRightStartOnRectangleIcon, ArrowTopRightOnSquareIcon, ArrowsRightLeftIcon, Bars3Icon, BookOpenIcon, ChevronDoubleLeftIcon, ChevronDownIcon, NewspaperIcon, ChevronDoubleRightIcon, ClipboardDocumentListIcon, CodeBracketIcon, Cog6ToothIcon,
  CommandLineIcon, CubeIcon, FolderIcon, GlobeAltIcon, HomeIcon, LanguageIcon, PhotoIcon, PuzzlePieceIcon, RectangleStackIcon, ShieldCheckIcon,
  Squares2X2Icon, SwatchIcon, CheckBadgeIcon, TrashIcon, UserCircleIcon, UsersIcon, XMarkIcon,
} from "@heroicons/react/16/solid";
import type { AdminIcon } from "../../core/extend/admin";
import { authClient } from "../../lib/auth-client";
import type { PluginSwitcher } from "../../core/extend/admin-nav";
import { TopBarSwitcher } from "./TopBarSwitcher";
import { cn } from "../../lib/utils";
import { accountPath, adminPath, authPath } from "../../lib/paths";
import { SIDEBAR_COOKIE } from "../../lib/preferences";
import { useT } from "../i18n";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

/** Icons are named rather than passed, since the layouts that build the nav are server components. */
const ICONS: Record<string, Icon> = {
  home: HomeIcon,
  collections: RectangleStackIcon,
  blocks: Squares2X2Icon,
  presets: SwatchIcon,
  reviews: CheckBadgeIcon,
  files: PhotoIcon,
  schema: CodeBracketIcon,
  webhooks: CubeIcon,
  redirects: ArrowsRightLeftIcon,
  trash: TrashIcon,
  site: GlobeAltIcon,
  users: UsersIcon,
  roles: ShieldCheckIcon,
  audit: ClipboardDocumentListIcon,
  logs: CommandLineIcon,
  settings: Cog6ToothIcon,
  languages: LanguageIcon,
  extensions: PuzzlePieceIcon,
  account: UserCircleIcon,
  academic: AcademicCapIcon,
  newspaper: NewspaperIcon,
  book: BookOpenIcon,
};

/** With `children`, a plugin's section: it opens to its links, and `href` is the first of them. */
export interface NavItem { name: string; href: string; group?: string; icon?: string | AdminIcon; children?: NavItem[] }

/** A built-in icon by name, or a plugin's own from its path data. */
function NavIcon({ icon, className = "cms-nav-icon" }: { icon?: string | AdminIcon; className?: string }) {
  if (icon && typeof icon === "object") {
    return (
      <svg className={className} viewBox={icon.viewBox ?? "0 0 16 16"} fill="currentColor" aria-hidden="true">
        {icon.paths.map((d, index) => <path key={index} d={d} fillRule={icon.fillRule} clipRule={icon.fillRule} />)}
      </svg>
    );
  }
  const Icon = ICONS[icon ?? ""] ?? FolderIcon;
  return <Icon className={className} aria-hidden="true" />;
}

/** The record editor takes the whole window, without the sidebar or top bar. Its history page doesn't. */
function isEditor(pathname: string) {
  const prefix = adminPath("/collections/");
  return pathname.startsWith(prefix) && /^[^/]+\/content\/[^/]+$/.test(pathname.slice(prefix.length));
}

function isActive(href: string, pathname: string) {
  return href === adminPath() ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * `shortcuts` are plugins' buttons at the end of the top bar, such as the AI assistant, and
 * `switchers` their choices that apply to every page, such as the tenant someone works in.
 * `siteHref` links to the public site, when there is one.
 */
export function AppShell({ appName, logoUrl, nav, shortcuts = [], switchers = [], siteHref, email, impersonating, collapsed: initiallyCollapsed = false, children }: { appName: string; logoUrl: string; nav: NavItem[]; shortcuts?: NavItem[]; switchers?: PluginSwitcher[]; siteHref?: string; email: string; impersonating: boolean; collapsed?: boolean; children: ReactNode }) {
  const pathname = usePathname();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  // Only applies on wide screens; below 64rem the sidebar is a drawer and always shows labels.
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "collapsed" : "expanded"}; path=/; max-age=31536000; samesite=lax`;
  };
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  const signOut = async () => {
    await authClient.signOut();
    window.location.href = authPath("signin");
  };
  const stopImpersonating = async () => {
    await authClient.admin.stopImpersonating();
    window.location.href = adminPath("/users");
  };

  const groups = new Map<string, NavItem[]>();
  for (const item of nav) groups.set(item.group ?? "", [...(groups.get(item.group ?? "") ?? []), item]);
  const links = nav.flatMap((item) => item.children ?? [item]);
  // The longest matching link wins, so /collections/x doesn't also light up a shorter sibling.
  const current = links.filter((item) => isActive(item.href, pathname)).sort((a, b) => b.href.length - a.href.length)[0];
  const sectionOf = (link: NavItem | undefined) => nav.find((item) => link && item.children?.includes(link));
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const isOpen = (section: NavItem) => toggled[section.name] ?? sectionOf(current) === section;

  const renderLink = (item: NavItem, nested = false) => {
    const active = item === current;
    return (
      <Link key={item.href} href={item.href} className={cn("cms-nav-link", nested && "cms-nav-link-nested", active && "cms-nav-link-active")} aria-current={active ? "page" : undefined} title={collapsed ? item.name : undefined} onClick={() => setOpen(false)}>
        {!nested && <NavIcon icon={item.icon} />}
        <span className="cms-truncate cms-sidebar-label">{item.name}</span>
      </Link>
    );
  };

  const renderSection = (section: NavItem) => {
    const expanded = isOpen(section);
    const holdsCurrent = sectionOf(current) === section;
    const id = `cms-nav-${section.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    // Collapsed to icons, a section is a link to its first page.
    if (collapsed) {
      return (
        <Link key={section.name} href={section.href} className={cn("cms-nav-link", holdsCurrent && "cms-nav-link-active")} title={section.name} onClick={() => setOpen(false)}>
          <NavIcon icon={section.icon} />
          <span className="cms-truncate cms-sidebar-label">{section.name}</span>
        </Link>
      );
    }
    return (
      <div key={section.name} className="cms-nav-section">
        <button type="button" className={cn("cms-nav-link cms-nav-section-toggle", holdsCurrent && !expanded && "cms-nav-link-active")} aria-expanded={expanded} aria-controls={id} onClick={() => setToggled((state) => ({ ...state, [section.name]: !expanded }))}>
          <NavIcon icon={section.icon} />
          <span className="cms-truncate cms-sidebar-label">{section.name}</span>
          <ChevronDownIcon className={cn("cms-nav-chevron", expanded && "cms-nav-chevron-open")} aria-hidden="true" />
        </button>
        {expanded && <div id={id} className="cms-nav-children">{section.children!.map((child) => renderLink(child, true))}</div>}
      </div>
    );
  };

  return (
    <div className="cms-app">
      {impersonating && (
        <div className="cms-banner">
          <span>{t("shell.impersonating", { email })}</span>
          <button type="button" onClick={stopImpersonating} className="cms-underline cms-medium">{t("shell.stopImpersonating")}</button>
        </div>
      )}
      <div className={cn("cms-shell", collapsed && "cms-shell-collapsed", isEditor(pathname) && "cms-shell-focus")}>
        {open && <div className="cms-sidebar-scrim" aria-hidden="true" onClick={() => setOpen(false)} />}
        <aside id="cms-sidebar" className={cn("cms-sidebar", open && "cms-sidebar-open")} aria-label={t("shell.main")}>
          <div className="cms-sidebar-head">
            <Link href={adminPath()} className="cms-brand" title={collapsed ? appName : undefined} onClick={() => setOpen(false)}>
              {/* eslint-disable-next-line @next/next/no-img-element -- an administrator's path, whose size next/image can't know */}
              {logoUrl ? <img src={logoUrl} alt="" className="cms-brand-logo" /> : <span className="cms-brand-mark" aria-hidden="true">{appName.trim().charAt(0) || "C"}</span>}
              <span className="cms-truncate cms-sidebar-label">{appName}</span>
            </Link>
            <button type="button" className="cms-icon-btn cms-menu-btn cms-ml-auto" onClick={() => setOpen(false)} aria-label={t("shell.closeMenu")}>
              <XMarkIcon className="cms-icon" aria-hidden="true" />
            </button>
          </div>
          <nav className="cms-sidebar-nav">
            {[...groups].map(([group, items]) => (
              <div key={group || "main"} className="cms-nav-group">
                {group && <div className="cms-nav-group-label">{group}</div>}
                {items.map((item) => (item.children ? renderSection(item) : renderLink(item)))}
              </div>
            ))}
          </nav>
          <div className="cms-sidebar-foot">
            <Link href={accountPath()} className="cms-account" title={email} onClick={() => setOpen(false)}>
              <span className="cms-avatar" aria-hidden="true">{email.charAt(0)}</span>
              <span className="cms-account-email">{email}</span>
            </Link>
            <button type="button" className="cms-icon-btn" onClick={signOut} aria-label={t("shell.signOut")} title={t("shell.signOut")}>
              <ArrowRightStartOnRectangleIcon className="cms-icon" aria-hidden="true" />
            </button>
          </div>
        </aside>
        <div className="cms-shell-body">
          <header className="cms-topbar">
            <button type="button" className="cms-icon-btn cms-menu-btn" onClick={() => setOpen(true)} aria-label={t("shell.openMenu")} aria-controls="cms-sidebar" aria-expanded={open}>
              <Bars3Icon className="cms-icon" aria-hidden="true" />
            </button>
            <button type="button" className="cms-icon-btn cms-collapse-btn" onClick={toggleCollapsed} aria-label={collapsed ? t("shell.expandSidebar") : t("shell.collapseSidebar")} title={collapsed ? t("shell.expandSidebar") : t("shell.collapseSidebar")} aria-controls="cms-sidebar" aria-expanded={!collapsed}>
              {collapsed ? <ChevronDoubleRightIcon className="cms-icon" aria-hidden="true" /> : <ChevronDoubleLeftIcon className="cms-icon" aria-hidden="true" />}
            </button>
            <div className="cms-crumbs">
              <span className="cms-truncate">{appName}</span>
              {current && (
                <>
                  <span className="cms-crumb-sep" aria-hidden="true">/</span>
                  {sectionOf(current) && <><span className="cms-truncate">{sectionOf(current)!.name}</span><span className="cms-crumb-sep" aria-hidden="true">/</span></>}
                  <span className="cms-crumb-current">{current.name}</span>
                </>
              )}
            </div>
            <div className="cms-topbar-end">
              {switchers.map((switcher) => <TopBarSwitcher key={switcher.plugin} switcher={switcher} />)}
              {siteHref && (
                <a href={siteHref} className="cms-topbar-link" title={t("shell.viewSite")}>
                  <ArrowTopRightOnSquareIcon className="cms-icon" aria-hidden="true" />
                  <span className="cms-topbar-link-label">{t("shell.viewSite")}</span>
                </a>
              )}
              {shortcuts.map((shortcut) => (
                <Link key={shortcut.href} href={shortcut.href} className={cn("cms-icon-btn cms-topbar-shortcut", isActive(shortcut.href, pathname) && "cms-topbar-shortcut-active")} aria-label={shortcut.name} title={shortcut.name} aria-current={isActive(shortcut.href, pathname) ? "page" : undefined}>
                  <NavIcon icon={shortcut.icon} className="cms-icon" />
                </Link>
              ))}
            </div>
          </header>
          <main className="cms-main">{children}</main>
        </div>
      </div>
    </div>
  );
}
