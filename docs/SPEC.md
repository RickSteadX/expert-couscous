# Technical Specification — `termux-mcp-janitor`

**Modular local MCP server for Claude Code running in Termux on a Samsung (Android) phone.**
Core deliverables: (1) a reusable MCP server boilerplate with an add-on system, (2) a Downloads-folder janitor add-on, (3) a single idempotent setup/update script.

Version: 1.0-draft · Status: for review

---

## 1. Purpose and Scope

The project provides a locally running MCP (Model Context Protocol) server that Claude Code, installed inside Termux, spawns as a stdio subprocess. The server exposes tools for inspecting and cleaning the Android shared `Download` folder. The architecture is modular: the core server is a thin boilerplate that discovers and mounts add-ons, and the Downloads janitor is the first add-on. Everything installs and updates with one script.

v1 also includes a lightweight **watcher service** that detects new files landing in Downloads while no Claude Code session is running, queues them as events, and raises an Android notification; the janitor add-on exposes these events as a tool so the next session starts with full awareness of what arrived.

Out of scope for v1: remote (HTTP/SSE) transport, root access, cleaning folders other than Downloads, autonomous destructive actions by the watcher, GUI.

## 2. Target Environment

| Component | Requirement |
|---|---|
| Device | Samsung phone, Android 11+ (scoped storage era), no root |
| Runtime host | Termux (F-Droid or GitHub build; Play Store build is deprecated and must not be assumed) |
| Language runtime | Node.js LTS via `pkg install nodejs-lts` (currently Node 20+) |
| MCP host | Claude Code CLI (`@anthropic-ai/claude-code`), installed globally via npm inside Termux |
| MCP SDK | `@modelcontextprotocol/sdk` (TypeScript/JavaScript), stdio transport |
| Storage access | `termux-setup-storage` must have been granted; Downloads reachable at `~/storage/downloads` → `/storage/emulated/0/Download` |

Environment constraints that shape the design:

- **Scoped storage.** Without root, the app can only touch shared storage through the Termux storage grant. All paths must resolve through `$HOME/storage/downloads`; the server must refuse to operate if that symlink is missing and return an actionable error telling the user to run `termux-setup-storage`.
- **No reliable background execution.** Android kills background processes aggressively; the server therefore runs only for the lifetime of a Claude Code session (stdio child process), holds no daemon state, and persists everything to disk.
- **Battery/CPU budget.** Hashing for deduplication must be size-gated and lazy (hash only same-size candidates).
- **Filesystem quirks.** `/storage/emulated/0` is emulated FAT-like storage: no symlinks, no POSIX permissions, case-insensitive-ish behavior, and `rename()` across it and `$HOME` is a cross-device move. "Trash" must therefore live **inside** the Downloads tree (`Download/.janitor-trash/`) so moves are atomic.

## 3. High-Level Architecture

```
claude (Claude Code CLI, Termux)
   └── spawns via stdio ──► node ~/janitor-mcp/src/server.mjs
                              ├── core boilerplate
                              │     ├── MCP protocol layer (@modelcontextprotocol/sdk)
                              │     ├── add-on loader (scans src/addons/*/index.mjs)
                              │     ├── config loader (~/.config/janitor-mcp/config.json)
                              │     └── logger (stderr + rotating file)
                              └── add-ons
                                    └── downloads-janitor  (v1, bundled)

termux-services (runit)
   └── janitor-watcher ──► node ~/janitor-mcp/src/watcher.mjs   (long-lived, poll loop)
                              ├── snapshot-diff detector for ~/storage/downloads
                              ├── events.jsonl queue  ◄── read by downloads-janitor add-on
                              └── termux-notification (via Termux:API)
```

Design rule: **the core knows nothing about cleaning.** It only speaks MCP, loads add-ons, merges their tool registrations, and routes calls. Any future add-on (e.g., screenshots janitor, WhatsApp media janitor) drops into `src/addons/<name>/` with zero core changes.

Second design rule: **the MCP server and the watcher never talk directly.** An MCP stdio server only lives while a Claude Code session holds it open and cannot push messages on its own, so "trigger on new file" is implemented as a separate always-on watcher process that communicates exclusively through an append-only event file. Either side can run without the other.

