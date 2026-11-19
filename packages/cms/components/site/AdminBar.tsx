import type { SiteAdminBar } from "../../core/site/admin-bar";

/** Its own styles, since the site's theme knows nothing of the dashboard's. Colours are fixed so any theme leaves the bar readable. */
const STYLES = `.cms-site-bar{position:relative;z-index:2147483000;display:flex;align-items:center;gap:4px;height:36px;padding:0 12px;background:var(--cms-site-bar-bg,#18181b);color:var(--cms-site-bar-fg,#fafafa);font:500 13px/1 system-ui,-apple-system,"Segoe UI",sans-serif}
.cms-site-bar a{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:6px;color:inherit;text-decoration:none}
.cms-site-bar a:hover{background:rgba(255,255,255,.12)}
.cms-site-bar a:focus-visible{outline:2px solid #60a5fa;outline-offset:1px}
.cms-site-bar svg{width:14px;height:14px;flex:none}
@media print{.cms-site-bar{display:none}}`;

const HOME = "M9.293 2.293a1 1 0 0 1 1.414 0l7 7A1 1 0 0 1 17 11h-1v6a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6H3a1 1 0 0 1-.707-1.707l7-7Z";
const PENCIL = "m5.433 13.917 1.262-3.155A4 4 0 0 1 7.58 9.42l6.92-6.918a2.121 2.121 0 0 1 3 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 0 1-.65-.65Z M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0 0 10 3H4.75A2.75 2.75 0 0 0 2 5.75v9.5A2.75 2.75 0 0 0 4.75 18h9.5A2.75 2.75 0 0 0 17 15.25V10a.75.75 0 0 0-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5Z";

/** The site's bar for people who can use the dashboard: back to it, and to edit this page. */
export function AdminBar({ bar }: { bar: SiteAdminBar }) {
  return (
    <div className="cms-site-bar" role="navigation" aria-label={bar.dashboard.label} dir={bar.direction}>
      <style>{STYLES}</style>
      <a href={bar.dashboard.href}>
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d={HOME} /></svg>
        {bar.dashboard.label}
      </a>
      {bar.edit && (
        <a href={bar.edit.href}>
          <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d={PENCIL} /></svg>
          {bar.edit.label}
        </a>
      )}
    </div>
  );
}
