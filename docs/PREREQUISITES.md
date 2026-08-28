# Prerequisites — `termux-mcp-janitor` from scratch

Companion to the v1 technical specification. This document answers one question:
**starting from a factory-fresh Samsung phone with nothing installed, what must be
true before `setup.sh` can run to a green summary?**

It splits prerequisites into what `setup.sh` can do for itself and what it can only
*check for and instruct*, because that boundary is where the spec's §11 acceptance
criteria are currently over-optimistic.

Status: review draft, written against spec v1.0-draft.

---

## 0. Summary of the critical path

```
  device + Android version + free space          ┐
  Claude account (Pro/Max/Team or API key)       ├─ Tier 0  cannot be automated
  Termux + Termux:API + Termux:Boot  (one source)┤          (human, Android UI)
  storage grant · notification grant · battery   ┘
              │
              ▼
  pkg: nodejs-lts git termux-api termux-services ┐ Tier 1  setup.sh does this
  Claude Code CLI reachable as `claude`          ┤ Tier 2  setup.sh, WITH CAVEATS
  claude authenticated (OAuth / API key)         ┤ Tier 3  human, one time
  repo + lockfile + zero native deps             ┘ Tier 4  project-side
              │
              ▼
  claude mcp add · sv-enable janitor-watcher · smoke test
```

The blocking realization: **five of the Tier 0 items require the Android UI and cannot
be driven from a shell.** The spec's acceptance criterion 1 ("no manual steps besides
approving the storage permission dialog") is not achievable as written — see §7.

---

## 1. Tier 0 — Device, account, and apps (human, before the script exists)

### 1.1 Hardware and OS

| Requirement | Value | Why it matters | How to verify |
|---|---|---|---|
| CPU architecture | `aarch64` (64-bit ARM) | Node.js and the Claude Code binary ship arm64 builds; 32-bit `arm` Termux still exists on old/budget devices and has no working Claude Code path | `uname -m` |
| Android version | 11+ per spec; 8+ is the true floor for Termux, but 11+ changes storage semantics | Scoped storage era assumptions in §2 of the spec | `getprop ro.build.version.release` |
| Free space — app-private | **≥ 2.5 GB** on `/data` | Termux `$HOME` is `/data/data/com.termux/files/home`. Node LTS ≈ 120 MB, npm cache ≈ 200 MB, Claude Code ≈ 300–600 MB depending on install path, proot fallback ≈ 2 GB | `df -h $HOME` |
| Free space — shared | Enough headroom for `Download/.janitor-trash/` | Trash is a *move inside* Downloads (§2 of spec), so it reclaims nothing until `downloads_empty_trash` runs. A "clean" of 4 GB frees 0 bytes on day one | `df -h ~/storage/downloads` |
| Not root | Assumed, fine | The whole design targets non-root | — |
| Single Android user profile | Termux running as the primary user | In Secure Folder or a second profile, shared storage is `/storage/emulated/10`, not `/0`; the janitor's path jail must key off the resolved symlink, never a hardcoded `/storage/emulated/0` | `readlink -f ~/storage/downloads` |

### 1.2 Anthropic account

Claude Code needs an identity before any MCP work is meaningful:

- A **Claude Pro / Max / Team / Enterprise** subscription, **or** a Console
  pay-as-you-go account with an `ANTHROPIC_API_KEY`.
- The OAuth login flow opens a URL and expects a code pasted back, so the phone needs
  a working **browser app**. On a headless/automated setup use
  `ANTHROPIC_API_KEY` instead — this is the only auth path a `--non-interactive`
  `setup.sh` can satisfy.
- This is a hard prerequisite for acceptance criteria 1–4, all of which require a
  live Claude Code session.

### 1.3 The three Android apps — and the signature rule

| App | Required for | Source |
|---|---|---|
| **Termux** | everything | F-Droid **or** GitHub releases |
| **Termux:API** | `termux-notification` (§7.3), `watcher_status` reporting API presence | same source as Termux |
| **Termux:Boot** | watcher survives reboot (§7.4, acceptance criterion 8) | same source as Termux |

