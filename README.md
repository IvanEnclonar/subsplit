# SubSplit

SubSplit is a menu bar / system tray app for a small group of people sharing one OpenAI
Codex subscription. It is the same idea as [CodexBar](https://github.com/steipete/CodexBar)
(MIT, by Peter Steinberger) — the app that put Codex quota in the macOS menu bar, and the
direct inspiration for this project — except CodexBar is deliberately single-machine and
single-human, and SubSplit is the multi-user layer it declined to build. Each member runs
SubSplit on their own machine (macOS **and** Windows), it reads that machine's local Codex
CLI logs, and a tiny shared server merges everyone's numbers so the group can see who has
burned what against the one account's 5-hour and weekly windows. MIT licensed, zero runtime
npm dependencies. Not affiliated with OpenAI or with CodexBar.

## How it works

Each app scans `~/.codex/sessions/**/rollout-*.jsonl` and `~/.codex/archived_sessions/**`
incrementally (rollout files are append-only, so it resumes from a stored byte offset). It
reads exactly three line types — `token_count`, `session_meta`, `turn_context` — and skips
`session_meta.payload.base_instructions` and `.dynamic_tools`. It never opens
`~/.codex/auth.json`, never opens `~/.codex/history.jsonl`, never reads conversation
content, and never makes an authenticated request to OpenAI. Every number comes from files
already on your disk.

What leaves your machine, per push: your display name, a random device UUID generated once
at install, aggregate token counters for the current 5h and weekly windows, and the
rate-limit snapshot Codex already wrote into your logs (`used_percent`, `resets_at`, plan
type). No prompts, no code, no file paths, no project names, no credentials.

## Architecture

```
  Alice (macOS)              Bob (Windows)              Carol (macOS)
  ~/.codex/sessions/**       ~/.codex/sessions/**       ~/.codex/sessions/**
        |                          |                          |
        |  fs.watch + incremental parse (local, read-only)     |
        v                          v                          v
  +--------------+           +--------------+           +--------------+
  | SubSplit app |           | SubSplit app |           | SubSplit app |
  +--------------+           +--------------+           +--------------+
        |                          |                          |
        |   PUT /v1/state   absolute window totals + snapshot  |
        |   GET /v1/state   ETag, every 60s                    |
        +--------------+-----------+-----------+---------------+
                                   |
                Authorization: Bearer ss_<group>_<secret>
                                   v
                    +------------------------------+
                    |  Cloudflare Worker           |
                    |  server/worker.js            |
                    |  aggregates at read time     |
                    +------------------------------+
                                   |
                    +------------------------------+
                    |  D1: groups, devices         |
                    +------------------------------+
```

One row per device. Token totals are **summed** across a member's devices; the account
rate-limit snapshot is account-wide, so the **freshest one wins and is never summed**.

## Setup — group admin (once)

Whoever pays for the Codex subscription deploys the server. Cloudflare's free tier covers
this workload with a wide margin (a 5-device group uses roughly 5% of the Workers request
budget and 2% of the D1 write budget).

```sh
cd server
npx wrangler d1 create subsplit          # copy database_id into wrangler.toml
npx wrangler d1 execute subsplit --remote --file=./schema.sql
npx wrangler secret put ADMIN_TOKEN      # paste a long random string
npx wrangler deploy
```

Then create the group and get the join token:

```sh
curl -X POST https://subsplit-server.<your-subdomain>.workers.dev/v1/groups \
  -H "X-Admin-Token: <the ADMIN_TOKEN you just set>"
# -> {"group_id":"a1b2c3d4e5","join_token":"ss_a1b2c3d4e5_<secret>"}
```

Share the server URL and the `join_token` with the group over a channel you trust. The
`ADMIN_TOKEN` stays with you — it is only used to create groups.

Prefer not to use Cloudflare? `npm run server:local` runs the identical API on plain
`node:http` with JSON-file persistence, for a box you already own.

## Setup — each member

1. Install the app (see the unsigned-build notes below).
2. Click the tray icon. The onboarding form asks for three things: **Server URL**, **Join
   token**, **Your name**.
3. Paste the server URL and join token the admin sent you, type the name your group will
   recognise, and hit Join.

Joining is idempotent and keyed on a slug of your name, so installing SubSplit on a second
machine with the same name binds both devices to one member — their totals get summed.

## Building from source

```sh
npm install
npm start              # run the app from source
npm run gen-icons      # regenerate assets/*.png (pure Node, no image libraries)
npm test               # node --test test/
npm run dist:mac       # dmg + zip
npm run dist:win       # nsis + portable
```

`dist:win` must run on Windows or in Windows CI — electron-builder cannot produce the NSIS
installer from macOS. Builds are unsigned; see below.

## Installing an unsigned build

**macOS.** The Control-click → Open bypass was removed in macOS Sequoia (15); it does not
work on Sequoia or Tahoe (26). The flow is now: launch the app, let it get blocked, then
open **System Settings → Privacy & Security**, scroll down to Security, click **Open
Anyway**, confirm **Open Anyway** a second time, and authenticate as an admin. This is
once per app — after that it launches normally. On Tahoe, action the prompt reasonably
promptly; reports indicate the Open Anyway entry expires roughly an hour after the block.

**macOS launch-at-login is unreliable here.** Electron documents that
`app.setLoginItemSettings()` may silently fail when an app is not code signed and
notarized. SubSplit shows the real status it reads back, so you can tell when macOS
ignored it. On Windows it works.

**Windows.** An unsigned installer trips SmartScreen: "Windows protected your PC" → click
**More info** → **Run anyway**.

**Windows Smart App Control cannot run this at all.** SAC is on by default on clean
Windows 11 22H2+ installs, evaluates every DLL an app loads rather than just the entry
exe, and hard-blocks unsigned code with no per-app allow-list and no "run anyway". Since
the April 2026 servicing update (KB5083769) it can be toggled off and back on; before
that, turning it off required reinstalling Windows.

**Windows 11 hides new tray icons.** Fresh tray icons land in the taskbar-corner overflow
flyout, and the shell can demote idle icons back into it. Drag the SubSplit icon out of
the flyout onto the taskbar, or go to **Settings → Personalization → Taskbar → Other
system tray icons** and turn it on. There is no API to force promotion.

## Fair-sharing model

- **Per-member attribution comes from local logs.** Each app sums the positive advances of
  `total_token_usage` in its own rollout files and attributes them to the timestamp of the
  event that produced them. Nobody's usage is inferred from the account.
- **Rate-limit windows are account-wide.** The 5h and weekly windows belong to the
  subscription, not to a person. SubSplit takes the freshest snapshot any member's logs
  have seen and shows it as the account header. Snapshots are never added together —
  summing four members' `used_percent` would report four times the real consumption.
- **Capacity share puts the two together.** Under each member SubSplit shows
  `account used% × (their tokens / the group's tokens)` for the window on screen — "~31% of
  weekly limit". It is an estimate built on the caveat below, but it answers the question
  people actually ask: how much of the subscription have *I* eaten this week.
- **The fair-share guide sits at 100/N%.** With four members that is a line at 25% on
  every share bar. It is a reference mark, not a limit: SubSplit does not throttle anyone.
- **Caveat worth internalising: OpenAI's `used_percent` is not proportional to raw
  tokens.** Cached input, reasoning output, and model tier are weighted differently by
  whatever OpenAI meters, and that formula is not published. So: token counts are the
  *fairness proxy* — the best available per-person signal — while the percentage bar is
  the *ground truth for the account*. Expect them to disagree, and settle arguments with
  the tokens while planning the week with the percentage.

## Notifications

SubSplit can raise a native toast when **your own** share of the account crosses a
threshold — "You've used ~34% of the account's weekly limit (alert at 25%). Resets in 2d
4h." The number it watches is your *capacity share*: the account's `used_percent` for that
window, split by your share of the group's tokens in it. The popover shows the same figure
under every member, so the alert never says anything the dashboard doesn't.

Open the gear icon to set it up. Each window has its own threshold, and leaving a box empty
means **auto** — your fair share, `100/N`, recalculated as people join or leave. Each alert
fires once per window per threshold and re-arms when the window resets. Nothing fires while
the group server is unreachable, because the numbers behind it would be stale. Alerts are
raised locally on your own machine: nobody else is told, and no alert text ever contains
your join token.

**Windows: the `portable` build may not show toasts.** Windows only delivers toasts to apps
with a Start Menu shortcut carrying the matching AppUserModelID, and the portable target
does not install one. The `nsis` installer does (`createStartMenuShortcut` is on), so use
that if you want notifications. macOS asks for notification permission the first time an
alert fires; Focus modes and Do Not Disturb silence them as usual.

## Limitations and privacy

- Token counts are an estimate for splitting a bill between friends, not billing-grade
  accounting. Don't use them for chargeback.
- The group token is a single symmetric secret shipped to every member. Anyone holding it
  could write any member's row and understate their own usage. That is fine for people who
  already share a subscription; it is not a threat model for strangers.
- The server cannot verify anyone's numbers. There is no reconciliation source.
- Member identity is a slug of the display name, so two names that slugify identically
  merge into one member. Pick distinct names.
- Reinstalling generates a new device ID and leaves the old row behind. Devices unseen for
  longer than a full window are dropped from the sums and flagged stale in the UI.
- `*.workers.dev` is blocked on some corporate and school networks. A custom domain fixes
  it and costs the free-tier-only property.
- D1's free tier has no point-in-time recovery. `wrangler d1 export` occasionally if the
  history matters to you.
- Sharing one subscription across people is between you and your provider's terms —
  SubSplit only reports on usage, it does not share or proxy credentials.

## Roadmap

- Per-model cost weighting, so a share number tracks money rather than raw tokens.
- Claude Code support alongside Codex (same local-log approach, different scanner).
- Window-reset notifications, and group-level alerts coalesced so N members don't get N
  copies of the same warning.

## License

MIT — see [LICENSE](LICENSE). Credit to [CodexBar](https://github.com/steipete/CodexBar)
(MIT) for proving the category and for the local-log parsing approach this borrows.
