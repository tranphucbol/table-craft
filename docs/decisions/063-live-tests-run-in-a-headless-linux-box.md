# 063: Live tests run in a headless Linux box

Status: Accepted.

## Decision

The smoke and live suites (`test/e2e`) run, by default for agents and plan sessions, in a Docker
container that draws on a virtual display: `bun run test:smoke:headless` and
`bun run test:smoke:db:headless`. The host's own `test:smoke` and `test:smoke:db` stay for the
macOS-only checks and for a person who wants to watch.

The box (`test/e2e/docker/`, service `e2e` in `test/db/compose.yml` behind the `e2e` profile):

- **Linux on the host's architecture** (`node:22-bookworm`, so arm64 on Apple silicon), with
  Electron's GTK, NSS and X libraries, fonts (DejaVu, Liberation, Noto, JetBrains Mono) and
  `en_US.UTF-8` in UTC.
- **Xvfb, not Chromium's headless mode.** `xvfb-run` gives Electron a real X server; openbox gives
  it a window manager, so focus, menus and the window size behave as on a desktop. Electron's Ozone
  headless platform is experimental and not what Playwright's `_electron` drives.
- **A real keyring.** `dbus-run-session` starts a session bus; `gnome-keyring-daemon --unlock`
  creates the login keyring with a password, so `safeStorage` encrypts through libsecret
  (`--password-store=gnome-libsecret`). The basic store would report no encryption and change
  what the datasource dialogs offer.
- **Root, so `--no-sandbox`.** Chromium's sandbox refuses root; the box is the sandbox.
- **The checkout mounted at `/work`, `node_modules` in the container's own volumes.** The host's
  macOS `node_modules` are never touched; the box runs `bun install --frozen-lockfile` into its
  volumes on start. The bun and Electron download caches are shared by every checkout.
- **Databases by service name.** The box joins the compose project's network and reaches
  `postgres:5432`, `mysql:3306` and `tidb:4000` (`TABLE_CRAFT_*_HOST`/`_PORT`). The chaos proxy
  listens on the box's loopback and forwards to that host, so tests connect to `proxy.host`.

`TABLE_CRAFT_HEADLESS=1` inside the box is the harness's only switch: it adds the two Chromium
flags. Evidence PNGs land in the mounted checkout exactly as on the host.

## Rationale

A live test on the host owns the screen: windows open in front, keystrokes go to whichever window
has focus, and the clipboard is the user's. With three plan sessions running at once the user could
not work, and tests failed on foreign keystrokes and stale clipboard contents. A container with its
own X server isolates all three.

Linux under Xvfb is how CI already runs the packaged suite, and it is the setup Playwright and
Electron document. A macOS VM would keep the native chrome but costs a licence per host and
minutes per boot.

## Consequences

- **Evidence is Linux evidence.** Fonts, the title bar (no traffic lights) and native menus differ
  from macOS; a plan whose live test is about macOS chrome (`titleBar.smoke`, `update.live`, the
  packaged app) still runs on the host and says so. The box maps `system-ui` and `sans-serif` to
  Liberation Sans (`test/e2e/docker/fonts.conf`): Debian's Noto Sans has a line box tall enough
  that the Settings pages overflow at the evidence window size.
- **Memory.** Docker Desktop's VM is small (4 GB by default); Electron and its engines take about
  700 MB beside the databases, and TiDB keeps its data in memory, so the million-row
  `reconnectNamespace.smoke` fixture gets TiDB OOM-killed, on the host as in the box. Give the VM
  8 GB or more to run that suite.
- **Kernel buffers differ.** Linux autotunes socket buffers to several MB, so a result that
  stays on the wire on macOS can arrive whole. A test that strands a link mid-result needs a result
  bigger than the buffers (`hundredThousandRows`).
- **Files written by the box are owned by root** on a Linux host; Docker Desktop and OrbStack map
  them to the host user.
- The first run in a checkout installs Linux `node_modules` (about a minute); later runs reuse the
  volumes.