> **Hard rule: all three must come from the same source.** F-Droid and GitHub builds are
> signed with different keys, and Android refuses to install an add-on whose signature
> does not match the base app. Mixing them produces an install failure, or worse, an
> installed add-on that Termux silently ignores. Anyone migrating from the deprecated
> Play Store build must **uninstall Termux and every add-on first**, which also wipes
> `$HOME`.

`setup.sh` can only *detect* these. Detection recipes:

```sh
# Termux itself
case "$PREFIX" in *com.termux*) : ;; *) exit 10 ;; esac

# Termux:API app (the CLI package is not enough — the app provides the service)
command -v termux-notification >/dev/null &&
  timeout 5 termux-notification-list >/dev/null 2>&1   # hangs/fails if the app is absent

# Termux:Boot — presence of its watched directory is the only shell-visible signal
test -d "$HOME/.termux/boot"
```

Note the asymmetry the spec glosses over: `pkg install termux-api` installs the
*command-line wrappers only*. Without the **Termux:API app**, every wrapper blocks or
fails. The spec's §7.3 "skipped silently" behavior must therefore be implemented as a
**short-timeout probe**, not a `command -v` check, or the watcher will hang on a phone
that has the package but not the app.

### 1.4 Android permissions and Samsung settings (all UI-only)

| Setting | Needed by | Consequence if skipped |
|---|---|---|
| Storage grant via `termux-setup-storage` | everything | `~/storage/downloads` missing → spec's `STORAGE_NOT_GRANTED` on every tool |
| **POST_NOTIFICATIONS** granted to Termux:API (Android 13+) | §7.3 notifications | Notifications silently never appear; queue still works, so this fails acceptance criterion 7 with no error anywhere |
| Battery → **Never sleeping apps** ← add Termux, Termux:API, Termux:Boot | watcher longevity | One UI kills the watcher within hours (spec §7.4 already documents this) |
| Battery → **Put unused apps to sleep** = off | watcher longevity | same |
| Battery → **Optimize battery usage** = off for Termux | watcher longevity | same |
| Device care → **Auto restart at set times** = off (or accept it) | watcher longevity | Samsung reboots the phone on a schedule; recovery then depends entirely on Termux:Boot |
| Open **Termux:Boot once** after install | reboot autostart | Android never delivers `BOOT_COMPLETED` to an app that has never been launched → acceptance criterion 8 fails |

The storage grant is also **asynchronous and non-blocking**: `termux-setup-storage`
returns immediately while the dialog is still on screen. The spec's §9 step 3 poll-for-60 s
approach is correct and should be kept; make sure it polls for the *symlink target being
readable*, not just the symlink existing.

---

## 2. Tier 1 — Termux packages (`setup.sh` can fully own this)

```sh
pkg update -y
pkg install -y nodejs-lts git termux-api termux-services ripgrep
```

| Package | Notes |
|---|---|
| `nodejs-lts` | Currently Node 22.x. **`nodejs` and `nodejs-lts` conflict** — installing one over the other fails or silently downgrades. Detect an existing `nodejs` install and either accept it (if `node -v` ≥ 20) or ask; do not blindly `pkg install nodejs-lts`. |
| `git` | Needed for §9 step 4 clone/pull. The `--from-dir` offline fallback in the spec is a good escape hatch — keep it, it is also what makes CI on an emulator image feasible. |
| `termux-api` | CLI wrappers only; see §1.3. |
| `termux-services` | Provides `sv`, `sv-enable`, `$PREFIX/var/service`. **`runsvdir` is started from the login shell profile, so a freshly installed `termux-services` is not active in the current session.** `sv-enable` will fail with "unable to change to service directory" until the shell is restarted. `setup.sh` must either restart the session or start `runsvdir` itself before `sv up`. This is exit code 14 territory and is the single most likely spurious failure on a first run. |
| `ripgrep` | Not in the spec, but see §3 — Claude Code's vendored `rg` is a known Termux breakage. |
| *(none)* | `termux-wake-lock` ships in core `termux-tools`; no extra package for §7.4. |