## 4. Repository / Directory Layout

```
janitor-mcp/
├── setup.sh                  # one-script install AND update (idempotent)
├── package.json              # type: module; pinned deps
├── src/
│   ├── server.mjs            # entry point: boot core, load add-ons, connect stdio
│   ├── watcher.mjs           # standalone new-file watcher (runs under termux-services)
│   ├── core/
│   │   ├── addon-loader.mjs  # discovery, validation, registration
│   │   ├── config.mjs        # defaults + user config merge + schema validation
│   │   ├── logger.mjs        # stderr (never stdout!) + file log
│   │   └── fsx.mjs           # shared safe-FS helpers (path jail, atomic move)
│   └── addons/
│       └── downloads-janitor/
│           ├── index.mjs     # add-on manifest + tool implementations
│           └── rules.mjs     # categorization / age / dedupe logic
├── config.example.json
└── README.md
```

> **Critical stdio rule:** the server must never write logs to stdout — stdout is reserved for MCP JSON-RPC frames. All diagnostics go to stderr and to the log file (`~/.local/state/janitor-mcp/janitor.log`, rotated at 1 MB).

## 5. Core Boilerplate Specification

### 5.1 Server bootstrap (`server.mjs`)

1. Load config (defaults ← `config.example.json` semantics ← user config ← env overrides `JANITOR_*`).
2. Instantiate `McpServer({ name: "janitor-mcp", version })` from the SDK.
3. Run the add-on loader; each add-on returns tool definitions which are registered on the server.
4. Connect `StdioServerTransport`.
5. Trap `SIGTERM`/`SIGINT` for clean shutdown; flush log.

Startup must complete well under Claude Code's default 30-second MCP startup timeout; target < 2 s cold on a mid-range Samsung.

### 5.2 Add-on contract

Each add-on default-exports an object:

```js
export default {
  name: "downloads-janitor",        // unique, kebab-case
  version: "1.0.0",
  configSchema: { /* JSON Schema for its config section */ },
  init(ctx) { /* ctx = { config, logger, fsx } */ },
  tools: [ { name, description, inputSchema, handler } ]
};
```

Loader behavior: scan `src/addons/*/index.mjs`; skip (with a logged warning, not a crash) any add-on that fails validation or whose config section fails its schema; prefix nothing — tool names must be globally unique and human-readable (e.g., `downloads_scan`). An add-on listed in config `disabledAddons` is not loaded.

### 5.3 Shared safe-FS layer (`fsx.mjs`)

All add-ons must go through this layer; direct `fs` calls in add-ons are a code-review reject.

- `resolveJailed(path)` — resolves and verifies every path is inside the add-on's declared root (for the janitor: the Downloads dir). Rejects `..`, absolute escapes, and symlink escapes. This is the single defense that makes the tool safe to expose to an LLM.
- `atomicMoveToTrash(file)` — moves into `<root>/.janitor-trash/<ISO-date>/`, appending `-1`, `-2` … on name collision. Never calls `unlink` on user files.
- `emptyTrash(olderThanDays)` — the **only** function that permanently deletes, and only inside `.janitor-trash`.

## 6. Add-on: Downloads Janitor

### 6.1 Tools exposed

| Tool | Input (JSON Schema, summarized) | Behavior | Mutates? |
|---|---|---|---|
| `downloads_scan` | `{ }` | Walk Downloads (depth ≤ 3, skips `.janitor-trash`), return summary: total files/bytes, count+bytes per category, per age bucket, N largest files, duplicate-set count. | No |
| `downloads_list` | `{ category?, olderThanDays?, largerThanMB?, pattern?, limit=100 }` | Filtered listing (name, size, mtime, category), sorted by size desc. | No |
| `downloads_clean` | `{ selector: {category?/olderThanDays?/largerThanMB?/pattern?/paths?}, dryRun=true }` | Resolve selector to a file list. If `dryRun` (default **true**), return the exact list + reclaimable bytes and do nothing. If `dryRun:false`, move matches to trash and return a manifest of moves. | Trash only |
| `downloads_dedupe` | `{ dryRun=true }` | Group by size, hash (SHA-256, streaming) same-size groups, keep oldest copy, trash the rest. Same dry-run semantics. | Trash only |
| `downloads_undo` | `{ manifestId }` | Restore a previous clean/dedupe batch from its manifest (moves files back). | Restores |
| `downloads_empty_trash` | `{ olderThanDays=7, confirm:false }` | Permanently delete trash content older than N days. Requires `confirm:true`; otherwise returns what *would* be deleted. | **Deletes** |

