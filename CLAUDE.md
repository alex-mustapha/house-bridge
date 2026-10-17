# house-bridge — project context for Claude

Cloudflare Worker that bridges **Linear** (chore definitions) and **Discord** (day-to-day control)
for a two-person household chore system (Alex + Kristal).

- Repo: `github.com/alex-mustapha/house-bridge`
- Local: `E:\projects\linear-discord-bridge`
- Live: `https://linear-discord-bridge.muffinfactory.workers.dev`
- See `README.md`, `FEATURES.md`, `SETUP.md` for the full picture. This file captures the
  non-obvious operational knowledge that isn't in those.

## Interaction model (design intent — honor this)
Two control surfaces, deliberately split:
- **Linear templates** (the Recurring project) define **permanent, repeating** chores via
  labels/directives: cadence, weekday, month, day-of-month, `start:`/`end:`, `count:`,
  `estimate:`, `silent`, `paused`, `opposite:`, `every: Nd|Nw|Nm`.
- **`/chores` Discord slash command** is for **one-off / transient** changes:
  `pause`/`resume` (scoped), `done`, `claim`, `unclaim`, `snooze`, `skip`, `add`, `pauses`,
  `weight`, `calendar`, `sync`, `help`. Discord is the user's preferred primary interface for
  everything except templating.

**New one-off scheduling features → add as `/chores` subcommands, NOT new endpoints/labels.**

Pause semantics:
- `/chores pause chore:<name>` toggles the **`paused` label** on the matching Recurring
  template(s) — source of truth for taking a chore off-radar. Adds a dated audit comment AND
  retracts already-generated future copies (reconcile).
- `/chores pause user:<name>` and `/chores pause everyone:true` are **D1 holds** with date
  windows (open-ended = until resume). **Guardrail:** no `user:` and no `everyone:true` →
  refuse (a global pause archives the whole window; never do it by accident).
- **User pause = "other person covers": reassign in place** (`coverUserPause`), NOT
  delete/recreate. Global pause archives the window + spawns Vacation Prep. Resume rebalances.
- Monthly-or-rarer chores skipped during a global pause get a **catch-up** make-up on resume /
  auto-expiry (`createCatchups`, `processExpiredPauses`).
- Holds are **soft-cleared** (status + cleared_at) so history is queryable via `/chores pauses`.

Assignment (rotation-first — changed Aug 2026):
- **Per-title alternation is the primary rule**: whoever did a chore last doesn't get it next
  occurrence. Effort/weight load balancing survives but is a **tiebreak only**, used when a title
  has no history. Don't "fix" the resulting uneven weighted minutes — that's intended.
- The last-owner map (`liveLast`) is seeded from the **latest due date** among materialized copies
  (falling back to creation-order history) and **updated as the plan is assigned**. That last part
  matters: reading a pre-run snapshot for every day of a bulk fill was the original bug — the same
  person got a chore for weeks straight.
- **Sweep debt:** when the Monday sweep archives a past-due `replace` chore, the next instance is
  forced back to whoever let it slip (`sweptOwner` → `debtTarget` in `runWeek`), overriding the
  rotation turn for that one occurrence. Without it, missing a chore rotated it away from you and
  onto the other person. Two paths matter — the next instance may be created by that same run
  (handled in the assignment loop) or already materialized (reassigned after the archives), and
  with a 14-day horizon it's usually the latter, so don't drop that branch.
- Pin a chore to one person with an explicit **assignee on the template**; there's no `sticky`
  directive and we don't want one. To pin only *some* weekdays, use
  **`assign: monday=Kristal, friday=Alex`** — unlisted weekdays still rotate.
- **Pinning is decided across ALL templates sharing a title**, not the one a `byTitle` map
  happens to keep. A per-weekday split can also be expressed as several same-title templates,
  and `reshuffleWindow`/`rebalanceWindow` would otherwise reassign hand-managed chores depending
  on map ordering. Keep using `pinnedTitles` (assignee || opposite || assignDays) for that check.

Leisure log (private to one person):
- `/chores leisure` is Alex's personal habit tracker, deliberately **not** a household metric.
  Keep it that way: the slash reply is EPHEMERAL, and the dashboard panel renders only when
  `/dashboard?user=<name>` is passed. The shared pinned link has no `user`, and the rendered
  shared page must contain **no trace** of it (the whole script block is omitted, not just
  hidden) — there's a render test for this in the scratchpad approach: grep the shared HTML for
  "leisure" and expect zero hits.