Mirror health is a real failure mode: if `pkg update` 404s, the fix is
`termux-change-repo`. Worth a targeted error message rather than a bare "npm failure".

**Deliberate non-prerequisite:** the spec's dependency set is `@modelcontextprotocol/sdk`
only, and all hashing uses `node:crypto`. That means **no native compilation**, so
`python`, `make`, `clang`, and `binutils` are *not* prerequisites. This is worth
protecting as an explicit project rule — the moment a dependency needs `node-gyp`,
Tier 1 grows by ~500 MB and a large class of arm64 build failures.

---

## 3. Tier 2 — Claude Code CLI (the spec's biggest gap)

Spec §9 step 7 reads:

> If `claude` is not on PATH, `npm install -g @anthropic-ai/claude-code`.

**This does not work on Termux as written**, and it is the highest-risk item in the
whole setup. Anthropic ships Claude Code as a **glibc-linked Linux ARM64 binary** with no
Android build; Termux runs on Android's **bionic** libc. Separately, npm rejects the
package with `Unsupported platform: android arm64`, and the npm distribution no longer
exposes a global `claude` bin entry.

### 3.1 The four options, and which one this project needs

| | Option | Mechanism | Cost | Verdict for the janitor |
|---|---|---|---|---|
| **A** | **Patched native binary** | Download the official linux-arm64 build, `patchelf` its ELF interpreter to point at Termux `glibc-runner`'s `ld-linux-aarch64.so.1`, install a wrapper at `$PREFIX/bin/claude` | ~233 MB binary + ~50 MB `glibc-runner`/`patchelf-glibc` | **Recommended.** Runs in the Termux filesystem namespace, so `~/storage/downloads` is directly visible, stdio MCP works, and directory walks run at full speed |
| **B** | **npm + alias** (Node path) | `npm install -g @anthropic-ai/claude-code`, then alias `claude` to `$(npm root -g)/@anthropic-ai/claude-code/cli.js` | ~300 MB, reuses the `nodejs-lts` this project already requires | Viable fallback; no third-party installer to trust. Most brittle across Claude Code releases |
| **C** | **`proot-distro` Ubuntu** | Real glibc userland inside Termux; Anthropic's official `claude.ai/install.sh` runs unmodified | ~2 GB | **Avoid for this project** — see §3.2 |
| **D** | **AVF Linux VM** (Android 16+, Pixel 6+/select S26) | Android's built-in hypervisor, Debian guest, no Termux | — | **Disqualifying.** The VM has its own filesystem and no access to `/storage/emulated/0`, so the janitor has nothing to clean |

Confirmed for options A and B: **MCP stdio transport works**. Remote HTTP works too;
OAuth-based MCP servers are the unreliable case (they depend on the Android browser
reaching a localhost callback). The janitor is stdio, so this is not a concern.

### 3.2 Why proot (option C) is the wrong choice *here* specifically

It is the most "officially supported looking" path, which makes it tempting, but it
conflicts with two of the spec's own design points:

1. **The path jail moves.** The MCP server would be spawned inside the Ubuntu rootfs, so
   `~/storage/downloads` is not visible without an explicit bind
   (`proot-distro login ubuntu --bind /storage/emulated/0:/mnt/downloads`). §5.3
   `resolveJailed()` would then have to jail against the *bind target*, and the
   config's `"root": "~/storage/downloads"` default becomes wrong. Verify the exact
   bind behaviour on-device before committing to this.
2. **proot intercepts syscalls.** Every `readdir`/`stat` is traced, which is exactly the
   workload `downloads_scan` (§6.1) and the watcher's 30 s poll (§7.1) are built from.
   Acceptance criterion 2 budgets < 10 s for ≥ 1 000 files; proot overhead eats directly
   into that budget, on top of the FUSE emulation layer already in the path.

### 3.3 Option A caveats worth knowing before you commit