Every mutating operation writes a JSON manifest to `~/.local/state/janitor-mcp/manifests/<id>.json` (id = timestamp) recording source→destination pairs, enabling `downloads_undo`.

### 6.2 Categorization rules (`rules.mjs`)

By extension, with a config-overridable map:

- `images` (jpg/jpeg/png/webp/gif/heic), `video` (mp4/mkv/webm/3gp), `audio` (mp3/m4a/ogg/opus), `documents` (pdf/docx/xlsx/pptx/txt/epub), `archives` (zip/rar/7z/tar.*), `apk` (apk/apks/xapk), `other`.

Age buckets: `<7d`, `7–30d`, `30–90d`, `>90d` by mtime.

### 6.3 Safety invariants (non-negotiable)

1. `dryRun` defaults to **true** on every mutating tool; the LLM must explicitly pass `dryRun:false`.
2. Nothing outside `~/storage/downloads` is ever read or written (path jail).
3. No permanent deletion except `downloads_empty_trash` with `confirm:true`, and only within `.janitor-trash`.
4. Protected patterns from config (`protect: ["*.pdf", "invoice*"]`, etc.) are excluded from every selector, even explicit `paths`.
5. A single `clean`/`dedupe` call is capped (default 500 files / 5 GB) — larger jobs must be batched, keeping each MCP response bounded.

## 7. Watcher Service (`watcher.mjs`) — trigger on new files

### 7.1 Why polling, not inotify

Android's shared storage is exposed through a FUSE/emulation layer that does **not** reliably deliver inotify events to Termux processes, so `inotifywait` on `~/storage/downloads` silently misses arrivals on many devices/Android versions. The watcher therefore uses **snapshot diffing**: every poll interval (default 30 s) it lists the Downloads tree (depth ≤ 3, skipping `.janitor-trash`) and diffs `{name, size, mtime}` against the previous snapshot persisted at `~/.local/state/janitor-mcp/snapshot.json`. Persisting the snapshot means files that arrived while the watcher was dead are still detected as new on next start — no event is ever lost to a reboot.

### 7.2 Detection semantics

- **New file:** present now, absent in previous snapshot.
- **Settled:** a new file is only emitted as an event once its size is identical across two consecutive polls (debounce for in-progress downloads); browsers' `.crdownload`/`.part`/`.tmp` names are ignored outright.
- **Event record** (appended to `~/.local/state/janitor-mcp/events.jsonl`, one JSON object per line):

```json
{ "id": "2026-08-28T09:14:02Z-ab12", "path": "Download/setup.apk",
  "size": 48211234, "category": "apk", "detectedAt": "...", "acked": false }
```

The file is append-only from the watcher's side; acking (below) is done by rewriting via atomic temp-file replace. Rotation at 1 000 events / 512 KB, oldest-acked first.

### 7.3 On-arrival actions (deliberately non-destructive)

1. Append the event.
2. Fire an Android notification via `termux-notification` (Termux:API): title "New download: *name* (12 MB, apk)", grouped under one "Janitor" channel, with a tap action that opens Termux. If Termux:API is not installed, this step is skipped silently — the queue still works.
3. Optional **auto-rules** from config run only *non-destructive* operations: `tag` (annotate event with a matched rule name, e.g. `"rule": "big-video"`). The watcher never moves, trashes, or deletes anything; all mutation stays behind the MCP tools' dry-run/confirm flow where a human (or the human-supervised model) is in the loop.

### 7.4 Process management on Samsung/Android

