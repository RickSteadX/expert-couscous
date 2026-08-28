#!/usr/bin/env bash
#
# termux-mcp-janitor — one-script install, update, doctor and uninstall.
#
# Safe to run repeatedly: the first run installs, later runs refresh only what changed.
#
#   ./setup.sh                 install or update
#   ./setup.sh --doctor        read-only preflight, changes nothing
#   ./setup.sh --from-dir DIR  install from a local tree instead of cloning (offline)
#   ./setup.sh --uninstall     unregister and remove the service, keeping config and data
#
# Exit codes (spec §9.11, extended per docs/PREREQUISITES.md §8):
#   0  success
#   10 not running inside Termux
#   11 shared storage not granted
#   12 Node.js / npm failure
#   13 Claude Code MCP registration failure
#   14 watcher service failure
#   15 Claude Code CLI missing or non-functional
#   16 unsupported CPU architecture
#   17 insufficient free space
#   64 bad usage
#   78 invalid configuration

set -o errexit
set -o nounset
set -o pipefail

readonly MIN_NODE_MAJOR=20
readonly MIN_FREE_MB=2500
readonly PROJECT_DIR="${JANITOR_DIR:-$HOME/janitor-mcp}"
readonly REPO_URL="${JANITOR_REPO:-https://github.com/RickSteadX/expert-couscous.git}"
readonly SERVICE_NAME="janitor-watcher"
readonly MCP_NAME="janitor"
readonly STATE_DIR="${JANITOR_STATE_DIR:-$HOME/.local/state/janitor-mcp}"
readonly CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/janitor-mcp"
readonly CONFIG_FILE="$CONFIG_DIR/config.json"

FROM_DIR=""

# --- output helpers -----------------------------------------------------------
# Colour only when stdout is a terminal, so piping into a log stays readable.
if [ -t 1 ]; then
  C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_GREEN=''; C_RED=''; C_YELLOW=''; C_DIM=''; C_OFF=''
fi

fail_code=0     # first blocking exit code seen
warn_count=0

pass() { printf '  %s✓%s %-34s %s\n' "$C_GREEN" "$C_OFF" "$1" "${2-}"; }
warn() { printf '  %s!%s %-34s %s\n' "$C_YELLOW" "$C_OFF" "$1" "${2-}"; warn_count=$((warn_count + 1)); }
fail() {
  printf '  %s✗%s %-34s %s\n' "$C_RED" "$C_OFF" "$1" "${2-}"
  [ "$fail_code" -eq 0 ] && fail_code="$3"
  return 0
}
hint() { printf '      %s%s%s\n' "$C_DIM" "$1" "$C_OFF"; }
section() { printf '\n%s\n' "$1"; }

# --- individual checks --------------------------------------------------------

check_termux() {
  case "${PREFIX:-}" in
    *com.termux*) pass "Termux environment" "$PREFIX" ;;
    *)
      fail "Termux environment" "\$PREFIX does not contain com.termux" 10
      hint "This script only runs inside Termux (F-Droid or GitHub build)."
      ;;
  esac
}

check_arch() {
  local arch
  arch="$(uname -m)"
  if [ "$arch" = "aarch64" ]; then
    pass "CPU architecture" "$arch"
  else
    fail "CPU architecture" "$arch (need aarch64)" 16
    hint "Claude Code ships arm64 builds only; 32-bit ARM has no working path."
  fi
}

check_android_version() {
  local rel
  rel="$(getprop ro.build.version.release 2>/dev/null || echo unknown)"
  case "$rel" in
    unknown) warn "Android version" "could not read ro.build.version.release" ;;
    [0-9]|10)
      warn "Android version" "$rel (spec targets 11+)"
      hint "Android 8/10 fail the native binary's seccomp filter and are pinned to an older Claude Code."
      ;;
    *) pass "Android version" "$rel" ;;
  esac
}

