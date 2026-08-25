# Flow — Local Streamtime-style Planner

A tiny, private-by-default To Do / Done planner inspired by Streamtime's UI.
Runs 100% on your Mac. No account, no monthly fee.

## The layout

Modelled on Streamtime's To Do / Done view:

```
┌──┬────────────────────────────────────────────┬───────────┐
│  │                                            │           │
│  │            To Do  ← watermark              │  My items │
│ r│        ┌───────┐                           │  ┌──────┐ │
│ a│        │ block │  blocks stack UPWARD      │  │ card │ │
│ i│        ├───────┤  off the strip            │  ├──────┤ │
│ l│        │ block │                           │  │ card │ │
│  ├──Mon──┬──Tue──┬──Wed──┬──Thu──┬──Fri──────┤  └──────┘ │
│  │        │ block │  Done stacks DOWNWARD     │           │
│  │            Done   ← watermark              │           │
└──┴────────────────────────────────────────────┴───────────┘
```

## Features

- **Week grid** — every day is a column; the black day strip runs through the middle
- **To Do above the strip, Done below** — both anchored to it, exactly like Streamtime
- **Resizable blocks** — block height *is* the time estimate. Drag the **top** edge of a To Do
  block (or the **bottom** edge of a Done block) to change its hours. Snaps to 15 minutes,
  shows a live read-out, saves on release. 34px = 1 hour.
- **Drag & drop** — move blocks between days, between To Do and Done, or park them in
  "My items"; drag within a column to reorder
- **Daily + weekly totals** rolled up onto the day strip and the header
- **Recurring tasks** — daily / weekdays / weekly / every 2 weeks / monthly, optional end date
- **12 colour tags**, notes, and a searchable "My items" backlog
- **Calendar sync**
  - `.ics` subscription URL — Apple Calendar subscribes live
  - `.ics` download — one-shot import into any calendar
  - **Google Calendar two-way sync** via OAuth (optional, free Google Cloud project)
- **Local JSON storage** — everything is in `data/db.json`; back it up or wipe it freely

## Interactions

### The To Do card

Clicking a block opens Streamtime's "Edit Personal To Do" card. Every control is wired:

| Control | Does |
|---|---|
| ☑ **Done** (header) | Marks the to do complete |
| **?** | Opens the shortcuts sheet |
| **⋮** | Duplicate · Move to My items · Clear duration |
| **Date pill** | Click anywhere on it for the native date picker |
| **What's the to do?** | The block's title |
| **Start time** | Optional. Shows as the bold prefix on the block and drives calendar sync. Blank = 9am default. |
| **Description** | Notes — shown on the block when it's tall enough |
| **Hide description on the block** | Keeps the note in the card but off the block face |
| **Duration** | Free-text or quick pills. Accepts `45m`, `1h`, `1h 30m`, `1.5`, `90m` — all normalise on blur. Clicking the active pill clears the estimate. |
| **Colour / Repeat** | Block colour and the recurrence rule |
| **Log** (`⇧⌘↵`) | Marks done **and** saves in one go |
| **Save** (`⌘↵`) | Saves |

### Adding a to do without leaving the board

You shouldn't have to open a dialog and pick a date to add work to a day you're
already looking at.

- **Click the empty space in any day column** → a composer opens at the top of that
  day's pile.
- **Hover the gap between two blocks** → a dark insert bar and a **+** appear. Click
  it to slot a to do in at exactly that spot.
- Type, press <kbd>⏎</kbd>, and the next composer opens straight away — so you can
  rattle off a whole day without touching the mouse. <kbd>Esc</kbd> cancels.

The composer understands **quick entry**, so a time and a duration can go in the
same line and get pulled out into real fields:

| You type | You get |
|---|---|
| `Team standup 11am 30m` | *Team standup* · starts 11:00 · 30m |
| `Call supplier 45m` | *Call supplier* · 45m, no start time |
| `Site walkthrough 1:30pm 1h 30m` | *Site walkthrough* · starts 13:30 · 1h 30m |

Anything it doesn't recognise stays in the title, so you can ignore the syntax entirely.

### Theme

One accent, used consistently:

| Token | Value | Used for |
|---|---|---|
| `--accent` | near-black `#1E1D1B` | every primary action — buttons, insert bar, active pills |
| `--signal` | yellow `#F7D046` | signals only: today, over capacity, active nav |
| `--focus` | blue `#5C9DBE` | focus rings |
| `--info` | blue `#2E86B8` | the recurring glyph |
| `--danger` | `#A8392C` | destructive actions |

