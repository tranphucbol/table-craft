# The Linux box the smoke and live tests run in, so a run never opens a window on the developer's
# screen or takes the keyboard (plan 031). Debian 12 to match the packaged Linux target's glibc;
# native arch, so Apple silicon runs arm64 Electron without emulation.
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    TZ=UTC

# Xvfb is the display; openbox gives windows focus and activation the way a desktop does;
# gnome-keyring is the secret service `safeStorage` encrypts with, as on a Linux desktop, and
# libsecret-tools its `secret-tool`, which plan 035's import reads DataGrip passwords with. The
# libraries are what `ldd` on the Electron binary asks for, plus GTK for its dialogs and menus.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth openbox x11-utils xdotool xclip dbus dbus-x11 gnome-keyring libsecret-tools \
      libgtk-3-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libdbus-1-3 \
      libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxss1 libxtst6 \
      libxkbcommon0 libgbm1 libdrm2 libasound2 libcups2 libsecret-1-0 libnotify4 \
      locales fonts-dejavu-core fonts-liberation fonts-noto-core fonts-noto-color-emoji \
      fonts-jetbrains-mono ca-certificates unzip zip \
  && sed -i 's/^# *\(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen && locale-gen \
  && fc-cache -f \
  && rm -rf /var/lib/apt/lists/*

COPY fonts.conf /etc/fonts/local.conf
RUN fc-cache -f

# Declared here, not at the top: a build arg's value is part of the cache key of every RUN after
# it, so another Bun version rebuilds only this layer. The runner passes .bun-version's value.
ARG BUN_VERSION=1.4.4
RUN npm install -g "bun@${BUN_VERSION}"

WORKDIR /work
ENTRYPOINT ["/work/test/e2e/docker/entrypoint.sh"]
