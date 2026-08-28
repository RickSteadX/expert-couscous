# termux-mcp-janitor

Modular local MCP server for Claude Code running in Termux on Android, plus a Downloads
folder janitor add-on and a watcher service.

See [`docs/SPEC.md`](docs/SPEC.md) for the full technical specification and
[`docs/PREREQUISITES.md`](docs/PREREQUISITES.md) for everything that must be true on the
device before setup can succeed.

## Status

| Piece | State |
|---|---|
| Core boilerplate (`src/core/`, `src/server.mjs`) | implemented |
| `setup.sh --doctor` preflight | implemented |
| `downloads-janitor` add-on (spec §6) | implemented |
| Theme sorting (`downloads_sort`) | implemented, extends the spec |
| Watcher service (`src/watcher.mjs`, spec §7) | implemented |
| Watcher-facing tools (spec §7.5) | implemented |
| `setup.sh` install / update / uninstall (spec §9) | implemented |

Feature-complete against the spec for v1, plus theme sorting. Not yet validated on a
physical Samsung device — the Termux-specific paths (package install, storage grant,
`sv`, Termux:API, Termux:Boot) are written against the documented behaviour but have only
been exercised off-device.

## Tools

| Tool | Mutates? |
|---|---|
| `downloads_scan` — totals by category and age, largest files, likely duplicates, trash size | no |
| `downloads_list` — filtered listing, largest first | no |
| `downloads_sort` — file loose downloads into themed subfolders from a plan you author | moves only |
| `downloads_clean` — move a selector's matches to the trash | trash only |
| `downloads_dedupe` — size-gated, hash-confirmed duplicate removal, keeps the oldest | trash only |
| `downloads_undo` — restore a batch from its manifest | restores |
| `downloads_empty_trash` — the only permanent delete, needs `confirm:true` | **deletes** |
| `downloads_events` / `downloads_events_ack` — the watcher's new-file queue | queue only |
| `watcher_status` — service state, last poll, queue depth, Termux:API presence | no |

Both mutating tools default to `dryRun: true`, and the default is applied by the core
before the handler runs, so an omitted argument can never arrive as `undefined`.

## Sorting by theme

`downloads_sort` is an addition to the spec: the janitor files things as well as cleans
them. The themes are **decided by the model, not by the server** — there is no built-in
"invoices" heuristic. The flow is:

1. `downloads_scan` or `downloads_list` to see what is there, plus which theme folders
   already exist (`folders` and `looseFiles` in the scan output, so a second run reuses
   `Tax 2026` rather than inventing `Taxes 2026` beside it).
2. Submit a plan — folder name, the files that belong in it, and an optional one-line
   reason echoed back in the dry run.
3. Dry run first, then `dryRun:false`, exactly like `downloads_clean`.

```jsonc
{ "plan": [
    { "folder": "Tax 2026", "paths": ["invoice-jan.pdf", "payslip-mar.pdf"],
      "reason": "financial records for the 2026 tax year" },
    { "folder": "Photos/Summer trip", "paths": ["IMG_20260714_beach.jpg"] }
] }
```

Files land in subfolders **inside** `Download/`, which keeps every move a same-device
rename (atomic) and keeps one path jail. A sort is recorded in the same manifest format as
a clean, so `downloads_undo` restores the flat layout and prunes the folders it emptied.

Folder names are validated as strictly as paths: no traversal, no absolute paths, no
leading dots (which is also what keeps a plan out of `.janitor-trash`), and none of the
characters that are invalid on the FAT-like emulated volume. Protected patterns block
sorting just as they block cleaning, and re-running an identical plan is a no-op rather
than a churn of `-1` suffixes.

Two behaviours worth knowing, because neither is stated in the spec:

- **An empty selector is refused.** `downloads_clean` with `{}` would otherwise match every
  file, one `dryRun:false` away from emptying the folder.
- **Trash retention is dated from when a file was trashed**, read from the
  `.janitor-trash/<date>/` partition — not from its mtime, which a rename preserves. Dating
  off mtime would purge a six-month-old download the instant it was trashed and destroy the
  undo window.

## Install

On the phone, in Termux:

```sh
git clone https://github.com/RickSteadX/expert-couscous.git ~/janitor-mcp
cd ~/janitor-mcp
./setup.sh --doctor   # read-only: check prerequisites first
./setup.sh            # install, or update an existing install
```

`setup.sh` is idempotent — re-running it updates. It installs packages, requests the
storage grant, runs `npm ci`, seeds the config (never overwriting an existing one),
registers the server with Claude Code at user scope, sets up the `janitor-watcher`
service, drops a Termux:Boot script, and finishes with a smoke test.

| Flag | Effect |
|---|---|
| *(none)* | install or update |
| `--doctor` | read-only preflight, changes nothing |
| `--from-dir DIR` | install from a local tree instead of cloning (offline) |
| `--uninstall` | unregister and remove the service; config, logs and trash are kept |

Exit codes are listed at the top of `setup.sh`; `--doctor` exits non-zero on the first
blocking problem and prints the fix.