- **DNS is forced to Google.** The wrapper preloads a resolver shim
  (`BUN_OPTIONS="--preload …setdns.js"`) pinning Bun's c-ares resolver to `8.8.8.8` /
  `8.8.4.4`. If you run a VPN, Pi-hole, or corporate DNS, Claude's own lookups bypass it.
- **`LD_PRELOAD` is cleared** before exec to avoid a conflict with `libtermux-exec`.
- **Android 8/10 devices fail the seccomp filter** and are pinned to an older release.
  Not a problem at the spec's Android 11+ floor.
- The installer's "recommended packages" set includes `proot-distro`, `make`, `clang`,
  `python` (~200 MB). Decline it if you want to keep the no-native-toolchain property
  from §2 — the janitor needs none of them.
- It is a **third-party installer**. It does verify the binary's SHA256 against
  Anthropic's published manifest, but the patching wrapper is community-maintained.

### 3.4 Option B caveats

- The vendored ripgrep at `vendor/ripgrep/arm64-android/rg` fails to spawn. Fix:
  `pkg install ripgrep` and `export USE_BUILTIN_RIPGREP=0` **in `~/.bashrc`**, not just
  in the current session — the variable is reported as ignored when set only in
  `settings.json`.
- The alias is shell-level, so **Claude Code launched from anywhere that is not an
  interactive bash session will not find `claude`**. Prefer a real wrapper script in
  `$PREFIX/bin/claude` over an alias.

### 3.5 What `setup.sh` should do about all this

> **Implemented.** `setup.sh` now detects and verifies rather than installing, and exits
> 15 with the option-A instructions when Claude Code is missing or non-functional.

- Change §9 step 7 from "install it" to **"detect it, verify it actually runs
  (`timeout 10 claude --version`), and if absent print the chosen path's instructions
  and exit with a dedicated code."** Bundling someone else's installer inside a janitor
  setup script means owning their upgrade treadmill.
- Add exit code **15 = Claude Code missing or non-functional**, distinct from 13
  (registration failure). Today a broken CLI surfaces as a confusing 13.
- If option C is ever chosen, that decision propagates into §5.3 `fsx.mjs` and the
  config default root, and must be recorded in the spec rather than discovered at
  implementation time.
- Verify **`claude mcp add` grammar against the installed version** before shipping. The
  spec's flag-ordering note (§9 step 8) is right in spirit; pin it to a version and
  re-check, since remove-then-add is only idempotent if both subcommands exist.

Also note: `claude mcp add --scope user` writes to `~/.claude.json` and works
unauthenticated, but the spec's step 10 smoke test (`claude mcp list` reporting
*connected*) **starts a session and therefore requires auth**. Split the smoke test into
a registration check (works offline) and a connection check (requires login), so an
unauthenticated first run reports amber, not red.

## 4. Tier 3 — Project-side prerequisites

These are things that must exist in *this repository* before `setup.sh` can succeed:

| Prerequisite | Why |
|---|---|
| `package-lock.json` committed | §9 step 5 uses `npm ci`, which **fails without a lockfile**. `npm ci` also deletes `node_modules` wholesale on every run — fine, but it makes step 5 the slowest part of an update; measure it against acceptance criterion 6's 30 s budget |
| `"engines": { "node": ">=20" }` in `package.json` | Documents the floor the spec assumes |
| Zero dependencies requiring native builds | See §2 |
| A public (or credential-reachable) git remote | §9 step 4 clones by URL; a private repo needs a PAT or SSH key on the phone, which is its own prerequisite chain. The `--from-dir` fallback sidesteps this |
| `config.example.json` present | §9 step 6 seeds user config from it |
| `.nomedia` in `Download/.janitor-trash/` | Not in the spec, but without it Android's MediaStore keeps indexing trashed files, so photos/videos still show in Gallery after a "clean" and users will report the tool as broken |

---

## 5. Tier 4 — Development and CI prerequisites

For building the project (not for running it on the phone):

- **Node ≥ 20** on the dev machine; no build step is required since the spec uses plain
  `.mjs` — no TypeScript toolchain, no bundler.
- **Test runner:** `node:test` is built in and sufficient for the §11.5 path-jail
  hostile-input corpus. No extra dependency needed.
