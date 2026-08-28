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
| Watcher-facing tools (spec §7.5) | implemented, inert until the watcher runs |
| `setup.sh` install/update path (spec §9 steps 2–10) | not yet |
| `watcher.mjs` | not yet |

The server mounts nine tools today. `downloads_events`, `downloads_events_ack`, and
`watcher_status` are wired to the queue and snapshot files the watcher will write, so they
answer honestly (empty queue, service not running) until `watcher.mjs` lands.

## Tools

| Tool | Mutates? |
|---|---|
| `downloads_scan` — totals by category and age, largest files, likely duplicates, trash size | no |
| `downloads_list` — filtered listing, largest first | no |
| `downloads_clean` — move a selector's matches to the trash | trash only |
| `downloads_dedupe` — size-gated, hash-confirmed duplicate removal, keeps the oldest | trash only |
| `downloads_undo` — restore a batch from its manifest | restores |
| `downloads_empty_trash` — the only permanent delete, needs `confirm:true` | **deletes** |
| `downloads_events` / `downloads_events_ack` — the watcher's new-file queue | queue only |
| `watcher_status` — service state, last poll, queue depth, Termux:API presence | no |

Both mutating tools default to `dryRun: true`, and the default is applied by the core
before the handler runs, so an omitted argument can never arrive as `undefined`.

Two behaviours worth knowing, because neither is stated in the spec:

- **An empty selector is refused.** `downloads_clean` with `{}` would otherwise match every
  file, one `dryRun:false` away from emptying the folder.
- **Trash retention is dated from when a file was trashed**, read from the
  `.janitor-trash/<date>/` partition — not from its mtime, which a rename preserves. Dating
  off mtime would purge a six-month-old download the instant it was trashed and destroy the
  undo window.

## Quick start

```sh
./setup.sh --doctor   # read-only: verifies every prerequisite, changes nothing
npm ci --omit=dev
npm test
```

`--doctor` exits non-zero on the first blocking problem and prints the fix. Exit codes are
listed at the top of `setup.sh`.

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