- "Clear" = today's chores done. Older past-due items are counted separately on purpose, so a
  months-old ad-hoc can't make a clear slate unreachable forever.
- `leisure_log.source` is open ("self" now) so a presence/console writer can fill the same table
  later without a schema or dashboard change. Discord presence would cover PC/Xbox/PlayStation
  but not Switch, and needs an always-on process a Worker can't hold.

Done vs cancelled:
- A chore can be resolved two ways: **done** (work happened) or **canceled** (decided not to).
  Surfaces: the digest's second "Not doing it…" dropdown, the widget's ✖, and `/chores cancel`.
- `statusOf` returns `canceled` as its own outcome. It is **excluded from the completion ratio**
  (neither credit nor failure) but counted and displayed, so a rising cancel count can't pass for
  a rising completion rate. Don't fold it into done or missed.
- `fetchChoreHistory` must keep selecting `state { type }` and must NOT filter out canceled —
  it used to, which would have made cancelled work vanish from stats entirely.
- The digest has TWO select rows now (`actions-menu`, `cancel-menu`). Resolving a chore prunes it
  from both, keyed by issue id — not by option value, since one issue appears in both rows.

Widget page (`src/widgetpage.js`):
- The whole page is a **JS template literal**, so any backslash meant for the browser must be
  written **doubled**. A single `\s` or `\n` is consumed when the page is built, and the served
  regex ends up unterminated — that's a SyntaxError in the only inline script, so the entire
  page renders blank. It fails silently: the endpoint still returns 200 with full-looking HTML.
  Applies to comments as well as code.
- Verify by rendering and PARSING the output, not by eyeballing the source:
  extract `<script>` from `renderWidgetPage(...)` and run `node --check` on it. A syntax check of
  `widgetpage.js` itself passes regardless, since the broken code is inside a string.

`weekdays-only` (template label, monthly family):
- Moves a weekend landing to the nearest weekday — **Sat back to Fri, Sun forward to Mon** — and
  **never crosses out of the month**, because `isDueToday` is asked about one day at a time, so a
  date pushed into the next month silently skips that cycle. `first` on a Saturday therefore goes
  forward and `last` on a Sunday goes back.
- Applies to **monthly / bimonthly / semi-annually / annually** only — it works by adjusting
  `targetDayOfMonth`, which is the only thing `onTargetDay` consults. `semi-monthly` computes its
  own days and the weekly family is already pinned by weekday labels.
- Added for the investment chores (`middle` = the 15th, which lands on a weekend ~2 months in 7):
  trades need a day the market is open. Accepted spellings: `weekdays-only`, `weekdaysonly`,
  `weekday`, `businessday`.

**Scheduling fields live in TWO parallel construction sites.** `buildDefs` (what actually
generates) and `summarizeTemplate` (what `/describe` reports) each build their own chore object
from the same `parseLabelConfig` output. Add a field to one and not the other and generation is
right while the diagnostic lies — `weekdays-only` shipped exactly that way for one deploy:
`/describe` kept reporting plain 15ths, including a Sunday, while generation was already correct.
When adding any scheduling directive, grep for the field name and expect **two** assignment sites
plus the `describeBase` summary text.

Markers that protect manual intent (labels on the generated chore, not the template):
- **`snoozed`** — set by `/chores snooze`. A snoozed chore sits on a date its template never
  generates, which is indistinguishable from a stale copy left by a schedule change, so the
  reconcile pass would archive it. Generation runs DAILY now, so without this a snooze was
  usually destroyed within 24h. Reconcile skips anything carrying it.
- **`claimed`** — set by every claim path (digest dropdown, `/chores claim`, widget `/claim`).
  Exempts the chore from automatic rebalancing, notably the `opposite:` re-split: taking on both
  halves of a pair is a legitimate choice and must stick.
- `opposite:` is re-checked on every run, not just at generation — the pairing is decided once at
  creation and anything moving either side afterwards used to break it silently.

Weekly recap:
- Covers the **finished week ending yesterday**, not a window including today — every day is
  final, so "not completed" unambiguously means missed. It stays **weekly**, unconditionally —
  not "only when something changed".
- `fetchChoreHistory` must keep **`includeArchived: true`**. The Monday cron sweeps last week's
  unfinished chores (step 1) *before* the recap posts (step 4); excluding archived meant the
  recap couldn't see the misses that had just been swept and under-reported badly.