Radii collapse to four steps (`--r-xs` 2px → `--r-lg` 10px) and type to a six-step
scale (`--fs-xs` 10px → `--fs-xl` 17px). There is no orange anywhere.

### Collapsing the panels

Both side panels fold away when you want the board wider:

| Panel | Collapse | Reopen |
|---|---|---|
| **Activity** (left) | `«` in its header | the bolt in the rail |
| **My items** (right) | `»` in its header | click the slim spine it leaves behind |
| **Done** (below the strip) | the `⌄` circle | the same circle |

Collapsed, **My items** keeps a 38px spine showing the label and the item count, so
you always know it's there and how much is in it. All three states persist.

One nicety: if you start **dragging** while My items is collapsed, it slides back open
for the duration of the drag — so parking something there still works — then re-collapses
when you drop.

### Activity panel

The bolt in the rail opens a side panel with three tabs:

| Tab | Shows |
|---|---|
| **★ Starred** | To dos you've starred. Right-click → **Star**, or the ★ appears on the block. Click a row to jump to it. |
| **🕐 History** | A real change log — created, renamed, completed, moved, `duration 1h 45m → 2h 30m`, start time set, repeat changed, deleted. Recorded server-side so it survives reloads. Click a row to open that to do. |
| **💬 Needs attention** | Live checks: overdue to dos, days over capacity, scheduled work with no estimate, Google Calendar configured but not connected. Most rows have a one-click fix. A red dot on the tab means something urgent. |

The footer carries two real numbers: **planned this week** against your capacity
(amber past 85%, red over), and **done this week**.

Streamtime's "Active Jobs / Refer a friend" panel is deliberately not reproduced —
there are no jobs here and nobody to refer.

### Selecting several at once

Drag on empty canvas to **rubber-band select**, the way Finder selects files.

| Action | How |
|---|---|
| Marquee select | Drag across empty canvas |
| Add to / remove from selection | ⌘-click (or ⇧-click) a block |
| Select everything on screen | <kbd>⌘A</kbd> |
| Clear | <kbd>Esc</kbd>, click empty canvas, or **Clear** in the count bar |
| Act on the selection | Right-click any selected block |
| Delete the selection | <kbd>⌫</kbd> |

With a selection, every context-menu action applies to all of it — *Duplicate 7*,
*Move 7 to ›*, *Log 7*, *Delete 7*, *Star 7*, *Save 7 as templates*, *Start 7 now* —
and the whole batch is a single undo step.

Right-clicking a block *outside* the selection collapses the selection onto that
block, so you can't act on things you've forgotten are selected.

Multi-block **dragging** isn't supported — use *Move N to ›* for bulk rescheduling.

### Anytime — to dos with no duration

Block height *is* duration, so a to do with no estimate has no length and no honest
place on the time axis. Rather than invent one, they get an **all-day band** across
the top of the To Do zone — the same idea as all-day events in Google Calendar.

```
  ANYTIME
  ┌────────┬────────┬────────┬────────┬────────┐   ← band, on the same column grid
  │ chip   │ chip   │ chip   │        │ chip   │
  └────────┴────────┴────────┴────────┴────────┘
  ─────────────────────────────────────────────    ← hairline, deliberately quiet
                    │ block  │
  ┌──Mon───┬──Tue───┼────────┼──Thu───┬──Fri───┐   ← timed pile, on the strip
  ███████████████████ Wed 26 ██████████████████    ← the day strip stays the loud one
```

- **Colour-coded**, but as a *wash* of the tag colour with a solid left edge — plainly
  a different species from the solid timed blocks, without losing the colour.
- **One `ANYTIME` label** at the left of the band, not repeated per column.
- The separator is a `#D6CFC1` hairline. The day strip is near-black `#171716`; the
  band divider is meant to be noticed only when you look for it.
- Band items contribute **nothing** to any total or capacity bar.
- The band **hides entirely** when nothing is untimed, and reappears as a drop target
  while you're dragging.
- It scrolls past 27vh, so a heavy day can't push the schedule off screen.

**Converting between the two is a drag:**

| Drag | Result |
|---|---|
| chip → down into the pile | picks up a 1h estimate so it has a length; you're told, and the resize edge is right there |
| block → up into the band | estimate cleared |

Or set a duration in the card / **Set duration…** in Manage and it moves itself.

### Moving a repeating series

A repeating to do has a **start** (the one showing the `series` tag) and generated
**occurrences**. Open the start and change its date, and the whole series re-anchors
to the new date while keeping its rule — forwards or backwards.