check_free_space() {
  local avail_mb
  # POSIX -P output: Filesystem 1024-blocks Used Available Capacity Mounted
  avail_mb="$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print int($4/1024)}')"
  if [ -z "$avail_mb" ]; then
    warn "Free space on \$HOME" "could not determine"
  elif [ "$avail_mb" -lt "$MIN_FREE_MB" ]; then
    fail "Free space on \$HOME" "${avail_mb} MB free, need ${MIN_FREE_MB} MB" 17
    hint "Node + npm cache + the patched Claude Code binary need roughly 2.5 GB."
  else
    pass "Free space on \$HOME" "${avail_mb} MB"
  fi
}

check_storage_grant() {
  local link="$HOME/storage/downloads"
  if [ ! -e "$link" ]; then
    fail "Shared storage granted" "$link is missing" 11
    hint "Run 'termux-setup-storage' and approve the Android permission dialog."
    return
  fi
  if [ ! -r "$link" ]; then
    fail "Shared storage granted" "$link exists but is not readable" 11
    hint "The grant may have been revoked; re-run 'termux-setup-storage'."
    return
  fi
  local target
  target="$(readlink -f "$link" 2>/dev/null || echo "$link")"
  pass "Shared storage granted" "-> $target"
  case "$target" in
    /storage/emulated/0/*) : ;;
    *) hint "Note: not under /storage/emulated/0 — a secondary profile or Secure Folder changes the jail root." ;;
  esac
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    fail "Node.js >= ${MIN_NODE_MAJOR}" "not installed" 12
    hint "pkg install nodejs-lts"
    return
  fi
  local version major
  version="$(node -v 2>/dev/null)"
  major="${version#v}"; major="${major%%.*}"
  if [ "${major:-0}" -lt "$MIN_NODE_MAJOR" ]; then
    fail "Node.js >= ${MIN_NODE_MAJOR}" "$version" 12
    hint "pkg install nodejs-lts  (note: 'nodejs' and 'nodejs-lts' conflict — remove one first)"
  else
    pass "Node.js >= ${MIN_NODE_MAJOR}" "$version"
  fi
}

check_claude_cli() {
  if ! command -v claude >/dev/null 2>&1; then
    fail "Claude Code CLI" "'claude' not on PATH" 15
    hint "Termux needs a patched build: see docs/PREREQUISITES.md §3 (option A)."
    return
  fi
  local version
  if version="$(timeout 20 claude --version 2>/dev/null)"; then
    pass "Claude Code CLI" "$version"
  else
    fail "Claude Code CLI" "'claude --version' did not succeed" 15
    hint "A plain 'npm install -g' does not produce a working binary on Android; see docs/PREREQUISITES.md §3."
  fi
}

check_claude_auth() {
  # Amber, never red: registration works unauthenticated, only the connection test needs a login.
  if ! command -v claude >/dev/null 2>&1; then
    warn "Claude Code authenticated" "skipped (no CLI)"
    return
  fi
  if timeout 30 claude mcp list >/dev/null 2>&1; then
    pass "Claude Code authenticated" "mcp list responds"
  else
    warn "Claude Code authenticated" "'claude mcp list' failed"
    hint "Run 'claude' once to log in, or export ANTHROPIC_API_KEY."
  fi
}

check_mcp_registration() {
  if ! command -v claude >/dev/null 2>&1; then
    warn "janitor registered with Claude" "skipped (no CLI)"
    return
  fi
  if timeout 30 claude mcp get janitor >/dev/null 2>&1; then
    pass "janitor registered with Claude" "user scope"
  else
    warn "janitor registered with Claude" "not registered yet"
    hint "Registration happens during install; re-run setup.sh once implemented."
  fi
}

check_termux_api() {
  if ! command -v termux-notification >/dev/null 2>&1; then
    warn "Termux:API" "'termux-api' package not installed"
    hint "pkg install termux-api  — and install the Termux:API *app* from the same source as Termux."
    return
  fi
  # The package alone is not enough: without the companion app the wrappers block
  # rather than fail, so probe with a timeout instead of using command -v as proof.
  if timeout 5 termux-notification-list >/dev/null 2>&1; then
    pass "Termux:API" "package and app both present"
  else
    warn "Termux:API" "package present, app not responding"
    hint "Install the Termux:API app from the SAME source as Termux (F-Droid and GitHub builds"
    hint "have different signing keys). Without it, watcher notifications are silently skipped."
  fi
}

check_termux_boot() {
  if [ -d "$HOME/.termux/boot" ]; then
    pass "Termux:Boot" "$HOME/.termux/boot exists"
  else
    warn "Termux:Boot" "not installed"
    hint "Without it the watcher does not survive a reboot. Install the app, then OPEN IT ONCE —"
    hint "Android never delivers BOOT_COMPLETED to an app that has never been launched."
  fi
}

check_runsvdir() {
  if ! command -v sv >/dev/null 2>&1; then
    warn "termux-services" "not installed"
    hint "pkg install termux-services"
    return
  fi
  if pgrep -f runsvdir >/dev/null 2>&1; then
    pass "termux-services" "runsvdir is running"
  else
    fail "termux-services" "runsvdir is not running" 14
    hint "termux-services starts runsvdir from the login profile. Restart Termux (fully close"
    hint "and reopen the session) after installing it, or sv-enable will fail with"
    hint "'unable to change to service directory'."
  fi
}

check_watcher_service() {
  if ! command -v sv >/dev/null 2>&1; then
    return
  fi
  local status
  if status="$(timeout 10 sv status janitor-watcher 2>&1)"; then
    pass "janitor-watcher service" "$status"
  else
    warn "janitor-watcher service" "not enabled yet"
  fi
}

check_project() {
  if [ -d "$PROJECT_DIR" ]; then
    pass "Project directory" "$PROJECT_DIR"
  else
    warn "Project directory" "$PROJECT_DIR not present"
    return
  fi
  if [ -f "$PROJECT_DIR/package-lock.json" ]; then
    pass "Lockfile" "package-lock.json present"
  else
    warn "Lockfile" "missing — 'npm ci' will fail"
  fi
  if [ -d "$PROJECT_DIR/node_modules" ]; then
    pass "Dependencies installed" "node_modules present"
  else
    warn "Dependencies installed" "run 'npm ci --omit=dev'"
  fi
}

check_config() {
  local cfg="${JANITOR_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/janitor-mcp/config.json}"
  if [ ! -f "$cfg" ]; then
    warn "Configuration" "$cfg not created yet"
    hint "Install copies config.example.json here; it is never overwritten on update."
    return
  fi
  if command -v node >/dev/null 2>&1 && node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$cfg" 2>/dev/null; then
    pass "Configuration" "$cfg"
  else
    fail "Configuration" "$cfg is not valid JSON" 78
  fi
}

check_battery_reminder() {
  section "Manual Android steps (cannot be verified from a shell)"
  cat <<'EOT'
      These are the steps no script can perform or confirm. On Samsung One UI:
        - Settings > Battery > Background usage limits > Never sleeping apps
            add Termux, Termux:API, Termux:Boot
        - Settings > Battery > turn OFF "Put unused apps to sleep"
        - Settings > Apps > Termux:API > Notifications > allow (Android 13+)
        - Open the Termux:Boot app once after installing it
      Without these the watcher is killed within hours and reboot autostart never fires.
EOT
}

# --- doctor -------------------------------------------------------------------

doctor() {
  printf '%stermux-mcp-janitor doctor%s\n' "$C_DIM" "$C_OFF"

  section "Device"
  check_termux
  check_arch
  check_android_version
  check_free_space
  check_storage_grant

  section "Runtime"
  check_node
  check_claude_cli
  check_claude_auth

  section "Project"
  check_project
  check_config
  check_mcp_registration

  section "Watcher"
  check_termux_api
  check_termux_boot
  check_runsvdir
  check_watcher_service

  check_battery_reminder

  section "Summary"
  if [ "$fail_code" -ne 0 ]; then
    printf '  %sBlocked%s — fix the ✗ items above, then re-run. (exit %d)\n\n' "$C_RED" "$C_OFF" "$fail_code"
    return "$fail_code"
  fi
  if [ "$warn_count" -gt 0 ]; then
    printf '  %sReady with %d warning(s)%s — the ! items degrade features but do not block setup.\n\n' \
      "$C_YELLOW" "$warn_count" "$C_OFF"
    return 0
  fi
  printf '  %sAll checks passed.%s\n\n' "$C_GREEN" "$C_OFF"
  return 0
}

# --- install / update ---------------------------------------------------------

step() { printf '\n%s==>%s %s\n' "$C_GREEN" "$C_OFF" "$1"; }
die() {
  printf '\n  %s✗ %s%s\n' "$C_RED" "$1" "$C_OFF" >&2
  shift
  while [ "$#" -gt 1 ]; do
    printf '      %s\n' "$1" >&2
    shift
  done
  exit "$1"
}

require_termux() {
  case "${PREFIX:-}" in
    *com.termux*) : ;;
    *) die "This script only runs inside Termux." \
           "Install Termux from F-Droid or GitHub releases (not the Play Store build)." 10 ;;
  esac
  [ "$(uname -m)" = "aarch64" ] || die "Unsupported architecture: $(uname -m)." \
    "Claude Code ships arm64 builds only." 16
}

install_packages() {
  step "Packages"
  # A stale mirror is a common and confusing failure, so name the fix rather than
  # letting apt's own error stand alone.
  if ! pkg update -y >/dev/null 2>&1; then
    printf '  %s!%s pkg update failed — if this persists, run: termux-change-repo\n' "$C_YELLOW" "$C_OFF"
  fi
  local wanted="git termux-api termux-services ripgrep"
  # nodejs and nodejs-lts conflict; if a new-enough node is already here, leave it alone.
  if command -v node >/dev/null 2>&1 && [ "$(node -v | sed 's/^v//; s/\..*//')" -ge "$MIN_NODE_MAJOR" ]; then
    pass "Node.js" "$(node -v) already installed"
  else
    wanted="nodejs-lts $wanted"
  fi
  # shellcheck disable=SC2086
  pkg install -y $wanted >/dev/null 2>&1 || die "pkg install failed." "Tried: $wanted" 12
  command -v node >/dev/null 2>&1 || die "Node.js is still not on PATH after install." "" 12
  pass "Packages" "node $(node -v), git, termux-api, termux-services"
}

