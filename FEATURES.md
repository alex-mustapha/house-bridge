# Features

The **linear-discord-bridge** is a single Cloudflare Worker that turns a Linear
workspace into a shared household chore system, with Discord as the day-to-day
interface and personal calendars as a passive view. Everything runs on free
tiers (Cloudflare Workers + D1, Linear free, Discord).

- **Linear** holds the data: recurring-chore *templates* (definitions) and the
  actual *chores* (in the House Chores project) plus one-off tasks (Ad Hoc).
- **The Worker** generates chores, posts to Discord, serves slash commands,
  reconciles changes, serves calendar feeds + a stats dashboard, and runs
  maintenance — daily on a cron plus on demand.
- **Discord** is how you interact: a daily digest with an actions dropdown, and
  the `/chores` command for one-off changes.
- **Calendars** (iOS/Google via ICS subscription) show upcoming chores passively.
- **D1** stores long-term analytics, pause history, and rotation-weight overrides.

---

## How it runs

Two entry points in one Worker:

- **`fetch()`** — receives Linear webhooks (real-time events), Discord
  interactions (slash commands + menus), calendar/status/dashboard pages, and the
  keyed toolkit endpoints.
- **`scheduled()`** — the daily cron (`0 12 * * *` UTC = 8am EDT / 7am EST).
  Every day: settle expired pauses → **generate + reconcile the window** →
  digest → cap check → auto-archive. **Mondays** add the weekly recap
  (scoreboard → D1 snapshot). **Sundays** refresh template schedule comments.
  Generation runs **daily**, not weekly, so the horizon truly rolls (it used to
  shrink to ~8 days by Sunday), pause expiries and template edits settle within
  a day, and a swept chore is handed back to whoever dropped it the next
  morning. It's idempotent — dedup by team+title+due date means extra runs only
  fill gaps.

All dates — "today", weekday, day-of-month, due dates, streaks — are computed in
**America/New_York** via `Intl.DateTimeFormat`, so they reflect the household's
real calendar day regardless of the UTC cron, and it's DST-safe. (The cron *hour*
is UTC and doesn't shift for DST — see the note in `wrangler.toml`.)

---

## Real-time activity mirror

The Worker mirrors **meaningful** Linear issue changes to Discord as they happen
(via webhooks), deliberately kept quiet:

- **Issue events** — created / completed / canceled / removed, and updates that
  change a **surfaced field** (title, status, assignee, priority, due date) — post
  a color/emoji-coded embed.
