---
title: "LMS plugin (`@tansy/lms`)"
description: "Installing it turns the CMS into a learning platform: courses made of sections and lessons, enrollments, progress tracking, quizzes, and certificates anyone can verify."
---

Installing it turns the CMS into a learning platform: courses made of sections and lessons, enrollments, progress tracking, quizzes, and certificates anyone can verify.

```ts
// tansy.config.ts
import { lms } from "@tansy/lms";

plugins: [lms({ basePath: "/courses", passingScore: 70 })]
```

## 1. Scope

**First version**: courses, sections, lessons (video, text, files, embedded quiz), instructor and manager roles, a course builder, free self-enrollment, manual enrollment by staff, lesson completion, course progress, graded quizzes with retakes, certificates with a public verification page, "my courses" for learners, and a learners overview for staff.

**With the Payments plugin installed**: paid courses, enrolled on payment and removed on refund (§8), and courses included in plans, enrolled through a subscription and lapsed when it ends (§8.1).

**Later**: drip schedules (lessons unlocking over time), cohorts, assignments graded by hand, discussion per lesson, course reviews, SCORM.

## 2. Options

| Option | Default | What it does |
|---|---|---|
| `basePath` | `/courses` | The prefix of the URL patterns, read on first install |
| `passingScore` | `70` | Default percentage to pass a quiz. Each quiz can override it |
| `certificates` | `true` | Issue a certificate when a course is completed |
| `requireQuizzes` | `true` | Whether a course counts as completed only after its quizzes are passed |

The last three are only defaults. Holders of `ext.lms:manage` change them under **LMS → Settings**, and they apply from the next request, without a rebuild.

### Roles

Created once on install, by migration `002-instructors-are-people`, then edited under **Roles** like any other. Instructors are people with an account, not records.

| Role | Can |
|---|---|
| `lms-instructor` | Create courses, and list, read, edit and delete only their own, with their sections, lessons and quizzes (own-record grants). A hook refuses attaching a section, lesson or quiz to someone else's course. Their name goes on their courses as `byline`, which they can't change |
| `lms-manager` | Everything in every LMS collection, `ext.lms:manage` (settings, learners, any byline) and `ext.lms:enroll` |

Sites that installed the LMS before these roles keep their `lms-instructors` collection and each course's `instructors` field. The migration adds `byline` and leaves the old data for the owner to copy and delete.

## 3. Collections

Rules are `list / view / create / update / delete`. `null` means locked.

### Content