ensure_storage() {
  step "Shared storage"
  if [ -r "$HOME/storage/downloads" ]; then
    pass "Storage grant" "already granted"
    return
  fi
  printf '  Requesting the storage permission — approve the Android dialog.\n'
  termux-setup-storage || true
  # termux-setup-storage returns immediately while the dialog is still up, so poll.
  local waited=0
  while [ ! -r "$HOME/storage/downloads" ] && [ "$waited" -lt 60 ]; do
    sleep 2
    waited=$((waited + 2))
  done
  [ -r "$HOME/storage/downloads" ] || die "Storage permission was not granted within 60s." \
    "Run 'termux-setup-storage' manually and approve the dialog, then re-run this script." 11
  pass "Storage grant" "-> $(readlink -f "$HOME/storage/downloads")"
}

fetch_code() {
  step "Project code"
  local script_dir
  script_dir="$(cd "$(dirname "$0")" && pwd)"

  if [ "$script_dir" = "$PROJECT_DIR" ]; then
    pass "Source" "running from $PROJECT_DIR, nothing to fetch"
  elif [ -n "$FROM_DIR" ]; then
    [ -d "$FROM_DIR" ] || die "--from-dir path does not exist: $FROM_DIR" "" 64
    mkdir -p "$PROJECT_DIR"
    # cp rather than rsync: rsync is not installed by default in Termux.
    (cd "$FROM_DIR" && tar --exclude=node_modules --exclude=.git -cf - .) | (cd "$PROJECT_DIR" && tar -xf -)
    pass "Source" "copied from $FROM_DIR"
  elif [ -d "$PROJECT_DIR/.git" ]; then
    git -C "$PROJECT_DIR" pull --ff-only >/dev/null 2>&1 ||
      printf '  %s!%s git pull failed (local changes?); keeping the existing checkout\n' "$C_YELLOW" "$C_OFF"
    pass "Source" "updated $PROJECT_DIR"
  else
    git clone --depth 1 "$REPO_URL" "$PROJECT_DIR" >/dev/null 2>&1 ||
      die "git clone failed: $REPO_URL" "Set JANITOR_REPO, or use --from-dir for an offline install." 12
    pass "Source" "cloned into $PROJECT_DIR"
  fi
  [ -f "$PROJECT_DIR/package.json" ] || die "No package.json in $PROJECT_DIR." "" 12
}

