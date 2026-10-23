#!/usr/bin/env bash
# Runs a command inside the headless box: Linux node_modules into the container's own volumes, a
# virtual display with a window manager and an unlocked keyring, then the command. The host
# checkout is mounted at /work; its macOS node_modules are hidden behind volumes and never touched.
set -euo pipefail

bun install --frozen-lockfile >/tmp/bun-install.log 2>&1 || {
  cat /tmp/bun-install.log
  exit 1
}

# Logging in with a password creates and unlocks the login keyring with no prompt (an empty one
# asks the prompter, which waits for a click that never comes); naming it the default stops
# libsecret prompting to create another. The keyring dies with the container.
read -r -d '' SESSION <<'INNER' || true
mkdir -p ~/.local/share/keyrings && printf login >~/.local/share/keyrings/default
eval "$(printf '%s' table-craft | gnome-keyring-daemon --unlock --components=secrets)"
export GNOME_KEYRING_CONTROL
openbox >/tmp/openbox.log 2>&1 &
exec "$@"
INNER

exec xvfb-run --auto-servernum --server-args="-screen 0 ${TABLE_CRAFT_SCREEN:-1920x1080x24} -nolisten tcp" \
  dbus-run-session -- bash -c "$SESSION" headless "$@"