- **Leads with on-time %, not completion %.** Completion sat near the same value every week
  (missed weekly chores get swept, rarer ones stay open), so the headline number never moved.
  Don't promote completion % back to the headline.
- `computeStats` must branch on `state.type === "canceled"` **before** the `completedAt` check.
  A cancelled chore has no `completedAt`, so it used to fall through and be tallied as *missed* —
  deflating the ratio and listing deliberately-cancelled chores under "what slipped".
- Lateness carries **magnitude** (avg days late + worst offender by name); "5 late" hid the
  difference between one day and eighteen.
- The per-person block **collapses to one line** when the two are within 10 points, and a week
  with nothing scoreable reads as a quiet week (purple) rather than a red-band disaster.
- **Never put leisure data in the recap** — it's one person's private tracker.

Streaks — ONE definition, in `src/streak.js`:
- There used to be three independent implementations (widget `computeStreak`, recap `streakFor`,
  dashboard `queryDashboard`) and they reported **three different numbers for the same person on
  the same day** (0 / 0 / 5). They disagreed on the window (60/30/41 days), on whether today
  counted, and — the one that actually caused it — on whether a **cancelled** chore breaks a run.
  All three now call `choreStreak`. **Don't re-fork it.**
- The definition: a day counts when you had chores due and **resolved all of them — done OR
  cancelled**. Cancelling is a legitimate outcome (`statusOf` already keeps it out of the
  completion ratio), so it must not break a run either. Chore-free days are **bridged**. **Today
  is excluded** — a streak is a record of finished days.
- Sharing the definition is **not sufficient**: the data feeding it must match too.
  `fetchAssignedDueInWindow` (streak-only) had a `neq: "canceled"` query filter and no
  `includeArchived`, so cancelled and swept rows never reached the helper and whole days looked
  chore-free. Both removed. If a surface's number drifts again, suspect its **query** first.
- Wording is shared on purpose: **"N clear days"** plus `STREAK_FOOTNOTE`. "N-day streak"
  overclaimed calendar days; "N chore-days clear" was jargon.
- The **leisure** streak (`db.js` `queryLeisure`) is a deliberately separate metric — consecutive
  *logged* days that started clear. Don't fold it into `choreStreak`.
- `/status` responses can be **edge-cached**; cache-bust before concluding a number is wrong.

Missed chores:
- **The default is cadence-derived (`defaultOnMiss`), not a constant.** Only weekly-or-more-
  frequent chores (`daily`, `weekly`, `every: N` ≤ 7d) default to `replace` and get swept;
  everything rarer defaults to **`skip`** and is left standing as overdue until completed.
  Changed 2026-09-08 — the old blanket `"replace"` default meant a missed annual chore was
  archived unfinished and didn't return for a year. Don't reintroduce a hardcoded default:
  `buildDefs` and the sweep both call `defaultOnMiss`.
- An explicit `skip`/`replace`/`always` label overrides the default. `/describe` reports
  `onMissSource` so you can tell which applied.
- **Archiving ≠ completing** — a swept chore vanishes unfinished. `/chores sync` and every other
  non-cron `runWeek` caller passes `skipCleanup: true`, so only the cron and `/run-week` sweep.
- **`runWeek` runs DAILY** (changed 2026-09-08), not Mondays only. That's safe *only* because the
  sweep now has an explicit **`SWEEP_GRACE_DAYS`** (default 7) threshold — the old
  `dueDate < today` test relied on running weekly to give any grace at all, and running that
  daily would archive everything one day late. Never reintroduce a daily sweep without the grace
  check. The threshold also fixed the old weekday asymmetry (Sunday chores got ~1 day, Monday
  chores 7); now every chore gets the same window.
- Chores with **no matching template** (ad-hoc/one-off) are never swept and never pruned — they
  linger indefinitely.
- The digest's **⏰ Past due** section is the pressure valve: chores may slip, but slipping must
  stay visible daily rather than being discovered by absence.

Long horizon + reconciliation:
- Generation materializes `GEN_HORIZON_DAYS` (14) ahead, capped at `GEN_MAX_CREATES` (40) per
  run (subrequest limit); dedup makes it a one-time fill. So changes must reconcile the existing
  window, not wait for next week: template edits (webhook → `runWeek`), `paused` label
  add/remove, and `/chores weight` (`rebalanceWindow`) all update materialized chores in place.
  Reconcile only touches future, not-yet-started chores. **Deleted-template orphans are NOT
  pruned** (deprioritized).