- **Comments are never echoed**, and **description-only edits are skipped** — so
  ticking a checklist box, or the bot's own schedule comments, don't spam the
  channel. (Linear's webhook `updatedFrom` tells us which fields changed.)
- **Archive sweeps don't spam the channel.** Archiving fires one Linear
  `remove` webhook per issue, so a 30-issue sweep would post 30 tombstones for
  work finished days ago. Those events are dropped for the chore projects and
  the archiver posts a **single summary** instead ("🗄️ Tidied up 30 finished
  chores…"). Removals in other projects still post; set
  `MIRROR_CHORE_REMOVALS="true"` to get the per-issue ones back.
- **Recurring templates are excluded** from the mirror; any chore labeled
  **`silent`** is skipped too.
- **Per-team routing:** events post to `DISCORD_WEBHOOK_<TEAMKEY>` (e.g.
  `DISCORD_WEBHOOK_CHO`) if set, else `DISCORD_WEBHOOK_DEFAULT`.

Editing a **Recurring template** in Linear (a day/cadence change, or toggling the
`paused` label) doesn't post, but **triggers an immediate reconcile** of the
materialized window (see *Reconciliation*).

---

## Recurring chores (templates)

Recurring chores are defined as **template tickets** in the **Recurring** Linear
project. They're definitions, not chores to do — they stay in Backlog. The Worker
reads them and generates actual chores into **House Chores** (assigned, due-dated,
checklists copied). A 🔁 Schedule comment on each template shows its cadence,
active window, effort, and next dates.

### Labels

| Label | Purpose |
|---|---|
| **frequency** (one) | `daily` `weekly` `biweekly` `triweekly` `semi-monthly` `monthly` `bimonthly` `semi-annually` `annually`. *(Optional if you use the `every:` directive.)* |
| **weekday** (any) | `monday`…`sunday` for weekly-family cadences. **Omit** to make it an "any day" chore (due Sunday, or N/week via `count:`). |
| **month** (any) | `january`…`december`. Limits a chore to those months **every year** (all cadences — e.g. a weekly mow chore only May–Sep). For monthly-family cadences it also picks which month(s) the cycle lands on. |
| **day-of-month** | `first` / `middle` / `last` → 1st / 15th / last day (monthly-family). |
| **on-miss** | Overrides the cadence-derived default (below). `replace` — the overdue copy is **archived** by the Monday sweep and superseded next cycle. `skip` — never swept: it **survives until completed**, and each recurrence still generates. |
| **paused** | Takes this one chore off-radar until removed (source of truth for seasonal pausing). Toggle from Discord with `/chores pause chore:` / `resume chore:`. Adding it also **retracts** already-generated future copies. |
| **silent** | Generate the chore without posting it to Discord. |
| any **room** label | Copied onto the spawned chore (e.g. `kitchen`). |

### Description directives

Parsed from the template description, then stripped from the spawned copy.

| Directive | Meaning |
|---|---|
| `start: 2026-06-27` | First eligible date; also **anchors** every-N-weeks / every-N-months / `every:` cycles. |
| `end: 2026-10-31` | Last eligible date; stops recurring after it. |
| `every: N[d\|w\|m]` | **Rolling interval** from `start:` (required): `d`=days (default), `w`=weeks, `m`=calendar months. e.g. `every: 3d`, `every: 2w`, `every: 3m`. No frequency label needed. |
| `count: 3` | "Any day" chore (weekly-family, no weekday label): times per week, auto-spread. Default 1 (due Sunday). |
| `estimate: 30m` | **Time** (`30m`, `1h30m`, …). Unestimated chores default to 15 min. |
| `effort: 1..5` | **Difficulty** (1 easiest, 5 hardest, default 3 = neutral). Multiplies the time-based balance cost (`0.5×`…`2×`), so a long-but-easy chore counts less and a short-but-hard one more. |
| `week: even`/`odd` (biweekly) or `0`/`1`/`2` (triweekly) | Which cycle. |
| `dueafter: 2` | Due N days out instead of today. |
| `opposite: Cook Dinner` | Assign the *other* person from that chore's owner on the same day. |
| `assign: monday=Kristal, friday=Alex` | **Per-weekday fixed owner.** Splits one chore across people by day, so a single template can cover "Kristal cooks Mon/Wed, Alex cooks Fri" without duplicating it. Weekdays you don't list fall through to normal rotation, so `assign: friday=Alex` pins only Fridays. A template-level **assignee** pins *every* occurrence and wins outright. Names match loosely, same as elsewhere. |

Anything else in the description (e.g. a `- [ ]` checklist) is copied onto each
spawned chore.

---

## Generation & assignment

- **Horizon:** the Worker materializes chores up to **`GEN_HORIZON_DAYS`** ahead
  (default **14**). A larger horizon is a **one-time fill** — because generation
  dedups by `(team, title, due date)`, later runs only create the new far days.
- **One-time fill safety:** each run creates at most **`GEN_MAX_CREATES`**
  (default 40) chores to stay under the Worker's 50-subrequest limit. A big
  initial fill reports "N still to create — run `/chores sync` again to finish";
  normal weekly runs never hit it.
- **Assignment is rotation-first.** Each chore **title alternates owner every
  occurrence** — whoever did it last doesn't get it next time. This is the
  primary rule, so no one gets the same chore two cycles running, and it holds
  across a whole horizon fill (the last-owner state updates as the window is
  planned, not just from a pre-run snapshot).
- **Load balancing is a tiebreak only.** Effort-adjusted time
  (`cost = estimate × effortMultiplier(effort)`, compared as `cost / weight`)
  now decides only titles with **no rotation history** — a brand-new chore.
  Member weights still come from `ROTATION_WEIGHTS` (default
  `Alex:60,Kristal:40`) with overrides via `/chores weight`. *Consequence:*
  strict alternation can leave weighted minutes uneven; that's the intended
  trade — predictable turns beat a balanced ledger.
- If the person whose turn it is is **paused** that day, the other covers, and
  the turn passes normally on the next occurrence.
- **You keep what you drop.** When a chore is swept for going past due (the
  `replace` policy), the **next instance goes back to whoever let it slip**,
  overriding the rotation turn — otherwise missing a chore *rotated it away*
  from you and handed it to the other person. It applies to exactly one
  occurrence; after that normal alternation resumes. Works whether the next
  instance is generated by that same run or was already materialized (with a
  two-week horizon it usually already exists). Skipped if the debt owner is
  paused that day — a cover shouldn't inherit someone else's debt — and not
  tracked at all for pinned, `assign:` or `opposite:` chores, whose owner is
  already decided.
- Put an explicit **assignee** on a template to **pin** that chore to one person
  (it then never rotates) — the supported way to make a chore "sticky".
- Use **`assign:`** to pin *particular weekdays* to particular people while
  leaving the rest rotating. Any title that's hand-managed this way (template
  assignee, `assign:`, or `opposite:`) is skipped by `/chores reshuffle` and
  `/chores weight`, so manual arrangements are never reshuffled away.
- `opposite:` pairs still assign the other person from the paired chore.
- **Miss policy — defaults from the cadence.** A missed chore is only wiped if it
  comes round **weekly or more often** (`daily`, `weekly`, or `every: N` with a
  period ≤ 7 days); the next one is close enough that archiving the overdue copy
  loses nothing. **Everything rarer defaults to `skip`** — biweekly, monthly,
  annual and the rest are **left standing as overdue until actually completed**,
  because forgiving them means skipping a whole cycle.
- **Grace window:** a `replace` chore is only swept once it's **`SWEEP_GRACE_DAYS`
  (default 7) days past due**, so everything gets the same week to slip
  regardless of which weekday it falls on. (Before, the sweep ran Mondays only
  and tested "past due at all", so a Sunday chore got ~1 day and a Monday chore
  got 7.) Set `"0"` to sweep as soon as something is overdue.
- `/chores sync` skips the sweep entirely, so a manual run never archives a
  not-yet-done chore.
- An explicit **`skip`** / **`replace`** label on a template always wins, so any
  single chore can opt out either way. `/describe` reports `onMissSource` —
  `label` or `default (cadence)` — so you can see which applied.
  > ⚠️ Archiving is **not** completing. A `replace` chore still open and past due
  > is archived *unfinished*: it leaves active views with no record in Discord.
  > (The weekly recap does count it — it reads archived issues deliberately.)
  > If a frequent chore must nonetheless survive being missed, label it `skip`.

---

## Reconciliation (keeps the materialized window honest)

With a long horizon you can't wait for "next week" to fix the schedule, so
changes reconcile the already-generated chores — usually **immediately**:

| Change | Effect on existing chores | When |
|---|---|---|
| Template **day/cadence** edit | archive the stale day + create the new one | Linear webhook (instant) · Monday · `/chores sync` |
| **`paused` label** added | archive its future not-yet-started copies | webhook · Monday · sync |
| **`paused` label** removed | regenerate its upcoming copies | `/chores resume chore:` · webhook · Monday |
| **Global pause** | archive the window's chores + spawn Vacation Prep | `/chores pause everyone:true` (instant) |
| **User pause** | **reassign** that person's chores to the other, in place | `/chores pause user:` (instant) |
| **Resume** | clear the hold, make catch-ups, refill, rebalance | `/chores resume` (instant) |
| **Weight change** | reassign future rotating chores to match the new split | `/chores weight` (instant) |
| Template **deletion** | *(not reconciled — orphans linger; no prune)* | — |

Reconciliation only ever touches **future, not-yet-started** chores; past-due and
in-progress ones are left alone. Reassignments/rebalances are in place (no
delete/recreate), capped at `GEN_MAX_CREATES` per run.

---

## Catch-up chores (rare chores survive a pause)

A pause normally *forgives* skipped chores. But anything **monthly or rarer**
(`monthly`, `bimonthly`, `semi-annually`, `annually`, and any `every: Nm`) that
had ≥1 occurrence inside a **global** pause window owes **one** make-up when you
return — you shouldn't lose the once-a-month maintenance over a vacation.

- Fires on **`/chores resume`** and on the **Monday cron** for dated pauses that
  expired on their own.
- One make-up per chore (not one per skipped day), idempotent, due the return day.
- Assigned to the template's **fixed owner** if it has one, else **unassigned &
  claimable**. Marked "🧺 Catch-up after the … pause".
- Daily/weekly/biweekly/triweekly/semi-monthly chores are **forgiven** (no make-up).

---

## Pausing — two mechanisms

| | Per-chore (seasonal) | Global / per-person (transient) |
|---|---|---|
| **Trigger** | `/chores pause chore:<name>` | `/chores pause everyone:true` / `/chores pause user:<name>` |
| **Stored as** | the `paused` **label** on the template | a **D1 row** (with date window) |
| **Duration** | indefinite (until removed) | `from:`/`to:` window, or open-ended |
| **Cleared by** | `/chores resume chore:` | `/chores resume` (± `user:`) |
| **History** | one comment per pause→resume cycle | soft-cleared D1 rows, shown by `/chores pauses` |

- **Guardrail:** a pause with no `user:` **refuses** unless you pass
  **`everyone:true`** — a global pause archives *every* chore in the window, so it
  can't be triggered by accident (e.g. forgetting `user:`).
- **Global** pause archives the window and spawns the **Vacation Prep** checklist
  (`VACATION_PREP_TITLE`, unassigned, due the pause start).
- **User** pause = "the other person covers": the paused person's in-window chores
  are **reassigned in place** to the other, and future generation drops them from
  rotation. On resume the window is **rebalanced** to fold them back in.
- A global vacation pause/resume **does not** touch a `paused` label, so seasonal
  chores survive a vacation cycle.
- **Dates are strict `YYYY-MM-DD`** — a malformed `from:`/`to:` is rejected.

---

## Discord slash commands

Autocomplete suggests real chores/people as you type. Run `/chores help` in
Discord for the in-channel version. **After editing commands, re-register** (hit
`/register-commands?key=<CRON_KEY>`).

**View**
```
/tasks [user:<name>]            your (or someone's) open chores
/project project:<name>         open issues in a project
/unassigned                     open chores with no assignee
```

**Pause / resume**
```
/chores pause everyone:true [from: to:]   pause the whole household (vacation)
/chores pause user:<name> [from: to:]     opt one person out (other covers)
/chores pause chore:<name>                take one chore off-radar (paused label)
/chores resume [user:|chore:]             clear holds / un-pause a chore
```

**Day-to-day**
```
/chores done chore:<name>                 mark a chore done
/chores claim chore:<name> [assignee:]    take ownership (default: you)
/chores unclaim chore:<name>              drop one of your chores to unassigned
/chores snooze chore:<name> [days:N]      push a due date out (default 1)
/chores skip chore:<name>                 skip the current copy (returns next cycle)
/chores add title:<…> [due:] [assignee:]  add a one-off chore (→ Ad Hoc, no due date by default)
```

**Info & tuning**
```
/chores pauses                            what's currently paused (+ history)
/chores weight [user: value: reset:]      view/skew the rotation load (rebalances the window)
/chores calendar                          calendar-subscription links
/chores sync                              re-run generation now (idempotent; fills the horizon)
/chores help                              the command reference
```

`done` / `claim` / `unclaim` / `snooze` / `skip` search both **House Chores** and
**Ad Hoc**. `claim` autocomplete lists only unassigned chores; `unclaim` lists
only your own. Ownership is matched by Linear **user id**, not name.

---

## Daily digest & actions dropdown

- The daily cron posts the chore digest to the due channel as **one block per
  person**, each with up to three parts:
  - **⏰ Past due** — oldest first, with days late.
  - **📅 Today** — what's due now.
  - **🔜 Upcoming** — what's coming for them, dated, to the **end of the
    current calendar week** (Mon–Sun). Monday shows Mon–Sun, Friday shows
    Fri–Sun, Sunday shows only Sunday. A rolling 7-day window put next
    Monday's chores in front of you on the quietest day of the week and
    blurred where one week ended and the next began. `WEEK_LOOKAHEAD_DAYS`
    is a ceiling on this, not the window itself.
  An *Unassigned* block carries the same structure; its upcoming list is
  labelled **"up for grabs"** so spare-time work is visible.
- **Warning marks on chore lines.** Both are derived, so there's nothing to add
  at generation time and nothing to clean up:
  - **⚠️ slipped last time** / **🔴 slipped N×** — the previous occurrence(s)
    went unfinished. Independent of the on-miss policy: a `replace` chore's
    missed copy was archived and a `skip` chore's is still open, but either way
    it's being put off. Escalates on repeats, because one slip is normal and
    two in a row is the actual problem. **Canceled doesn't count** — deciding
    not to do something is a choice, and treating it as a slip would punish
    using ✖ honestly.
  - **🔍 check the checklist** — someone noticed the last pass left a detail
    out. Raised with `/chores needswork chore:<name> [note:]`, which looks up
    who last *completed* that chore and aims the reminder at them. **The chore
    stays done** — nothing reopens. It shows only on that person's next
    occurrence (if the chore rotates away, the other person sees nothing) and
    clears when **they** complete it again; their partner doing it doesn't
    discharge it. Only the soonest matching occurrence carries it.
- **🧺 Anytime** — the two oldest **undated** open issues, with project, owner
  and age. Every other list in the system is keyed on a due date, so undated
  work is otherwise invisible until someone goes looking in Linear. Ranked by
  age alone: no priority field to hand-maintain. Appears in the digest and the
  widget; Recurring templates and backlog items are excluded.
- **Routine chores are filtered out of Upcoming.** Anything recurring as often
  as `PREVIEW_HIDE_CADENCES` (default `daily,weekly`) is hidden from the
  forward view — previewing *Cook Dinner* for Wed/Fri/Mon tells you nothing and
  buries the rest. What's left is what you'd otherwise forget: **ad-hoc tasks,
  project work, and chores that come round every few months.** Add `biweekly`
  to also hide every-other-week chores. Today and past due are never filtered.
  > This threshold is deliberately **separate** from the on-miss cadence rule,
  > so quieting the preview doesn't change what the sweep archives.
- **⏰ Past due** is its own section at the top, oldest first, showing how many
  days late each chore is and who owns it. Chores are allowed to slip — the
  point is that slipping stays *visible daily*, instead of being noticed only
  when the Monday sweep makes it vanish. @-mention counts include past-due work,
  so a day with nothing new still pings whoever's carrying something.
- When `DISCORD_BOT_TOKEN` + `DISCORD_DUE_CHANNEL_ID` are set, the digest is posted
  **by the bot** with a single **actions dropdown** (multi-select, up to 25): pick
  "✓ &lt;chore&gt;" to mark an assigned chore done, or "🙋 &lt;chore&gt;" to claim an
  unassigned one. Falls back to a plain webhook digest (no menu) otherwise.
- A second dropdown, **"Not doing it…"**, cancels a chore instead: it clears off the
  list but is recorded as **canceled**, not done. Separate menu rather than extra rows
  in the first one — a select caps at 25 options and a busy day would overflow.
- **Three dropdowns, one job each:** **✅ Mark done…**, **🙋 Claim a chore…**, **❌ Not doing it…**. All claiming lives in the middle row —
  unclaimed work *and* chores currently assigned to someone — so picking
  something up is always in the same place rather than depending on whether
  anyone happened to own it. A select's options are fixed when the message
  posts, so one list serves both people; the handler assigns to whoever
  clicked. Rows appear independently, so a day of only unassigned work still
  gets a claim row. Claiming only **assigns** — it never completes anything. It does add a
  `✓` entry to **Mark done** on the same message, so the chore can be ticked
  off later without waiting for tomorrow's digest.
- **Claiming always announces in the due channel**, wherever it happened —
  digest dropdown, `/chores claim` in any channel, or the widget's 🙋. Taking
  someone's chore @-mentions them (`🙋 **Kristal** claimed **X** from @Alex`);
  picking up unclaimed work doesn't, since there's nobody to tell. `/chores
  claim` replies ephemerally and lets that one notice be the public record,
  rather than posting into whichever channel you happened to type in.
- *Why a menu, not emoji reactions:* reactions need a persistent Discord Gateway a
  serverless Worker can't hold; menu/button interactions arrive over the same HTTP
  path as slash commands.

---

## Calendars (ICS subscription)

The Worker serves read-only calendar feeds you subscribe to once; your calendar
app polls them and stays in sync. `/chores calendar` prints the URLs.

- **`/cal/alex.ics`**, **`/cal/kristal.ics`** — that person's assigned dated work.
- **`/cal/unassigned.ics`** — unassigned dated work anyone can grab.
- Feeds cover **all active dated issues workspace-wide** (chores *and* other
  projects like a shed build), excluding only the Recurring templates.
- Each chore is an **all-day event** on its due date with a Linear link and a 9am
  day-of reminder. Rebuilt live on every fetch, so it reflects the current
  schedule automatically.
- **Apple** honors a refresh interval (set it hourly). **Google** refreshes
  subscribed URLs on its own slow schedule (up to ~24h); on Android, subscribe via
  **ICSx⁵** to control the interval.

---

## Stats dashboard

- **🔍 Needed another pass** — how often each chore was flagged as done-but-
  incomplete, and who it landed on. Notes are stored **append-only**, so this
  counts every time it was raised rather than only whether one is currently
  outstanding — completion % can't see work that was finished but not finished
  properly, and this is the counterpart.
- **`/dashboard`** — a mobile-friendly, dark, keyless page (Chart.js): completion
  %, on-time %, done count, current streaks, per-person stacked bar, **effort
  split** (effort-adjusted minutes), and most-missed. A range bar switches
  **7 / 30 / 90 / 365** days (`?range=`). Reads from D1, so history survives
  Linear archiving. A link is pinned in **#recap** (`/pin-dashboard`).
- **Completion trend is one line per person**, on shared buckets, with the
  household as a faint dashed reference behind them. An individual's improvement
  shows on their own line instead of being averaged into a single number. A
  bucket with nothing due plots as a gap, not a misleading 0%.
- **How late, not just late.** A lateness panel buckets every resolved chore by
  *how many days* past due it was completed — `On time · 1 day · 2–3 · 4–7 · 8+ ·
  Never done` — plus average / median / worst days late, and the same per person.
  One day late and two weeks late are very different, and the old binary
  late/on-time split treated them identically. Computed from the `due_date` and
  `completed_date` already in D1, so existing history populates it immediately.

### 🎮 Chores before leisure (private)

An opt-in personal habit tracker — *was my own time earned?* — deliberately kept
out of the shared surfaces.

- **`/chores leisure [note:]`** logs that you're starting leisure. It records the
  time, how many of **today's** chores were still open, and whether your slate
  was clear. The reply is **ephemeral** — only you see it, nothing reaches the
  channel.
- **Clear** means today's chores are done. Older past-due items are counted and
  reported separately, so a months-old one-off can't make a clear slate
  permanently unreachable.
- The dashboard panel renders **only** for `/dashboard?user=<name>`. The link
  pinned in Discord has no `user`, and the shared page contains no trace of the
  feature — not the panel, not the data, not even the script.
- Shows clear-slate %, the current run of clear starts, a trend on the same
  buckets as the chore trend, and recent sessions.
- **Opt-in per person** via `LEISURE_PEOPLE`. This is personal habit tracking,
  not a household metric — the backstop never files a "missed" day against
  someone who didn't ask to be measured. Unset means nobody is auto-logged; the
  slash command and widget button remain available to anyone who uses them.
- **Every day gets a verdict, logged or not** (for people in `LEISURE_PEOPLE`). A second cron at **02:00 UTC**
  (10pm EDT / 9pm EST the evening before) closes out the day for anyone who
  didn't press anything:
  - chores all done → **a win** (doing them came before leisure)
  - chores outstanding → **a miss**
  A manual press always wins — the log never overwrites an existing row for the
  day. Without this an unlogged day vanished entirely (not a win, not a miss),
  and the misses were exactly the ones most likely to go unlogged.
- **Auto rows are timed by the last completion**, not by the cron: a day that
  ended clear is stamped with the moment the list actually emptied, which is the
  honest answer to "when did the evening start". A day that ended with work
  outstanding gets no time, and the wind-down chart skips rows without one — so
  the chart never shows an hour nobody chose. Auto rows are marked `· auto` in
  the dashboard's recent list, and `/leisure-sweep?key=…` runs the same pass on
  demand.
- Rows carry a **`source`** column (`self` today) so an automatic writer —
  Discord presence, a console integration — can log the same shape later with no
  schema change or dashboard rework. Note that Discord presence covers PC, Xbox
  and PlayStation but **not** Switch, and needs an always-on process a Worker
  can't provide.

---

## Phone status (widget + web)

- **`/status?user=<name>`** — JSON: `done`, `remaining`, today's `tasks`,
  `completed` today, `streak`. Keyless.
- **`/widget?user=<name>`** — a styled auto-refreshing page ("Add to Home Screen").
- With `?key=` present the widget shows **✓** (done) and a quieter **✖** (not doing it)
  per chore. Both clear it; only ✓ counts as work completed.
- The widget also lists **the other person's outstanding chores** and anything
  **up for grabs**, so it can answer "is there something I could take off their
  plate?" instead of going blank once your own list is clear. With `?key=`
  present each of those carries a **🙋 take it** button that reassigns the chore
  to you (via `/claim`) and refreshes.
- **Tap a chore on the widget page to expand its checklist** in place, instead
  of opening Linear to find out what "done" actually means. Markdown checkboxes
  render as a list (ticked items shown struck through), other lines as notes,
  with an "open in Linear ↗" link inside the panel. Chores with no checklist
  keep the old straight-to-Linear behaviour.
- **iOS Scriptable widget** (`scriptable-chores-widget.js`).
- **Streak** = consecutive days where every chore due that day was completed
  (no-chore days bridge it; today-in-progress doesn't break it).

---

## Maintenance & analytics

- **Auto-archive:** resolved chores — **completed *and* canceled** — older than
  `CHORE_RETENTION_DAYS` (default 30, set to **7** here) are archived, across
  **both** `CHORES_PROJECT` and `ADHOC_PROJECT`, up to `ARCHIVE_MAX` per run
  (runs 6 days a week, not Mondays). Archiving is **not** deletion: issues stay
  in Linear's archive and D1 keeps the stats — they just stop counting against
  the free plan's 250 active-issue cap. Manual: `/archive?key=…`, or
  `/archive?key=…&dry=1` to preview without touching anything.
  > The per-run budget is **split between completed and canceled**. Completed
  > chores always outnumber canceled ones, so taking them in order would hand
  > the whole allowance to `completed` every run and the canceled backlog would
  > never drain.
- **Cap warning:** posts to the admin channel once active issues reach
  `CAP_WARN_AT` (default 220). *(The 14-day horizon keeps this comfortable; a
  longer one runs much closer to the cap.)*
- **Weekly recap** (Mondays): one embed covering the **finished week ending
  yesterday** (Mon–Sun), so every day in it is final and "missed" is unambiguous.
  - **Household + per-person `done of assigned` and completion %** — a bare
    "2 done" says nothing without the denominator; 2 of 2 and 2 of 12 are very
    different weeks.
  - **Trend vs the week before** (`▲ 12 pts` / `▼ 16 pts`).
  - **What slipped** — the missed chores by name and owner (up to 10), which is
    the part you can act on.
  - **Chore-days clear** replaces the old "N-day streak": it counts days you
    actually had chores and cleared them, so a chore-free week can't build one.
    The old label implied consecutive calendar days and could span a month.
  - Bar colour tracks household completion (green ≥80%, amber ≥50%, red below).
  - Completion is compared in Eastern. **Archived issues are included** — the
    Monday sweep runs *before* the recap, so excluding them hid the very misses
    that had just been swept. Canceled issues are still excluded.
- **Stats (D1):** Monday snapshot of outcomes; query via `/stats?key=…&days=N`.

---

## Toolkit endpoints (key-guarded with `?key=<CRON_KEY>`)

| Endpoint | Action |
|---|---|
| `/digest` | **Repost today's chore list only** — no generation, no sweep, no archiving |
| `/run-cron` | Run the full daily cron now (digest **plus** generation, sweep, archiving) |
| `/run-week` | Generate the horizon now |
| `/annotate` | Refresh template schedule comments (returns a report) |
| `/archive` | Archive old completed chores now |
| `/scoreboard` · `/stats?days=N` | Post scoreboard / stats |
| `/replace?issue=CHO-12` | Archive + recreate an issue (rotates assignee) |
| `/done?match=<text>` | Mark the best-matching chore done |
| `/cancel?match=<text>` | Cancel the best-matching chore (cleared, **not** counted as done) |
| `/claim?match=<text>&user=<name>` | Assign the best-matching chore to that person (powers the widget's 🙋) |
| `/describe?q=<title>` | Diagnose what the engine parses for a template |
| `/delcomment?issue=…&id=…` | Delete a bot-authored comment |
| `/register-commands` | (Re)register slash commands with Discord |
| `/pin-dashboard` | Post + pin the dashboard link in #recap |
| `/capcheck` | Breakdown of what's consuming Linear's free-plan active-issue cap |
| `/botcheck` | Diagnose the bot token / channel for the digest |

**Keyless (read-only, non-sensitive):** `/status`, `/widget`, `/dashboard`,
`/cal/*.ics`. `/interactions` is the Ed25519-verified Discord endpoint.

---

## Security & verification

- **Linear webhooks** — HMAC-SHA256 against `LINEAR_WEBHOOK_SECRET`; bad/absent
  signature rejected (401).
- **Discord interactions** — verified with the app's Ed25519 key
  (`DISCORD_PUBLIC_KEY`) and inherently gated to your guild, so no shared secret.
- **Toolkit endpoints** that mutate or read sensitive data require `?key=<CRON_KEY>`.
  Status/widget/dashboard/calendar are intentionally keyless.

---

## Configuration

**Vars** (`wrangler.toml`): `DUE_LOOKAHEAD_DAYS`, `UNASSIGNED_LOOKAHEAD_DAYS`,
`CAP_WARN_AT`, `RECURRING_PROJECT`, `CHORES_TEAM`, `CHORES_PROJECT`,
`ADHOC_PROJECT`, `ROTATION_WEIGHTS`, `VACATION_PREP_TITLE`, `GEN_HORIZON_DAYS`,
`SWEEP_GRACE_DAYS`,
`GEN_MAX_CREATES`, `PUBLIC_BASE_URL`, `DISCORD_DUE_CHANNEL_ID`,
`CHORE_RETENTION_DAYS`, `ARCHIVE_MAX`. `ROTATION_MEMBERS` and `DISCORD_MENTIONS`
map the two people for rotation and @-pings.

**Secrets** (`wrangler secret put`): `LINEAR_API_KEY` (the "muffin" bot user's
key), `LINEAR_WEBHOOK_SECRET`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`,
`CRON_KEY`.

**Discord channels** (webhook URLs, set as secrets):

| Var | Used for |
|---|---|
| `DISCORD_WEBHOOK_DUE` | Daily digest (fallback when not bot-posting) |
| `DISCORD_DUE_CHANNEL_ID` + `DISCORD_BOT_TOKEN` | Bot-posted digest with the actions dropdown |
| `DISCORD_WEBHOOK_<TEAMKEY>` (e.g. `_CHO`) | Real-time events for that team |
| `DISCORD_WEBHOOK_DEFAULT` | Real-time events fallback |
| `DISCORD_WEBHOOK_ADMIN` | Free-tier cap warning |
| `DISCORD_WEBHOOK_STATS` | Stats posts (falls back to DUE/DEFAULT) |

> **After changing slash commands**, hit `/register-commands?key=…` so Discord
> picks them up. **After deploying**, commit and push.
