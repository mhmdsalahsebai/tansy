/** Its own styles, as the admin bar's, since the site's theme knows nothing of the dashboard's. Colours are fixed so any theme leaves it readable. */
const STYLES = `.cms-demo-banner{position:relative;z-index:2147483000;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:4px 12px;padding:8px 16px;background:var(--cms-demo-banner-bg,#1e1b4b);color:var(--cms-demo-banner-fg,#eef2ff);font:400 13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center}
.cms-demo-banner a{display:inline-flex;align-items:center;height:28px;padding:0 12px;border-radius:6px;background:#eef2ff;color:#1e1b4b;font-weight:600;text-decoration:none;white-space:nowrap}
.cms-demo-banner a:hover{background:#fff}
.cms-demo-banner a:focus-visible{outline:2px solid #a5b4fc;outline-offset:2px}
@media print{.cms-demo-banner{display:none}}`;

/**
 * Above every site page of a demo (TANSY_DEMO_EMAIL and TANSY_DEMO_PASSWORD), for visitors who
 * aren't signed in: it says this is a demo and opens the dashboard, whose sign-in form starts
 * filled in with the demo's login.
 */
export function DemoBanner({ text, link, href, direction }: { text: string; link: string; href: string; direction?: "ltr" | "rtl" }) {
  return (
    <div className="cms-demo-banner" role="note" dir={direction}>
      <style>{STYLES}</style>
      <span>{text}</span>
      <a href={href}>{link}</a>
    </div>
  );
}
