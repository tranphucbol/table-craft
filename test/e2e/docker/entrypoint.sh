#!/usr/bin/env bash
# Runs a command inside the headless box: Linux node_modules into the container's own volumes, a
# virtual display with a window manager and an unlocked keyring, then the command. The host
# checkout is mounted at /work; its macOS node_modules are hidden behind volumes and never touched.
set -euo pipefail

bun install --frozen-lockfile >/tmp/bun-install.log 2>&1 || {
  cat /tmp/bun-install.log
  exit 1
}
# Electron fetches its binary on first use; done here once, since smoke workers starting together
# would race to unpack it into the same directory.
(cd packages/desktop && node -e 'require("electron")') >/tmp/electron-install.log 2>&1 || {
  cat /tmp/electron-install.log
  exit 1
}

# One virtual display per smoke worker (decision 096), `:1` to `:N`, each with its own window
# manager, so focus, keystrokes and the clipboard never cross between apps running at once.
# Workers pick theirs from VITEST_POOL_ID (display.ts); anything else draws on `:1`.
DISPLAYS="${TABLE_CRAFT_SMOKE_WORKERS:-1}"
DISPLAY_WAIT_TRIES=100
# Made up front: X servers starting together race to create it, and the loser exits.
mkdir -p -m 1777 /tmp/.X11-unix
for display in $(seq 1 "$DISPLAYS"); do
  Xvfb ":$display" -screen 0 "${TABLE_CRAFT_SCREEN:-1920x1080x24}" -nolisten tcp >"/tmp/xvfb-$display.log" 2>&1 &
done
for display in $(seq 1 "$DISPLAYS"); do
  for _ in $(seq 1 "$DISPLAY_WAIT_TRIES"); do
    [ -S "/tmp/.X11-unix/X$display" ] && break
    sleep 0.1
  done
  [ -S "/tmp/.X11-unix/X$display" ] || {
    cat "/tmp/xvfb-$display.log"
    exit 1
  }
done
export DISPLAY=:1 DISPLAYS

# Logging in with a password creates and unlocks the login keyring with no prompt (an empty one
# asks the prompter, which waits for a click that never comes); naming it the default stops
# libsecret prompting to create another. One keyring and one session bus serve every display;
# they die with the container.
read -r -d '' SESSION <<'INNER' || true
mkdir -p ~/.local/share/keyrings && printf login >~/.local/share/keyrings/default
eval "$(printf '%s' table-craft | gnome-keyring-daemon --unlock --components=secrets)"
export GNOME_KEYRING_CONTROL
for display in $(seq 1 "$DISPLAYS"); do
  DISPLAY=":$display" openbox >"/tmp/openbox-$display.log" 2>&1 &
done
exec "$@"
INNER

exec dbus-run-session -- bash -c "$SESSION" headless "$@"