- Runs as a **termux-services** (runit) service `janitor-watcher`, so `sv up/down/status janitor-watcher` works and crashes auto-restart.
- Auto-start after reboot requires the **Termux:Boot** companion app; `setup.sh` drops `~/.termux/boot/janitor-watcher.sh` and tells the user to open Termux:Boot once.
- Holds a partial wakelock via `termux-wake-lock` while polling is active (releases if disabled in config).
- **Samsung-specific caveat (documented in README + printed by setup):** One UI aggressively kills background apps. The user must add Termux to *Settings → Battery → Never sleeping apps* and disable "Put unused apps to sleep", or the watcher will be killed within hours. The spec treats this as a documented manual step; it cannot be automated without root.
- Resource budget: one `readdir` pass every 30 s over ≤ ~5 000 files, no hashing, RSS target < 60 MB, negligible battery.

### 7.5 Janitor add-on integration (new tools)

| Tool | Input | Behavior | Mutates? |
|---|---|---|---|
| `downloads_events` | `{ unackedOnly=true, limit=50 }` | Return queued new-file events, newest first, including any auto-rule tags. | No |
| `downloads_events_ack` | `{ ids?[] }` | Mark listed events (or all) as acknowledged. | Queue only |
| `watcher_status` | `{ }` | Report: service running (via `sv status`), last poll time, snapshot size, queue depth, Termux:API present. | No |

Intended flow: the notification nudges the user; they open Claude Code and say "deal with the new downloads"; Claude calls `downloads_events`, reasons over arrivals, proposes a dry-run `downloads_clean`, executes on confirmation, then acks the events. A recommended (optional) Claude Code **SessionStart hook** snippet is shipped in the README that injects "N unacknowledged download events" into session context so Claude mentions arrivals proactively.

## 8. Configuration

File: `~/.config/janitor-mcp/config.json` (created from `config.example.json` on first setup, never overwritten on update).

```json
{
  "disabledAddons": [],
  "log": { "level": "info" },
  "watcher": {
    "enabled": true,
    "pollSeconds": 30,
    "notify": true,
    "wakeLock": true,
    "ignore": ["*.crdownload", "*.part", "*.tmp"],
    "autoRules": [
      { "name": "big-video", "match": { "category": "video", "largerThanMB": 300 } }
    ]
  },
  "downloads-janitor": {
    "root": "~/storage/downloads",
    "trashRetentionDays": 7,
    "maxBatchFiles": 500,
    "maxBatchBytes": 5368709120,
    "protect": [],
    "categories": { "ebooks": ["epub", "mobi"] }
  }
}
```

Env override convention: `JANITOR_LOG_LEVEL=debug`, etc. Config is validated on boot against the merged core + add-on schemas; a broken config yields a clear stderr message and exit code 78 (`EX_CONFIG`).

## 9. One-Script Setup / Update (`setup.sh`)

A single POSIX-ish bash script, safe to run repeatedly; first run installs, later runs update.

**Steps (all idempotent):**

1. **Guard rails.** Verify running inside Termux (`$PREFIX` contains `com.termux`); refuse otherwise.
2. **Packages.** `pkg update -y && pkg install -y nodejs-lts git` (skip cleanly if present).
3. **Storage.** If `~/storage/downloads` is absent, invoke `termux-setup-storage`, then wait/poll up to 60 s for the grant; abort with instructions if denied.
4. **Fetch/refresh code.** If `~/janitor-mcp/.git` exists → `git pull --ff-only`; else `git clone <repo> ~/janitor-mcp`. (Offline/zip fallback: `--from-dir <path>` flag copies a local tree instead.)
5. **Dependencies.** `npm ci --omit=dev` in the project dir.
6. **Config.** Copy `config.example.json` to `~/.config/janitor-mcp/config.json` only if missing.
7. **Claude Code check.** If `claude` is not on PATH, `npm install -g @anthropic-ai/claude-code`.
8. **Register with Claude Code** (re-registration safe: remove-then-add):

```bash
claude mcp remove janitor --scope user 2>/dev/null || true
claude mcp add --scope user --transport stdio janitor -- \
  node "$HOME/janitor-mcp/src/server.mjs"
```