install_deps() {
  step "Dependencies"
  [ -f "$PROJECT_DIR/package-lock.json" ] || die "package-lock.json is missing; npm ci cannot run." "" 12

  # npm ci wipes and reinstalls node_modules every time, which is the slowest part of an
  # update. Skip it when the lockfile has not moved since the last successful install.
  local stamp="$STATE_DIR/deps.sha"
  local current
  current="$(sha256sum "$PROJECT_DIR/package-lock.json" | cut -d' ' -f1)"
  if [ -d "$PROJECT_DIR/node_modules" ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$current" ]; then
    pass "Dependencies" "unchanged, skipping npm ci"
    return
  fi
  (cd "$PROJECT_DIR" && npm ci --omit=dev >/dev/null 2>&1) || die "npm ci failed." "Run it manually in $PROJECT_DIR to see why." 12
  mkdir -p "$STATE_DIR"
  printf '%s' "$current" > "$stamp"
  pass "Dependencies" "npm ci --omit=dev"
}

install_config() {
  step "Configuration"
  mkdir -p "$CONFIG_DIR" "$STATE_DIR"
  if [ -f "$CONFIG_FILE" ]; then
    pass "Config" "$CONFIG_FILE kept (never overwritten on update)"
  else
    cp "$PROJECT_DIR/config.example.json" "$CONFIG_FILE"
    pass "Config" "created $CONFIG_FILE"
  fi
  node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$CONFIG_FILE" 2>/dev/null ||
    die "$CONFIG_FILE is not valid JSON." "" 78
}

require_claude() {
  step "Claude Code"
  # Deliberately detect rather than install: a plain `npm install -g` does not produce a
  # working CLI on Android, and bundling someone else's installer here would mean owning
  # their upgrade treadmill. See docs/PREREQUISITES.md §3.
  if ! command -v claude >/dev/null 2>&1 || ! timeout 20 claude --version >/dev/null 2>&1; then
    die "Claude Code is not installed, or 'claude --version' does not work." \
      "A plain 'npm install -g @anthropic-ai/claude-code' does NOT work on Termux:" \
      "Anthropic ships a glibc-linked binary and Termux runs on bionic." \
      "" \
      "Recommended (patched native binary):" \
      "  curl -fsSL https://raw.githubusercontent.com/ferrumclaudepilgrim/claude-code-android/main/install.sh -o install.sh" \
      "  bash install.sh" \
      "" \
      "See docs/PREREQUISITES.md §3 for the alternatives and their trade-offs." 15
  fi
  pass "Claude Code" "$(claude --version 2>/dev/null)"
}

register_mcp() {
  step "MCP registration"
  # Remove-then-add keeps re-runs idempotent. Absolute paths because Claude Code launches
  # MCP subprocesses with a different environment than the interactive shell.
  claude mcp remove "$MCP_NAME" --scope user >/dev/null 2>&1 || true
  claude mcp add --scope user --transport stdio "$MCP_NAME" -- \
    node "$PROJECT_DIR/src/server.mjs" >/dev/null 2>&1 ||
    die "Could not register the MCP server with Claude Code." \
      "Try manually: claude mcp add --scope user --transport stdio janitor -- node $PROJECT_DIR/src/server.mjs" 13
  pass "Registered" "$MCP_NAME (user scope)"
}

ensure_runsvdir() {
  if pgrep -f runsvdir >/dev/null 2>&1; then
    return 0
  fi
  # termux-services starts runsvdir from the login profile, so it is not running in the
  # session that just installed it. Start it here rather than telling the user to
  # restart Termux mid-install.
  if [ -f "$PREFIX/etc/profile.d/start-services.sh" ]; then
    # shellcheck disable=SC1091
    . "$PREFIX/etc/profile.d/start-services.sh" >/dev/null 2>&1 || true
  fi
  if ! pgrep -f runsvdir >/dev/null 2>&1; then
    nohup runsvdir "$PREFIX/var/service" >/dev/null 2>&1 &
    sleep 2
  fi
  pgrep -f runsvdir >/dev/null 2>&1
}

install_service() {
  step "Watcher service"
  local service_dir="$PREFIX/var/service/$SERVICE_NAME"
  mkdir -p "$service_dir/log"

  cat > "$service_dir/run" <<EOF
#!$PREFIX/bin/sh
exec 2>&1
exec node "$PROJECT_DIR/src/watcher.mjs"
EOF
  chmod +x "$service_dir/run"

  # Without a log service, runit's output goes nowhere; the watcher logs to its own file
  # anyway, so this just keeps runsv from blocking on a full pipe.
  cat > "$service_dir/log/run" <<EOF
#!$PREFIX/bin/sh
exec cat > /dev/null
EOF
  chmod +x "$service_dir/log/run"

  # A fresh service directory defaults to "up"; down-then-up makes a re-run restart it.
  if ! ensure_runsvdir; then
    printf '  %s!%s runsvdir could not be started — fully close and reopen Termux, then re-run.\n' "$C_YELLOW" "$C_OFF"
    return 0
  fi
  sv-enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  sv down "$SERVICE_NAME" >/dev/null 2>&1 || true
  sv up "$SERVICE_NAME" >/dev/null 2>&1 ||
    die "Could not start the $SERVICE_NAME service." "Check: sv status $SERVICE_NAME" 14
  pass "Service" "$(sv status "$SERVICE_NAME" 2>&1 || echo 'started')"
}

install_boot_script() {
  step "Reboot autostart"
  mkdir -p "$HOME/.termux/boot"
  cat > "$HOME/.termux/boot/janitor-watcher.sh" <<EOF
#!$PREFIX/bin/sh
termux-wake-lock
. \$PREFIX/etc/profile.d/start-services.sh
sv up $SERVICE_NAME
EOF
  chmod +x "$HOME/.termux/boot/janitor-watcher.sh"
  pass "Boot script" "$HOME/.termux/boot/janitor-watcher.sh"
  printf '      %sInstall the Termux:Boot app and OPEN IT ONCE — Android never delivers%s\n' "$C_DIM" "$C_OFF"
  printf '      %sBOOT_COMPLETED to an app that has never been launched.%s\n' "$C_DIM" "$C_OFF"
}

smoke_test() {
  step "Smoke test"
  local failures=0

  # 1. The server answers a piped initialize request with a valid JSON-RPC frame.
  local response
  response="$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"setup","version":"0"}}}' |
    timeout 20 node "$PROJECT_DIR/src/server.mjs" 2>/dev/null | head -n 1 || true)"
  case "$response" in
    *'"serverInfo"'*'janitor-mcp'*) pass "Server handshake" "initialize answered" ;;
    *) fail "Server handshake" "no valid initialize response" 13; failures=$((failures + 1)) ;;
  esac

  # 2. One watcher poll completes without error.
  if timeout 30 node "$PROJECT_DIR/src/watcher.mjs" --once >/dev/null 2>&1; then
    pass "Watcher poll" "completed"
  else
    warn "Watcher poll" "single poll failed — check $STATE_DIR/janitor.log"
  fi

  # 3. Claude Code sees the registration. Needs auth, so amber rather than red.
  if timeout 40 claude mcp list 2>/dev/null | grep -q "$MCP_NAME"; then
    pass "claude mcp list" "$MCP_NAME present"
  else
    warn "claude mcp list" "janitor not listed (are you logged in? run 'claude' once)"
  fi

  # 4. The service is actually up.
  if sv status "$SERVICE_NAME" 2>/dev/null | grep -q '^run'; then
    pass "Service running" "$SERVICE_NAME"
  else
    warn "Service running" "$SERVICE_NAME is not in 'run' state"
  fi

  [ "$failures" -eq 0 ]
}