**`setup.sh` does not install Claude Code.** It detects it and stops with instructions if
it is missing, because a plain `npm install -g` does not produce a working CLI on Android
and bundling a third-party installer here would mean owning its upgrade treadmill. See
[`docs/PREREQUISITES.md` §3](docs/PREREQUISITES.md).

## Development

```sh
npm ci --omit=dev
npm test          # 69 tests, no device required
```

## Installing Claude Code in Termux

A plain `npm install -g @anthropic-ai/claude-code` **does not produce a working CLI on
Android** — Anthropic ships a glibc-linked binary and Termux runs on bionic. This project
targets the patched-native-binary path; see
[`docs/PREREQUISITES.md` §3](docs/PREREQUISITES.md) for the options, the trade-offs, and
why `proot-distro` is the wrong choice here specifically.

## Layout

```
src/
├── server.mjs          entry point: load config, mount add-ons, connect stdio
└── core/
    ├── addon-loader.mjs  discovery, manifest validation, tool registration
    ├── config.mjs        defaults <- user config <- env, validated
    ├── errors.mjs        machine-parsable error codes (spec §10)
    ├── fsx.mjs           path jail, atomic move to trash, the only delete
    ├── logger.mjs        stderr + rotating file, never stdout
    └── schema.mjs        JSON Schema subset validator
```

Two files are additions to the spec's §4 layout: `errors.mjs` (the §10 codes needed a
home) and `schema.mjs` (the add-on contract declares plain JSON Schema, so the core needs
a validator; using it for config validation too avoids a second mechanism).

## The watcher

`src/watcher.mjs` runs under termux-services, independent of any Claude Code session, and
tells the next session what arrived while it was away.

It polls rather than using inotify: Android's shared storage is exposed through a
FUSE/emulation layer that does not reliably deliver inotify events to Termux, so
`inotifywait` silently misses arrivals on many devices. Every 30 seconds it lists the
Downloads tree and diffs `{size, mtime}` against a snapshot persisted in the state
directory — which is also why files that landed while the phone was off still show up as
new on the next start.

Three behaviours worth knowing:

- **A new file is only announced once its size is unchanged across two polls.** That is
  the debounce for in-progress downloads; `*.crdownload`, `*.part` and `*.tmp` are ignored
  outright at any size.
- **The very first run adopts what is already there as the baseline** rather than
  announcing every file you have ever downloaded.
- **It never writes inside `Download/`.** It calls only the read side of `fsx`; every
  write goes to the state directory. Auto-rules can *tag* an event (`"rule": "big-video"`)
  and nothing more — all mutation stays behind the tools' dry-run flow, where a human is
  in the loop. This is asserted by a test.

Events land in `~/.local/state/janitor-mcp/events.jsonl`, and the queue is the only
contract between the watcher and the server: an MCP stdio server cannot push messages on
its own, so the two processes never talk directly and either runs happily without the
other. Read them with `downloads_events`, clear them with `downloads_events_ack`, and
check on the service with `watcher_status`.

Notifications go through `termux-notification`. If the Termux:API app is missing the step
is skipped and the queue still works — but note the probe uses a timeout rather than
`command -v`, because the CLI package without the app *blocks* rather than failing.

## Two rules that are easy to break

**Never write to stdout.** stdout carries MCP JSON-RPC frames. A stray `console.log`
corrupts the stream and the session dies with a parse error that looks nothing like its
cause. Use the logger — it writes to stderr and to
`~/.local/state/janitor-mcp/janitor.log`. This is covered by a test.

**Never call `fs` directly from an add-on.** Everything goes through `fsx`, whose
`resolveJailed()` is the single defense that makes these tools safe to expose to a model.
It is covered by a hostile-input corpus in `test/fsx-jail.test.mjs`, which runs off-device
on purpose: `/storage/emulated/0` has no symlinks, so the symlink-escape cases cannot be
constructed on the phone.

## Writing an add-on

Drop a directory under `src/addons/<name>/` with an `index.mjs` that default-exports:

```js
export default {
  name: 'downloads-janitor',      // kebab-case, must match the directory name
  version: '1.0.0',
  configSchema: { type: 'object', properties: { /* ... */ } },
  init(ctx) { /* ctx = { config, logger, fsx, createFsx, stateDir, schema } */ },
  tools: [{
    name: 'downloads_scan',       // snake_case, globally unique, no prefixing
    description: 'Summarise what is in the Downloads folder.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (args) => ({ /* anything JSON-serialisable */ })
  }]
};
```

The core validates arguments against `inputSchema` and applies its defaults before calling
the handler, so a `dryRun` declared with `default: true` arrives as `true` when the model
omits it. Throw a `JanitorError` with a code from `errors.mjs` for anything the model
should be able to recover from; anything else is caught and reported as `INTERNAL`.

A broken add-on is skipped with a logged warning rather than taking the server down —
losing every tool because one add-on has a config typo is a worse outcome on a phone than
losing one add-on.