- **The path-jail test suite must run off-device** against a temp directory, because the
  hostile inputs it needs (symlinks, `..` traversal) **cannot be created on
  `/storage/emulated/0`** — that filesystem has no symlink support. Testing the jail
  only on-device would silently skip the most important cases.
- **CI on a Termux emulator image (acceptance criterion, §9 step 11's rationale) is
  expensive**: it means an Android AVD, an APK install, and a UI-driven storage grant.
  Realistic split: run logic/jail tests in normal Linux CI; keep the emulator run as a
  manual pre-release gate, or drop it and rely on the exit codes for a scripted
  on-device check.

---

## 6. Ordering constraints that bite

The prerequisites are not a flat list — several have ordering dependencies that produce
confusing failures when violated:

1. **Termux:API app before `termux-notification`** — otherwise the call blocks rather
   than failing fast. Always probe with a timeout.
2. **`pkg install termux-services` before a shell restart before `sv-enable`** — see §2.
3. **Storage grant before `npm ci`** is *not* required, but storage grant before any
   janitor tool call is. Fail fast in `server.mjs` boot with `STORAGE_NOT_GRANTED`
   rather than at first tool call.
4. **Termux:Boot must be opened once before the boot script matters** — dropping
   `~/.termux/boot/janitor-watcher.sh` is necessary but not sufficient.
5. **Battery exemptions before believing any longevity test** — a watcher that "works"
   for ten minutes in the foreground proves nothing about acceptance criterion 8.
6. **Claude Code auth before the step 10 smoke test**, or the smoke test reports a false
   red.

---

## 7. Impact on the spec's acceptance criteria

| Criterion | Status given the above |
|---|---|
| **1** — "no manual steps besides approving the storage permission dialog" | **Not achievable.** Minimum manual steps: install Termux, install Termux:API, install Termux:Boot (all same-source), approve storage, grant notifications on Android 13+, set three Samsung battery settings, open Termux:Boot once, authenticate Claude Code. Recommend rewording to "no manual *shell* steps", with a printed checklist of the Android-UI steps and a `setup.sh --doctor` that verifies each one. |
| **7** — notification within 2 poll intervals | Depends on POST_NOTIFICATIONS (Android 13+) and on Termux:API not being background-restricted. Android 12+ background-start restrictions can make `termux-notification` fail when Termux is not foreground — needs on-device validation early, since it can invalidate the §7.3 design. |
| **8** — running after reboot | Depends on Termux:Boot installed **and opened once** **and** battery exemptions. Worth stating those as explicit preconditions of the test rather than assumptions. |
| **6** — re-run in < 30 s | `npm ci` wipes and reinstalls `node_modules` every time. Consider `npm ci` only when the lockfile hash changed, else `npm ls --omit=dev` verification. |

---

## 8. Recommended addition: `setup.sh --doctor`

Everything above is checkable from the shell. A read-only preflight that prints a
green/red table and exits non-zero on the first blocker would collapse most of this
document into one command, and gives the user something to run *before* the first
mutating step:

| Check | Command | Exit code on failure |
|---|---|---|
| Inside Termux | `case "$PREFIX" in *com.termux*)` | 10 |
| Architecture | `uname -m` = `aarch64` | 16 (new) |
| Free space on `$HOME` | `df` ≥ 2.5 GB | 17 (new) |
| Storage granted | `test -r ~/storage/downloads` | 11 |
| Node ≥ 20 | `node -v` | 12 |
| `claude` runs | `timeout 10 claude --version` | 15 (new) |
| Claude authenticated | `claude mcp list` succeeds | amber, not red |
| Termux:API app | `timeout 5 termux-notification-list` | amber (notifications degrade) |
| Termux:Boot | `test -d ~/.termux/boot` | amber (no reboot autostart) |
| `runsvdir` alive | `pgrep -f runsvdir` | 14 |

Extending the spec's §9 step 11 table with codes 15/16/17 keeps the "scriptable in CI"
property intact while making the three genuinely new failure classes distinguishable.