| Collection | URL | Rules | Fields (contract in **bold**) |
|---|---|---|---|
| `lms-courses` | `/courses/:slug` | `status = "published"` ×2, then `null` ×3 | **`slug`**, **`title`**, **`summary`**, `cover`, `description` (stream), `byline` (text, "Taught by": the creator's name, changed only by managers), `level` (radio), **`access`** (radio: free, enrollment, paid, the last added by migration 003), `estimatedMinutes` |
| `lms-sections` | none | `""` ×2, `null` ×3 | **`course`** (ref), **`title`**, **`position`** (number) |
| `lms-lessons` | `/learn/:slug` | §5 | **`slug`**, **`title`**, **`course`** (ref), **`section`** (ref), **`position`**, **`preview`** (boolean), **`content`** (stream), `durationMinutes` |
| `lms-quizzes` | none | §5 | **`lesson`** (ref), **`course`** (ref, set from the lesson on every save), **`title`**, **`questions`** (stream of `lms_question`, **hidden**), **`passingScore`** (number), **`maxAttempts`** (number, empty for no limit) |

### Per learner

The plugin's routes write these, and staff can write them in the dashboard. Learners can never write them directly.

| Collection | Rules | Fields |
|---|---|---|
| `lms-enrollments` | `student = @request.auth.id` ×2, `null` ×3 | **`course`** (ref), **`student`** (text: user id), **`state`** (radio: active, completed, revoked, lapsed), **`source`** (radio: free, staff, purchase, plan), **`enrolledAt`**, **`completedAt`** |
| `lms-progress` | `student = @request.auth.id` ×2, `null` ×3 | **`key`** (text, unique: `<student>:<lesson>`, so a lesson completes once), **`student`**, **`course`**, **`lesson`** (ref), `completedAt` |
| `lms-attempts` | `student = @request.auth.id` ×2, `null` ×3 | **`quiz`** (ref), **`student`**, **`answers`** (json), **`score`** (number), **`passed`** (boolean), `submittedAt` |
| `lms-certificates` | `student = @request.auth.id` ×2, `null` ×3 | **`code`** (text, unique, random 16 characters), **`student`**, **`course`** (ref), `studentName`, `issuedAt` |

The rules as built also require `@request.auth.id != ""`. The enrollment's field is `state`, not `status`, because every record already has a system `status` (draft or published), as `blog-comments` found.

A quiz's rule can't follow `lesson.course`, because rules read only the record's own fields. So a quiz carries `course`, which a hook sets from its lesson on every save, whatever was sent.

Two singletons give the learner's pages an address: `lms-my-courses` at `/my-courses` and `lms-certificate` at `/certificates`, each with a `title` and an `intro`.

### Views

`lms-outline` is a view collection (core `type: "view"`) over `lms-lessons`. It exposes only `id`, `title`, `course`, `section`, `position`, `preview` and `durationMinutes` of published lessons, with public rules. A course page shows its full outline to anyone, while the lessons themselves stay gated. The view query has to run on both SQLite and Postgres, which L1 tests.

### User field

`lms_courses`: json, hidden, not self-editable. It lists the ids of the courses the user is enrolled in: active or completed, never revoked. Only the plugin writes it (C4), from enrollment hooks (§6). Rules read it as `@request.auth.lms_courses`.

## 4. Blocks and field types

| Block | Fields | Notes |
|---|---|---|
| `lms_video` | `file` (file, video) or `url` (YouTube or Vimeo), `title`, `transcript` (rich text) | Frames declared under `csp.frame` |
| `lms_text` | `body` (rich text) | |
| `lms_download` | `file`, `label` | Readable only by those who can view the lesson, through core file rules |
| `lms_quiz` | `quiz` (ref → `lms-quizzes`) | Places a quiz inside a lesson. Created by migration 001 rather than declared in the plugin's `blocks`, because a block in code can't name a collection its own migration creates |
| `lms_question` | `prompt`, `kind` (radio: single, multiple, short), `choices` (json list), `correct` (json: a choice's position from 0, a list of them, or the accepted typed answers), `explanation` | Only inside `lms-quizzes.questions`, which is hidden. A question with no usable `correct` never scores |

No custom field types are needed in the first version.

## 5. How gating works

Lesson rules, set by the migration:

```
list / view:  status = "published" && (preview = true || @request.auth.lms_courses ?= course)
create / update / delete: null
```

- A preview lesson is public. Any other lesson needs an active enrollment, so the check stays inside the rules engine. That covers list, view, expand, realtime, and files inside lesson blocks, with no extra route that could forget a check.
- `?=` is any-of over an array, which the evaluator already supports.
- The site's own lesson pages honour the same rule through core gap C9. `/learn/:slug` resolves as a visitor first, then, for a signed-in person, as a member: their identity and user fields, never their role's permissions. So an enrolled learner gets the page, and an administrator who isn't enrolled gets the same 404 as a visitor. The lesson's outline, progress and enrollment come from template queries marked `viewer: true`. Nothing in the LMS checks access for pages itself.
- Revoking an enrollment removes the course id from `lms_courses`. The next request is refused, because rules read user values on every request.
- A rule on `lms-enrollments` through `@collection` would also work, but it reads the whole collection and denies above 10,000 rows. The user field doesn't have that limit.

Quizzes have the same rule. Their `questions` field is hidden, because `correct` is inside it and a block field can't be hidden on its own. `GET /api/ext/lms/quizzes/:id` first does `records.get("lms-quizzes", id)` as the caller, so the rule decides access. Then it reads `questions` through `system.records`, and returns them without `correct` or `explanation`. Grading happens only on the server.

## 6. Hooks

| Event | Collection | What it does |
|---|---|---|
| `beforeCreate` / `beforeUpdate` | `lms-lessons` | Fills the slug. Rejects a `section` from another course |
| `beforeCreate` | `lms-enrollments` | Rejects a second active enrollment for the same student and course |
| `afterCreate` / `afterUpdate` / `afterDelete` | `lms-enrollments` | Rebuilds the student's `lms_courses` from their active enrollments (C4). It rebuilds rather than adding or removing one id, so it repairs itself |
| `afterCreate` | `lms-enrollments` | Sends a welcome email (C2) |
| `afterCreate` | `lms-progress`, `lms-attempts` | Checks whether the course is now complete. If so, sets the enrollment to completed, issues a certificate, and emails it |
| `beforeCreate` / `beforeUpdate` | `lms-quizzes` | Sets `course` from the lesson |
| `beforeCreate` / `beforeUpdate` | `lms-courses` | Fills the slug. Puts the creator's name in `byline`, and refuses a change to it from anyone without `ext.lms:manage` |
| `beforeCreate` / `beforeUpdate` | `lms-sections`, `lms-lessons`, `lms-quizzes` | For someone without `ext.lms:manage` or `record:update`, refuses a course they didn't create, when created or moved |
| `beforeUpdate` | `lms-enrollments` | Refuses moving an enrollment to another learner or course, and dates a completion |

The routes also rebuild `lms_courses` and check completion straight away, because after-hooks run after the response. Each step is idempotent, and they take turns through a per-key lock kept on `globalThis`: Next.js loads routes and hooks as separate copies of a module, and two SQLite writers in one process would otherwise wait on each other.

Hooks fire for dashboard writes too, so enrolling someone by hand under **Records** works like any other enrollment.

## 7. Routes

| Method and path | Access | Audit | What it does |
|---|---|---|---|
| `POST /api/ext/lms/courses/:id/enroll` | authenticated | `lms.enroll` | Free courses, and courses the caller's plans cover (§8.1). Reads the course as the caller, so a draft course can't be joined, and coverage from what Payments stored |
| `POST /api/ext/lms/lessons/:id/complete` | authenticated | `lms.lesson_complete` | Reads the lesson as the caller (the gate), then writes progress by its `key`. Repeating it does nothing |
| `GET /api/ext/lms/me/courses` | authenticated | | Enrollments with percentage complete and the next lesson |
| `GET /api/ext/lms/quizzes/:id` | authenticated | | Questions without answers (§5), and attempts left |
| `POST /api/ext/lms/quizzes/:id/attempts` | authenticated, 10 a minute | `lms.quiz_attempt` | Checks access and attempts left, grades on the server, stores the attempt. Returns the score only, never which answers were right, so a retake doesn't get the key. 409 when no attempts are left |
| `GET /api/ext/lms/certificates/:code` | public: "Anyone with a certificate's code may check it is genuine. It reveals only the name, course and date." | | Verification. Forgives case, spaces and hyphens. Codes are 80 random bits, and the API's read limit applies |
| `POST /api/ext/lms/enrollments` | permission `ext.lms:enroll` | `lms.enroll_staff` | Enroll people in a course by email, up to 200 at once. Returns counts only: enrolled, already enrolled, and with no account, never which addresses have accounts |

### Agent tools

Added on 2026-11-14 (C18). Served over MCP and to the AI assistant ([the AI plugin](/docs/plugins/ai)), each as the caller, so an instructor builds only their own courses:

- `lms_create_course`: a course, its sections in order and each section's lessons with Markdown text (an `lms_text` block), all as drafts. Covers, videos, downloads and quizzes are added in the builder afterwards.
- `lms_outline`: a course's sections and lessons in order, with ids.

## 8. Selling courses when the Payments plugin is installed

Courses are sold directly. The two plugins share data, not code ([Payments §2](/docs/plugins/payments#2-what-the-plugin-adds)). Built on 2026-11-13.

1. The owner adds Payments' price field (`payments_price`) to `lms-courses`, which makes courses sellable. LMS doesn't add it itself: a free-only site never needs it.
2. A course is sold when its `access` is `paid`, the third way in beside free and staff enrollment. A paid course needs a price above zero. Only a paid course keeps one: a price sent with any other access is refused, and switching a paid course to free or staff enrollment clears it. So nobody can buy a course around its access through Payments' checkout. The free enroll route refuses a paid course with `PURCHASE_REQUIRED`. The course builder offers **People who buy it**, with a Price input once the price field exists.
3. On `record.afterCreate` of `payments-purchases` with `state: "paid"`, when `collection` is `lms-courses`, LMS enrolls the buyer with `source: "purchase"`, unless they already have a current enrollment. The hook is durable (C12), so it is safe to run twice. A course deleted since is skipped.
4. On `record.afterUpdate` of `payments-purchases`, when `state` becomes `refunded`, LMS revokes that buyer's `purchase` enrollments in the course. Staff and free enrollments stay.
5. The page of a paid course asks Payments' public `GET /api/ext/payments/offer` for the price, and shows **Buy for $49.00**, which starts Payments' checkout. Back from the provider with `?purchase=success&session_id=…`, it asks Payments to confirm the checkout, then waits for the enrollment and reloads.

Without Payments, or before a provider is connected, the offer route offers nothing, and a paid course page says it isn't on sale yet. Staff can still enroll learners in it.

This depends on the field contract of `payments-purchases`: `buyer`, `collection`, `recordId` and `state`.

### 8.1 Courses in plans

Built on 2026-11-17, as Payments' P7 ([Payments §8.3](/docs/plugins/payments#83-sellers)). A subscription opens courses without buying each one: "Basic opens these three", "All access opens every course". Like purchases, LMS reads Payments' data and imports nothing from it.

**What a plan covers.** Plans include access (`payments-access`). A course is covered for a person when their `payments-entitlements` record lists:

- `lms-courses`, which an access lists in its `collections` to open every course, now and later, or
- one of the access the course is **Included in**: a Reference to Access on `lms-courses` that allows several.

Migration `006-plans` adds that field, `included`, when Payments is installed first. Payments listed after the LMS, or added later, means the owner adds it under Collections → Courses. Any Reference to Access on courses counts, whatever its name. Being in a plan is separate from the course's own `access`: a paid course in a plan can be bought or taken with the plan, and a course staff enroll people in can be opened to a plan.

**Enrolling.** The enroll route enrolls a free course as before. Otherwise, when the caller's plans cover the course, it enrolls them with `source: "plan"`. Both the course's access and the person's entitlements are read on the server, never from the request. Subscribers enroll course by course, with **Start with your plan** on the course page, so "My courses" holds what they chose.

**When plans change.** A durable hook on `payments-entitlements` brings the person's plan enrollments in line: a course no longer covered becomes `lapsed`, and a lapsed one covered again becomes `active`, in the same enrollment. Progress, quiz attempts and certificates are kept either way, and a restored course that was finished counts as completed again. `lms_courses` holds only active and completed enrollments, so lessons close and open on the next request. A course taken out of an access, or put in one, is followed the same way, for everyone in it through a plan.

Someone in a course through their plan who then buys it, or whom staff enroll, keeps it when the plan ends: the enrollment takes the new source. Enrolling again in a lapsed course reopens that enrollment rather than making another.

**On the course page.** The template reads published plans and access, and the person's own entitlements as a `viewer` query, all of which Payments makes readable. A course a plan covers offers **Start with your plan**. Otherwise the plans that include it are offered, each with its price and **Subscribe**, beside **Buy** for a paid course. `coursePlans`, `PlanOffers` and `SubscribeToPlan` are exported from `@tansy/lms/render` for themes, as [the academy theme](/docs/themes/academy) uses them.

## 9. Dashboard

`permissions: { "ext.lms": ["manage", "enroll"] }`.

| Slot | What |
|---|---|
| Section **LMS** | Courses, Learners, Enrollments, Certificates, Quiz attempts, the two site pages, and Settings, each shown to whoever may open it |
| Page `lms/courses` (may list `lms-courses`) | Every course for managers, their own for instructors, with a box to create one |
| Page `lms/courses/:id` (may list `lms-courses`) | The course builder: details, and the curriculum on one page. Add, rename, reorder and delete sections and lessons, move a lesson between sections, publish, make a preview, and add a quiz, which also puts a Quiz block at the end of its lesson. Lesson content, the cover and the description open in the record editor. Every change goes through the records API as the signed-in person |
| Page `lms/learners` (`ext.lms:manage`) | Per course: enrollments, average progress, quiz pass rates, recent completions |
| Settings (`ext.lms:manage`) | Passing score, required quizzes, certificates |
| `recordPanels` on courses, sections, lessons and quizzes | A link back to the course builder |
| Widget (`ext.lms:manage`) | New enrollments this week, completions, the most-started courses |
| `recordActions` on `lms-courses` (`ext.lms:enroll`) | Enroll users by email |

A lesson panel was dropped: the lesson form already shows its course, section and preview state.

## 10. Site pages

Through plugin `templates` (C1):

| Template | Shows |
|---|---|
| `lms-courses` | Cover, summary, who teaches it, the outline from `lms-outline`, progress, and an enroll or continue button. Links in the outline come from lessons read as the viewer, so only lessons they can open are links |
| `lms-lessons` | The course outline in a sidebar with completed lessons ticked, the content, "Mark complete", and next and previous links. Read as the member when only they may open it (C9), and missing for everyone else |
| `lms-my-courses` (singleton, `/my-courses`) | The learner's courses and progress, from `/api/ext/lms/me/courses`, which counts every lesson where a template query would stop at 200 |
| `lms-certificate` (singleton, `/certificates`) | Looks up `?code=` and shows the result |

## 11. Milestones

| # | Work | Done when |
|---|---|---|
| L0 | Core C4, with tests that a plugin can write only the user fields it declared | Done on 2026-11-11: a plugin reaches only fields named with its prefix |
| L1 | Package, migration 001 (collections, view, user field, rules, blocks), contract check | Done on 2026-11-11, on SQLite and Postgres |
| L2 | Enrollment: hooks keeping `lms_courses` in sync, free enroll route, staff bulk enroll | Done on 2026-11-11 |
| L3 | Progress and completion, `me/courses` | Done on 2026-11-11 |
| L4 | Quizzes: answer-free read route, grading, attempt limits | Done on 2026-11-11 |
| L5 | Certificates and the verification page | Done on 2026-11-11 |
| L6 | Templates and dashboard pages, with core C9 for lesson pages | Done on 2026-11-11 |
| L7 | Selling through Payments (§8), after Payments' P4 | Buying a course enrolls the buyer, and a refund revokes the enrollment |
| L8 | Courses in plans (§8.1), Payments' P7 | A subscriber enrolls in a course their plan covers with no purchase, loses its lessons when the subscription ends, and gets them back with their progress when they subscribe again. Done on 2026-11-17 |

## 12. Security tests

All of these are in `tests/integration/lms.test.ts`, which also checks that the site's lesson page is never served from a shared cache and that unenrolled staff get the 404 a visitor does. Unit tests are in `tests/unit/lms-plugin.test.ts`.


- A visitor and a non-enrolled user can't read a non-preview lesson through list, view, expand on a course, realtime, `/api/resolve`, or a file inside a lesson block.
- Revoking an enrollment ends access on the next request, and on an open realtime subscription within the 2 seconds after which realtime resolves its subscriber again.
- A learner can't write enrollments, progress, attempts or certificates through the records API or batch.
- A learner can't complete a lesson of a course they aren't enrolled in.
- Quiz `correct` values aren't returned by any route, expand or realtime event to anyone without `record:read`.
- Attempt limits hold under parallel submissions.
- Certificate codes can't be enumerated: they're random, and the verify route is rate limited.
- A learner can't set their own `lms_courses` through the account API.

## 13. Open questions

- Should a completed course stay readable after its enrollment is revoked? Built as recommended: no, revoking ends access. Certificates stay valid.
- Video hosting: the first version uses core file storage, which has no streaming or DRM. Built as recommended, with YouTube and Vimeo for bigger videos.