Note the CLI grammar: all options (`--transport`, `--env`, `--scope`) come before the server name, and `--` separates Claude Code's flags from the command that launches the server. Absolute paths are used because Claude Code launches MCP subprocesses with a different shell environment than the interactive terminal, so relying on PATH lookups is fragile. Scope `user` makes the server available in every project on the phone.

9. **Watcher service.** `pkg install -y termux-services termux-api` (the Termux:API *app* must be installed by the user; setup detects and prints a reminder). Create `$PREFIX/var/service/janitor-watcher/run` pointing at `node ~/janitor-mcp/src/watcher.mjs`, then `sv-enable janitor-watcher && sv up janitor-watcher`. Drop `~/.termux/boot/janitor-watcher.sh` for Termux:Boot. Print the Samsung battery-settings reminder (§7.4). Re-runs simply restart the service.
10. **Smoke test.** Run `claude mcp list` and grep for `janitor` reporting connected; check `sv status janitor-watcher` reports `run`; additionally run the server directly for 2 s and confirm it emits a valid `initialize` response to a piped request. Print a green/red summary.
11. **Exit codes.** 0 success; 10 not-Termux; 11 storage denied; 12 npm failure; 13 registration failure; 14 watcher service failure — so the script is scriptable in CI on a Termux emulator image.

**Update path** is simply re-running `./setup.sh`: steps 2–9 detect existing state and refresh only what changed. `--uninstall` flag reverses step 8 and leaves user data/config in place.

## 10. Error Handling and Observability

- Every tool returns MCP tool results with `isError: true` plus a short machine-parsable `code` (`STORAGE_NOT_GRANTED`, `BATCH_LIMIT`, `PROTECTED_MATCH`, `TRASH_CONFIRM_REQUIRED`) and a human sentence, so Claude can self-correct (e.g., re-ask the user for confirmation).
- Log file with 1 MB rotation ×3; `downloads_scan` includes janitor's own trash size so the user sees the full picture.
- Verification loop for the user: `/mcp` inside a Claude Code session shows the server and its tool list; `claude mcp get janitor` shows the registration.

## 11. Acceptance Criteria (v1)

1. Fresh Termux on a Samsung device: `curl -fsSL <raw setup.sh URL> | bash` (or clone + `./setup.sh`) yields a connected `janitor` server in `claude mcp list` with no manual steps besides approving the storage permission dialog.
2. In Claude Code, the prompt "what's clogging my downloads folder?" triggers `downloads_scan` and produces a correct category/age breakdown on a folder with ≥ 1 000 mixed files in < 10 s.
3. "Delete installers older than 3 months" performs a dry-run first, and after user confirmation moves only matching `.apk`/archives to trash; `downloads_undo` fully restores them.
4. Dedupe on a folder containing 3 identical 100 MB files keeps exactly one and reports ~200 MB reclaimed.
5. No code path can delete or modify any file outside `Download/`, verified by a test suite running the path-jail against a hostile-input corpus (`../`, absolute paths, null bytes, symlink attempts).
6. Re-running `setup.sh` after a `git` update completes in < 30 s and preserves user config.
7. With no Claude Code session open, copying a file into `Download/` produces an Android notification within 2 poll intervals and an event in the queue; a file still being downloaded is not reported until its size settles.
8. After a phone reboot (with Termux:Boot installed and battery exemption set), the watcher is running again without user action, and files that arrived during downtime appear as events on first poll.
9. `downloads_events` in the next Claude Code session lists the arrivals; after `downloads_events_ack`, they no longer appear with `unackedOnly:true`.
10. The watcher performs zero writes inside `Download/` (verified by test harness) — it is read-only by construction.

## 12. Future Add-ons (design headroom, not v1)

Screenshots janitor (`~/storage/pictures/Screenshots`), WhatsApp media janitor, Telegram downloads, and a scheduled report generator once Termux:Boot/Termux:API integration is deemed worth the extra permissions. Each is a new folder under `src/addons/` implementing the §5.2 contract.