do_install() {
  require_termux
  check_free_space
  [ "$fail_code" -eq 0 ] || die "Not enough free space to continue." "" "$fail_code"

  install_packages
  ensure_storage
  fetch_code
  install_deps
  install_config
  require_claude
  register_mcp
  install_service
  install_boot_script

  if smoke_test; then
    section "Done"
    printf '  %sInstalled.%s Open Claude Code and try: "what is clogging my downloads folder?"\n' "$C_GREEN" "$C_OFF"
  else
    section "Done with problems"
    printf '  %sSome checks failed above.%s Run ./setup.sh --doctor for a full diagnosis.\n' "$C_YELLOW" "$C_OFF"
  fi
  check_battery_reminder
  printf '\n'
}

do_uninstall() {
  require_termux
  step "Uninstalling"
  # User data and config are deliberately left in place: the trash may hold files the
  # user still wants, and a reinstall should not lose their protect patterns.
  claude mcp remove "$MCP_NAME" --scope user >/dev/null 2>&1 && pass "Unregistered" "$MCP_NAME" ||
    warn "Unregistered" "$MCP_NAME was not registered"

  if command -v sv >/dev/null 2>&1; then
    sv down "$SERVICE_NAME" >/dev/null 2>&1 || true
    sv-disable "$SERVICE_NAME" >/dev/null 2>&1 || true
  fi
  rm -rf "$PREFIX/var/service/$SERVICE_NAME"
  pass "Service removed" "$SERVICE_NAME"

  rm -f "$HOME/.termux/boot/janitor-watcher.sh"
  pass "Boot script removed" ""

  section "Kept"
  printf '      %s  (config)\n' "$CONFIG_FILE"
  printf '      %s  (logs, event queue, manifests)\n' "$STATE_DIR"
  printf '      %s  (project code — delete it yourself if you want it gone)\n' "$PROJECT_DIR"
  printf '      Download/.janitor-trash  (trashed files, never touched by uninstall)\n\n'
}

usage() {
  cat <<'EOT'
Usage: setup.sh [--doctor | --uninstall | --from-dir DIR] [--help]

  (no arguments)    Install, or update an existing install. Idempotent.
  --doctor          Read-only preflight: verify every prerequisite, change nothing.
  --from-dir DIR    Install from a local directory instead of cloning (offline).
  --uninstall       Unregister from Claude Code and remove the watcher service.
                    Config, logs and the trash are kept.
  --help            This message.

Environment:
  JANITOR_DIR       Install location (default: ~/janitor-mcp)
  JANITOR_REPO      Git remote to clone from
EOT
}

main() {
  case "${1:-}" in
    --doctor) doctor ;;
    --uninstall) do_uninstall ;;
    --help|-h) usage ;;
    --from-dir)
      [ "$#" -ge 2 ] || { printf 'error: --from-dir needs a path\n\n' >&2; usage >&2; exit 64; }
      FROM_DIR="$2"
      do_install
      ;;
    '') do_install ;;
    *)
      printf 'Unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 64
      ;;
  esac
}

main "$@"
