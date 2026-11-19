# Academy theme (`@tansy/theme-academy`)

How themes work in general is in [Themes](../EXTENDING.md#themes) and [Write and publish a theme](../guides/themes.md).

A school's site, for the [LMS plugin](../plugins/lms.md): a front page with the course catalogue and the plans, a course page with what it covers and how to take it, and a pricing page. With the [Payments plugin](../plugins/payments.md), plans that open courses show with their price and the courses each includes, all worked out from the data. A plan or course added in the dashboard appears without touching the theme. It follows the visitor's light or dark setting and works right to left.

```ts
// tansy.config.ts
import { lms } from "@tansy/lms";
import { payments } from "@tansy/payments";
import { stripe } from "@tansy/payments-stripe";
import { subscriptions } from "@tansy/subscriptions";
import { academy } from "@tansy/theme-academy";

export default defineCms({
  theme: academy({ tagline: "Learn to build for the web" }),
  plugins: [
    // Before the LMS, so the LMS gives courses their "Included in" field.
    payments({ siteUrl: "https://example.com", providers: [stripe()] }),
    lms(),
    subscriptions(),
  ],
});
```

In the starter, `TANSY_THEME=academy` turns it on, and turns the LMS on with it. Plans need `TANSY_PLUGIN_PAYMENTS=true`, and `TANSY_PLUGIN_SUBSCRIPTIONS=true` to run them from the dashboard. `TANSY_SITE_TAGLINE` sets `tagline`. Themes are chosen at build time, so set the same value for the build and the server, and restart after changing it.

## 1. Pages

| Address | Template | What it shows |
|---|---|---|
| `/` (with no record there) | `home` | The site's name and tagline, the catalogue, then the plans |
| A course, `/courses/:slug` by default | `lms-courses` | Title, summary, teacher, lessons and length, the description and the curriculum. Beside them: the cover, the learner's progress, and how to take it: enroll, continue, buy, or the plans that include it |
| The pricing page, `/pricing` by default | `academy-pricing` | Its title and introduction, then every plan with the courses it opens |
| A lesson, My courses, certificates | `lms-lessons`, `lms-my-courses`, `lms-certificate` | The LMS plugin's own pages, in the theme's layout |
| Any other record, such as a page | `default` | Title and body |

The pricing page is a singleton the theme adds, **Pricing page**. Fill it in under Records to give it a title and introduction. Until it has a record, the header's Pricing link goes to the plans on the front page.

The course page's outline, buttons and progress bar are the LMS plugin's parts (`courseOutline`, `Outline`, `CourseAction`, `Progress`), so they behave exactly as on the plugin's own page.

## 2. Plans

The theme reads plans and access as data. Both are public when published, for pricing pages. Nothing about a plan is written in the theme.

A plan shows on the site when it opens at least one course:

- **Every course**, when one of the access it includes opens `lms-courses` whole. It says so, with today's count, and covers courses added later.
- **Some courses**, when courses are "Included in" one of its access. It lists them.

Plans that open only other things, such as articles, are left out. Plans are ordered by price, cheapest first. A plan marked **Featured** stands out.

What a plan shows comes from its fields under Subscriptions → Plans: **Title** (or the name), **Description**, the monthly and yearly **price shown**, and **Featured**. The provider charges the price set with it, so keep them the same. The currency comes from Payments' settings unless the plan names its own.

**Subscribe** starts Payments' checkout for the plan through its API. Once the provider confirms, the person's entitlements include the plan's access, and each course it covers offers **Start with your plan**. See [LMS §8.1](../plugins/lms.md#81-courses-in-plans).

On each course card, badges say whether it's free, sold, by invitation, and how many plans include it.

## 3. Options

| Option | Default | What it does |
|---|---|---|
| `tagline` | none | Replaces the words under the front page's heading, and shows under the name in the footer |
| `colorScheme` | `"auto"` | `"auto"` follows the visitor's light or dark setting. `"light"` always shows light colours |

The theme's words are under `academy.*` and the LMS's under `lms.*`. Owners can change any of them per language under Languages → Site text.

## 4. Content it uses

| Collection | Fields read |
|---|---|
| `lms-courses` | `title`, `summary`, `cover`, `description`, `byline`, `level`, `access`, `estimatedMinutes`, and any Reference to Access, such as `included` |
| `payments-plans` | `name`, `title`, `description`, `amount`, `annualAmount`, `currency`, `featured`, `includes` (published only) |
| `payments-access` | `name`, `collections` (published only) |
| `payments-entitlements` | `access`, the signed-in person's own, on course pages |
| `academy-pricing`, `lms-my-courses` | Their addresses, for the header |

Without the Payments plugin the plan lists are empty, and the site is a catalogue with free, sold and invitation-only courses.