- Dates in `/chores pause` etc. are strict `YYYY-MM-DD` (a typo like `2026-07014` is rejected).

Discord interaction deadlines (three different budgets — don't conflate them):
- **Slash commands (type 2): 3s to ack, 15min to answer.** Use `deferAndRun` (returns type 5
  immediately, does the work in `waitUntil`, then PATCHes `messages/@original`). Anything doing
  Linear round-trips must go through it.
- **Component clicks (type 3): same 3s.** Handled by acking with type 6 and rewriting the message
  from the background pass.
- **Autocomplete (type 4): 3s, and it CANNOT BE DEFERRED** — there is no type-5 equivalent, so
  whatever the handler does must finish inside the budget. It also fires **once per keystroke**.
  Treat every autocomplete branch as a hard latency budget: at most one small Linear query,
  memoised. The `needswork` branch used to do two uncached sequential queries per keystroke (one
  of them 250 nodes with `includeArchived`) and timed out in real use; it now uses
  `fetchRecentCompleted` behind a 20s memo (`recentCompletedTitles`), measured ~100-230ms.
- A timeout here does **not** mean the work didn't happen. Twice now the Linear/D1 write landed and
  only the acknowledgement was lost — check `chore_detail_log` / Linear before assuming failure.
- `getTeamId` is **cached per isolate** (`teamIdCache`). It used to re-query on every call.

Linear query pagination:
- **`first: 250` is not "all".** For this team 250 issues only reaches back ~66 days, so
  `fetchChoreHistory`'s 120-day callers were silently getting ~66 days. Linear can't `orderBy`
  issues by `completedAt`, so there's no safe way to choose which 250 — `fetchChoreHistory` now
  pages through with a cursor (`maxPages` default 5, warns if it hits the bound). Any new
  bulk query needs the same treatment.
- Truncation here is silent and plausible-looking: it understated `marks.js` slip streaks and could
  make a "who last completed this" lookup return nothing for an infrequent chore.

Diagnostics:
- **`[observability]` is on** (`wrangler.toml`), so request logs are retained and queryable. Before
  that, `wrangler tail` was live-only and a failure from the previous day had to be reconstructed
  from D1.
- **`/recent-done?key=`** shows exactly what the `needswork` picker would offer plus its in-Worker
  timing — that path can't otherwise be exercised without signing a Discord interaction.

## Gotchas
- **Deploy → commit → push, same turn.** After every `npm run deploy`, immediately
  `git add -A && git commit && git push`. The repo must match what's deployed (a future GH
  Action will make push-to-deploy the trigger).
- **node/npm aren't on PATH in fresh shells here.** Prepend:
  `$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")`
  before npm/wrangler. Git remote is SSH globally (`insteadOf` rewrite) — pushes need no auth prompt.
- **After editing slash commands** (`src/commands.js`), re-register by hitting
  **`/register-commands?key=<CRON_KEY>`** (uses the bot token already in Cloudflare, derives app
  id, auto-detects guild). `scripts/register-commands.js` is the local fallback.
- **Worker secrets are write-only** — you can't read `DISCORD_BOT_TOKEN` back out of wrangler.
  Slash-command mutations are safe without a secret (Ed25519-verified + guild-gated), unlike the
  keyed HTTP toolkit endpoints.
- **`LINEAR_API_KEY` is a dedicated bot user** (display name "muffin" / Chore Bot), not Alex's
  personal key. Linear forbids editing a comment authored by a *different* user
  ("Cannot modify Comment"), so code that refreshes comments (`annotateTemplates`, pause-cycle
  comments) must look up the viewer (`getViewerId`) and edit only its own comments, creating a
  fresh one otherwise.
- **Match identity by Linear user id, never name strings.** `name` and `displayName` diverge:
  - Alex: name `Alex`, displayName `kalinowski89`, id `04d81d50-eadf-42f8-81a2-c2a6fdb54f3e` (Discord OddRanger maps here)
  - Kristal: name `Kristal`, displayName `kristalwhelan1`, id `46625b52-b6c9-4593-b2a9-177844f2cb13`
  - muffin (bot): id `34acd77e-416d-4e50-97c7-4cb3c96f040c`
  Ownership checks compare ids (`resolveCaller id === issue.assignee.id`). For friendly Discord
  display, prefer `name` over `displayName`.
