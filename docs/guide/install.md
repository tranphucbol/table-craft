# Install

Installers are published on the [Releases](https://github.com/tranphucbol/table-craft/releases)
page. Once installed, TableCraft [updates itself](#updates).

| Platform              | File                                   |
| :-------------------- | :------------------------------------- |
| macOS (Apple silicon) | `TableCraft-<version>-arm64.dmg`       |
| macOS (Intel)         | `TableCraft-<version>-x64.dmg`         |
| Windows x64           | `TableCraft-<version>-x64.exe`         |
| Linux x64             | `TableCraft-<version>-x86_64.AppImage` |

The builds are not signed with a paid certificate, so the first launch needs one extra step:

- **macOS**: see [Running the unsigned macOS app](#running-the-unsigned-macos-app) below.
- **Windows**: SmartScreen says _Windows protected your PC_; click **More info**, then **Run
  anyway**.
- **Linux**: make the AppImage executable with `chmod +x TableCraft-*.AppImage` and run it.

To make sure a download arrived intact, [check it against `SHA256SUMS`](#check-a-download).

## Check a download

Every release also carries `SHA256SUMS`, the SHA-256 of each file on the release
([decision 135](../decisions/135-every-release-lists-its-checksums.md)). Download it into the
folder that holds the installer, then run, from that folder:

```sh
# macOS
shasum -a 256 -c --ignore-missing SHA256SUMS
# Linux
sha256sum -c --ignore-missing SHA256SUMS
```

Each file you downloaded prints `OK`; anything else means the download is damaged, so delete it and
download it again. On Windows, compare the output of this PowerShell command with the installer's
line in `SHA256SUMS`:

```powershell
(Get-FileHash .\TableCraft-<version>-x64.exe -Algorithm SHA256).Hash.ToLower()
```

The checksums prove a download is intact, not who made it. Updates the app installs itself are
checked against a signed manifest instead ([Updates](#updates)).

## Running the unsigned macOS app

The DMGs are ad-hoc signed rather than notarized, because a Developer ID belongs to whoever ships
the build and not to this repository
([decision 033](../decisions/033-the-packaged-app-is-dist-in-asar-with-plugins-beside-it.md)).
macOS quarantines anything a browser downloaded, and Gatekeeper refuses to open a quarantined app it
cannot verify. Depending on the macOS version it says either _“TableCraft” Not Opened. Apple could
not verify “TableCraft” is free of malware…_ or _“TableCraft” is damaged and can’t be opened_. The
app is not damaged; only the download attribute is in the way.

1. Open the DMG and drag `TableCraft.app` to `/Applications`.
2. Clear the attribute the download added:

   ```sh
   xattr -dr com.apple.quarantine /Applications/TableCraft.app
   ```

3. Open TableCraft as usual.

Nothing inside the app changes; only that attribute is removed, and only once per download.

If you would rather not use the terminal and macOS showed _Not Opened_, click **Done**, open
**System Settings → Privacy & Security**, scroll to **Security**, click **Open Anyway** next to the
message about TableCraft, and confirm with your password. That button appears only for an hour or
so after the refused launch. The _damaged_ message offers no such button; use `xattr`.

Pick the DMG that matches your Mac: `arm64` for Apple silicon, `x64` for Intel. An app you build
yourself with `bun run desktop:package` was never downloaded, so it carries no quarantine and opens
directly.

## Updates

A little after launch, and every 2 hours while it runs, TableCraft asks GitHub whether a newer release
is out. When there is one, an **Update** button appears in the main toolbar, just left of Settings;
nothing is downloaded until you click it and choose **Download**. The button shows the progress,
then turns into **Restart to Update**: TableCraft quits, puts the new version in place of the old
one and opens again. **Skip This Version** hides that release until a newer one comes out; **Later**
closes the popover and leaves the button where it is.

- **Help → Check for Updates…** asks right away, and says so when you are up to date.
- Turn off **Check for updates automatically** in Settings → Advanced to check only from Help.
- Turn on **Get beta versions** in Settings → Advanced to be offered betas (`1.16.0-beta.1`) ahead
  of each release, and pre-release plugins with them. A beta you install by hand has it on already.
  Turning it off never downgrades: you keep the beta until a newer release is out.
- Every release is described by a manifest signed with the project's key. TableCraft refuses a
  manifest whose signature does not verify and a download whose SHA-256 does not match it, deletes
  what it fetched and tells you why
  ([decision 044](../decisions/044-the-app-signs-its-own-updates.md)).
- On macOS the app replaces itself only from a folder you can write to, such as `/Applications`.
  Run from the disk image or from a folder macOS moved it to, the button explains what to do and
  links to the release instead. The same goes when macOS's **App Management** protection would stop
  the app from replacing itself: allow TableCraft in System Settings → Privacy & Security → App
  Management, or install the release by hand. If a Restart to Update still leaves the old version
  in place, the button says why on the next launch instead of offering the update as if new.
- **macOS asks for your keychain password after every update.** The app is ad-hoc signed, so each
  version looks like a different app to the keychain. Before the new version opens, macOS asks
  for your login keychain password to let it read “TableCraft Safe Storage”; enter it and choose
  **Always Allow**. **Deny** leaves passwords saved _Forever_ unreadable, so connecting asks for
  them, until you allow it at a later launch. Installing a new DMG by hand asks the same.
- On Windows the update runs the installer silently and reopens TableCraft; on Linux it replaces
  the AppImage you started.

Release `v0.1.0` predates updates: install the next release by hand once, and it keeps itself
current from then on.

## Build from source

You need [Bun](https://bun.sh) and Node; [CONTRIBUTING.md](../../CONTRIBUTING.md#set-up) names the versions and the rest of the toolchain.

```sh
bun install
bun run desktop            # build and launch the app
bun run desktop:package    # an installer for this machine in packages/desktop/release/
```