> Started 1 Sept, repeating weekly (Tuesdays). Change the date to 1 July and you get
> 21 occurrences running from July, all on **Wednesdays**, with no stale Tuesdays left.

- Unfinished occurrences off the old anchor are removed and rebuilt.
- **Completed occurrences are kept** — they're a record of work you actually did,
  so they stay put even if they no longer fit the schedule.
- Changing the *rule* (weekly → monthly) rebuilds the same way.
- Editing an *occurrence* only affects that day. The card says which you're on, and
  offers **Edit the series** when you're on an occurrence.

### Manage — bulk editing

**Manage** in the header opens a table over every to do, at every date, so you never
have to click through months to fix things.

Filter by text, date range, status, and kind:

| Kind | Shows |
|---|---|
| Everything | all to dos |
| Repeating series | just the series starts |
| Series occurrences | generated occurrences |
| One-off only | scheduled, not part of a series |
| **No duration** | scheduled but with no estimate — the Anytime ones |
| My items | unscheduled |
| **Orphaned occurrences** | occurrences whose series was deleted — safe to clear out |

Tick rows (or the header box to take everything matching), then:

**Move to date… · Shift by days… · Set duration… · To My items · Mark done · Reopen · Delete**

`Set duration…` takes the same shorthand as the card — `45m`, `1h 30m`, `2` — and an
empty value clears the estimate, which drops those to dos into **Anytime**.

Every bulk action is **one atomic write** on the server and **one undo step** —
59 rows delete in a single request, and ⌘Z brings them all back.

### Safety net

- **Undo / redo** — <kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd>, up to 40 steps back. Covers deletes,
  drags, resizes, edits, ticks, moves and carry-overs. Because of it, deleting a
  focused block with <kbd>⌫</kbd> doesn't nag you with a dialog.
- **Rolling backup** — the server copies the last good `db.json` to `db.bak.json`
  before every write. If `db.json` ever becomes unreadable it recovers from the
  backup and quarantines the bad file as `db.json.corrupt-<timestamp>` instead of
  starting empty. Worst case you lose the single most recent change, not everything.
- **Single-instance lock** — a second server refuses to start rather than share
  `data/db.json`, which is how a half-written file becomes a corrupt one.
- **Download backup / Restore from file** in Settings, any time.

### What shows on a block

A block shows as much as its height allows, and its height *is* the estimate — so a
short to do is a short block. The split adapts:

| Block height | Shows |
|---|---|
| under 42px | title, one line |
| 42–47px | title, two lines |
| 48–67px | title + **description**, one line each |
| 68–91px | title (2 lines) + description |
| 92px and up | title (2 lines) + description (2 lines) |

With no description the title takes the spare lines instead. **Hovering any block
shows the full title, time, duration and description** as a tooltip, however small it is.

Ticking **Hide description on the block** in the card keeps a note in the card only.

### Block height

Because height encodes duration, a 1h to do at the default scale is 34px — not enough
for a second line. **Settings → Block height** trades density for legibility:

| Scale | A description shows from |
|---|---|
| Compact — 26px/h | 2h |
| Normal — 34px/h | 1.5h |
| Roomy — 50px/h | 1h |
| Extra roomy — 64px/h | 1h (45m at a squeeze) |

### Capacity

Set **hours per day** in Settings (default 8). Each day tab carries a load bar, and
tips amber once the day is over capacity — so an over-committed Wednesday is obvious
before you get there.

### Add New (templates)

The **▾** beside *New task* opens the **Add New** list. Anything you save from a
to do's right-click menu lands there with its time, duration, colour and repeat rule
intact — one click drops a fresh copy onto the selected day. Hover a row and hit **×**
to remove it.

### Overdue carry-over

Unfinished to dos on past days surface as an **"N overdue → today"** pill in the header.
One click moves them all to today (undoable).

### Right-click menu

Right-clicking any block or "My items" card opens the contextual menu:

| Item | Does |
|---|---|
| **Duplicate** | Copies the to do, including colour, duration and start time |
| **Move to ›** | Flyout of every visible day plus **My items**; the current one is marked |
| **Log** | Marks done (or **Un-log** to send it back to To Do) |
| **Delete ›** | *Just this one*, or *This and all future* on a recurring series |
| **Save as template** | Adds it to the **Add New** list for one-click reuse |
| **Start now** | Stamps the current time (to the nearest 15 min) and moves it to today |

### Block appearance

