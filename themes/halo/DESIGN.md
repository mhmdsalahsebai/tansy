# Halo — design system

A news front page for the blog plugin: dense, quiet panels on a pale lavender page, with one
iridescent "halo" as the only decoration. Built from the owner's reference screens, not from
UXKIN examples. The values below are the tokens in `index.ts` and the variables in `theme.css`;
pages use the names, never the raw values.

## Feeling

Calm, current, information-first. Many stories on one screen without looking busy: white
panels do the grouping, so there are no borders between cards and almost no shadows.

## Colour

| Token | Light | Dark | Role |
|---|---|---|---|
| `color.page` | `#eef1f8` | `#0b0c14` | The page behind every panel |
| `color.panel` | `#ffffff` | `#141622` | Panels: the lead, the latest list, the sidebar |
| `color.surface` | `#e9edf6` | `#1d2030` | Chips, the search field, quiet buttons, empty images |
| `color.text` | `#0e1020` | `#eceef7` | Headlines and body |
| `color.muted` | `#5d6478` | `#9da3b8` | Times, tags, excerpts. 5.9:1 on panel |
| `color.border` | `#e1e5ef` | `#262a3c` | Hairlines between rows, the field's edge |
| `color.accent` | `#3450d1` | `#3450d1` (lightened in CSS) | Category names, links, focus rings. The Settings accent replaces it |
| `color.on-accent` | `#ffffff` | — | Text on the accent |
| `color.glow` | `#a995ff` | — | The halo, the section marker, the wash over feature images |
| `color.ink` | `#10111a` | `#eceef7` | The one solid button: the pager's "next" |

At most one accent (blue) and one decorative colour (lavender). Lavender never carries text.
Dark mode changes neutrals only; the owner's accent stays theirs.

## Typography

Geist (variable, served from the site). One family; weight and size make the hierarchy.

| Step | Size / line height | Weight | Use |
|---|---|---|---|
| `display` | clamp(2rem → 3rem) / 1.1 | 600 | The lead story's headline |
| `h2` | clamp(1.6rem → 2.25rem) / 1.15 | 600 | Spotlight, post title |
| `h3` | 1.125rem / 1.3 | 600 | Card titles in the trending grid |
| `row` | 0.9rem / 1.35 | 600 | Titles in lists beside a thumbnail |
| `body` | 1.0625rem / 1.75 | 400 | Article text, 42rem measure (≈70 characters) |
| `small` | 0.8125rem / 1.5 | 400 | Excerpts in panels, tags |
| `meta` | 0.75rem / 1.4 | 500 | Category · time, section labels (caps, 0.06em tracking) |

Headlines track at −0.03em and wrap balanced.

## Spacing

4px base. Gaps between panels `space.gap` 1rem, inside a panel 1.5rem–2.5rem, between
sections `space.section` 3.5rem, page edge `space.gutter` 1rem. Content width `size.wide`
86rem; sidebar `size.aside` 22rem; reading column `size.measure` 42rem.

## Shape and depth

| Token | Value | Use |
|---|---|---|
| `radius.panel` | 1.5rem | Panels and the large feature card |
| `radius.card` | 0.875rem | Images in cards and rows |
| `radius.control` | 999px | Chips, buttons, pager circles |
| `radius.field` | 0.875rem | The search field and its results |
| `shadow.float` | soft lavender drop | Only things that float: menus, search results, the "Readers' choice" badge |

## Components

- **Section label**: caps `meta` text with a 3px lavender bar on its start side, and
  "View more →" at the other end when the section has an archive.
- **Meta line**: category in the accent, a dot, then the time ("4 hours ago", worked out in the
  visitor's browser so cached pages stay true).
- **Tags**: `#Name` in muted text, each a link to the tag.
- **Buttons**: *primary pill* (surface background, text, a circled arrow) for "Read article";
  *ink circle* for the pager's next; *outline circle* for previous. Hover darkens the surface,
  focus shows a 2px accent ring, a disabled pager arrow is 40% opacity and not a link.
- **Chips** (header menu): surface pills; an item with children shows "+" and opens a panel.
- **Row**: title and meta at the start, a square thumbnail at the end, a hairline between rows.
- **Card**: image 16:10, meta, title clamped to 3 lines, tags.
- **Feature card**: cover with a lavender wash rising from the bottom, white text over it.
- **Search field**: surface field with the icon at the end; results open in a floating panel.

## Imagery and icons

Covers come from posts and are cropped by their focal point. A post with no cover gets a
lavender-to-surface placeholder, never a broken image. The halo orb is CSS only (radial and
conic gradients), so it costs no request and follows the accent. Icons are inline 20px
strokes (search, arrow, chevron, globe), drawn in `currentColor`. No emoji.

## Avoided on purpose

Gradient text, glass on every surface, identical three-card rows, centred everything. The
gradient lives in one place (the halo and the feature wash) and does not spread.
