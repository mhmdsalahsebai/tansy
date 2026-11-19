# Dashboard design system

Every dashboard page, built-in or a plugin's, is built from the same few parts, so the dashboard reads
as one product and a change to how a part looks reaches every page at once. This page is the pattern;
`eslint.config.mjs` (`ui/use-kit`) and `tests/unit/design-system.test.ts` enforce it.

## Look

A light grey page with white cards on it, a single blue accent, and quiet type.

- **Accent** is for what's current and what to do next: the primary button, the active nav item and
  tab, links, focus rings. One primary button per area, at the far end of its row.
- **Status colours** carry meaning only: success for live or done, warning for draft or pending,
  danger for failed or destructive, info for scheduled or neutral facts. Never for decoration.
- **Labels** of groups and table columns are small uppercase muted text. Titles are sentence case.
- **Surfaces** are cards (`--cms-radius-lg`, a 1px border, `--cms-shadow-xs`). Nothing else gets a shadow
  except popovers and dialogs.

All of it is tokens in `styles/tokens.css` and `styles/tokens-dark.css`. Component styles name tokens,
never literal colours, so the dark theme, an administrator's accent (Settings → Branding) and themes'
`cms.overrides` reach every component. Need a new colour? Add a semantic token for both themes.

## Page anatomy

```
‹ Back to users                                   ← PageHeader back (detail pages only)
Title                              [Secondary] [Primary]   ← PageHeader title + actions
12 items · Edit fields · API rules                ← PageHeader meta, or a description
─ Tab ─ Tab 3 ─ Tab ───────────────               ← TabLinks (pages) or Tabs (in place)
┌ Card title ─────────────────── [Action] ┐       ← Card title + actions
│ [🔍 Search…] [Filter ▾]        [New ▾]  │       ← Card toolbar: Toolbar + SearchInput
├─────────────────────────────────────────┤
│ NAME        CATEGORY      UPDATED       │       ← table in a flush Card
│ Apple       [Design]      1 day ago     │       ← Badge for categories and states
└─────────────────────────────────────────┘
```

1. A page is wrapped in `cms-gutter` and starts with `PageHeader`. Detail pages pass `back`.
2. Sections are `Card`s. Every table is a `DataTable`: the card, its toolbar, the table, an empty state,
   placeholder rows while loading and the footer, so lists look and behave the same everywhere.
3. Search and filters for a list go in the table's `toolbar`: `<Toolbar end={actions}><SearchInput …/>…</Toolbar>`.
   The page's create action is the primary button in `PageHeader`; creating opens a `Modal` or a page.
   Row actions are `<button className="cms-row-action">` in a row's `actions`.
4. Sub-pages of one thing are `TabLinks`; panels switched in place are `Tabs`; a filter among a few
   values (a date range, a source) is a `SegmentedControl`.
5. Activity and history are a `Timeline`.
6. Nothing to show is an `EmptyState`. Feedback is an `Alert` above the content it is about.
   Loading shows the shape of what is coming: `DataTable rows={null}`, `PageSkeleton kind=…` for a
   whole page, `Skeleton` for a line. Never a "Loading…" text. The dashboard's `loading.tsx` draws a
   `PageSkeleton` for every server navigation.
7. Long settings pages are `SettingsSection`s: title and help on the side, the controls in a card.

## Components

From `components/ui/kit.tsx`; plugins import them from `tansy/admin`.

| Need | Use | Not |
| --- | --- | --- |
| Top of a page | `PageHeader` (`back`, `meta`, `actions`) | `cms-page-header`, `cms-page-title` |
| A button | `Button` (`primary`, `secondary`, `danger`, `ghost`) | `className="cms-btn …"` |
| A link that looks like a button | `ButtonLink` (`native` for downloads and full page loads) | `<a className="cms-btn">` |
| A section | `Card` (`title`, `actions`, `toolbar`, `flush`) | `cms-card-header`, `cms-panel-head` |
| A list or table | `DataTable` (`columns`, `rows`, `toolbar`, `empty`, `footer`, `sort`, `selection`, `title`) | `<table className="cms-table">` in a page |
| Search and filters | `Toolbar`, `SearchInput` | `cms-grid-search` |
| Loading | `DataTable rows={null}`, `PageSkeleton`, `Skeleton` | "Loading…" text, `cms-skeleton` by hand |
| A state or category | `Badge tone=…` (`tight` in dense rows, `href` to link) | `cms-badge-*`, tone class lookups |
| Tabs | `TabLinks`, `Tabs`, `SegmentedControl` | `cms-tabs`, `cms-tab`, `cms-pills` |
| Activity | `Timeline` | a hand-built list |
| Messages | `Alert kind=…` | `cms-alert-*` |

Layout utilities (`cms-row`, `cms-stack-4`, `cms-gap-2`, `cms-muted` …) and structural classes with no
component (`cms-table`, `cms-table-wrap`, `cms-feed`, `cms-stat`) stay classes.

## Enforcement

- `ui/use-kit` in `eslint.config.mjs` fails `npm run check` when a page or plugin writes a component's
  classes itself. Don't silence it: if the kit can't do what a page needs, extend the kit.
- `tests/unit/design-system.test.ts` fails on a literal colour in the dashboard's component CSS.
- A new kit component exported from `tansy/admin` changes `tests/contract/public-api.json`: follow
  `DEPRECATION.md`.