By default blocks are **neutral** — a white card with dark text, a bold start-time
prefix, a blue glyph on recurring items, and the tag colour reduced to a slim left
edge. This is how Streamtime renders "Personal" to dos that aren't attached to a job.

Flip **Colour** in the header to fill each block with its tag colour instead. The
choice is remembered, as is the Weekend toggle.

### Board

| Action | How |
|---|---|
| Add to a day | Click the empty space in its column |
| Add between two tasks | Hover the gap → click the **+** |
| Change a task's hours | Drag the block's grip edge (top in To Do, bottom in Done) |
| Open the contextual menu | Right-click a block or card |
| Move to another day | Drag the block body to another column |
| Reorder within a day | Drag the block body up/down |
| Mark done | Drag below the strip, or click the tick (appears on hover) |
| Unschedule | Drag into **My items** |
| Edit | Click a block, or focus it and press <kbd>Enter</kbd> |
| New task on a day | Double-click empty space in that column |

### Keyboard

| Keys | Does |
|---|---|
| <kbd>⌘K</kbd> | Search every to do |
| <kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd> | Undo / redo |
| <kbd>⌘N</kbd> | New task on the selected day |
| <kbd>⌘Enter</kbd> | Save the open task |
| <kbd>⇧⌘Enter</kbd> | Log — mark done and save |
| <kbd>Esc</kbd> | Close a dialog |
| <kbd>⌥←</kbd> / <kbd>⌥→</kbd> | Previous / next week |
| <kbd>⌥T</kbd> | Jump to today |
| <kbd>Tab</kbd> then <kbd>Enter</kbd> / <kbd>D</kbd> | Open a block / toggle done |

## Quick start

```bash
cd ~/streamtime-clone
npm install
npm start
```

Open **http://localhost:3000**. That's it.

To run it in the background at login, drop a launchd plist in `~/Library/LaunchAgents` — happy to add one if you want.

## Data

Everything is in `./data/`:
- `db.json` — your tasks
- `gcal-tokens.json` — Google OAuth tokens (only if you connect Google)

Delete `data/` to start fresh. Copy it to another Mac to move your data.

## Calendar sync — three options

### 1. Apple Calendar (live, one-way)
1. Click **Sync** in the top-right.
2. Copy the subscription URL (`http://localhost:3000/calendar.ics`).
3. Apple Calendar → File → New Calendar Subscription → paste.
4. Apple Calendar polls it every 5 min / hourly (configurable) while Flow is running.

### 2. Download `.ics` (one-shot import)
Works with any calendar (Outlook, Fastmail, etc). Not live — re-download to update.

### 3. Google Calendar (two-way, live)
Needs a free Google Cloud project because Google won't accept `localhost` subscriptions.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → New Project.
2. **APIs & Services → Library** → search **Google Calendar API** → Enable.
3. **APIs & Services → OAuth consent screen** → External → fill in the app name (any) and your email as test user.
4. **APIs & Services → Credentials** → Create Credentials → OAuth client ID → **Web application**.
5. Add authorised redirect URI: `http://localhost:3000/oauth/google/callback`
6. Copy the Client ID and Client Secret.
7. In this project: `cp .env.example .env`, paste the values in, save.
8. `npm start` again.
9. Sync panel → **Connect Google** → authorise.
10. **Push tasks → Calendar** creates/updates events; **Pull from Calendar** brings edits back.

Events use each task's **Start time** and **Duration**. A task with no start time falls
back to 9am — change that default in `startFor()` in `server.js`. Pulling from Google
brings edited times back into Flow.

## Notes / gotchas

- Storage is single-user, single-machine. If you want cross-device sync, wrap this in Supabase or Cloudflare D1 — I can add that later.
- Recurring tasks materialise 90 days forward on every load. Delete the parent (the one with the ↻ badge on its original day) to remove the whole series.
- Marking a recurring instance done only affects that day.
- Google two-way sync uses the event ID stored on each task. If you delete a task in Flow, the event stays until the next Push, then it's removed.
- Block scale is `--px-hour` in `public/styles.css` (34px = 1h) and `PX_HOUR` in `public/app.js`. Change both together if you want a denser or roomier day.
- A block under 40px collapses to a single-row "compact" style so the title and hours never collide.

## File tree

```
streamtime-clone/
├── server.js           # Express server, storage, ICS, Google Calendar
├── package.json
├── .env.example        # Copy to .env for Google sync
├── public/
│   ├── index.html
│   ├── styles.css      # Streamtime-inspired look
│   └── app.js          # Frontend (drag/drop, modals, state)
└── data/               # Auto-created, holds db.json + tokens
```
