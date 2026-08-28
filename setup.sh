#!/usr/bin/env bash
#
# termux-mcp-janitor — setup / update / doctor
#
# Currently implemented: --doctor, a read-only preflight that verifies every
# prerequisite from docs/PREREQUISITES.md without changing anything on the device.
# The install path (steps 2-10 of spec §9) lands next.
#
# Exit codes (spec §9.11, extended per docs/PREREQUISITES.md §8):
#   0  success
#   10 not running inside Termux
#   11 shared storage not granted
#   12 Node.js missing or too old
#   13 Claude Code MCP registration failure
#   14 watcher service failure (runsvdir not running)
#   15 Claude Code CLI missing or non-functional
#   16 unsupported CPU architecture
#   17 insufficient free space
#   78 invalid configuration

set -o errexit
set -o nounset
set -o pipefail

readonly MIN_NODE_MAJOR=20
readonly MIN_FREE_MB=2500
readonly PROJECT_DIR="${JANITOR_DIR:-$HOME/janitor-mcp}"

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

usage() {
  cat <<'EOT'
Usage: setup.sh [--doctor] [--help]

  --doctor    Read-only preflight: verify every prerequisite, change nothing.
  --help      This message.

Running setup.sh with no arguments currently runs --doctor. The install and update
path (spec §9 steps 2-10) is not implemented yet.
EOT
}

main() {
  case "${1:---doctor}" in
    --doctor|'') doctor ;;
    --help|-h) usage ;;
    *)
      printf 'Unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 64
      ;;
  esac
}

main "$@"
