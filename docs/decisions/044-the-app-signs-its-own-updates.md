# 044: The app signs its own updates

Status: Accepted. Amended by 134.

## Decision

TableCraft updates itself from a manifest the project signs with its own Ed25519 key, and swaps
its own files; it does not use Squirrel or `electron-updater` (plan 020).

- **Manifest**: every release carries `update-manifest.json` and `update-manifest.json.sig`, the
  base64 Ed25519 signature of the manifest's exact bytes. The manifest is
  `{ schema: 1, version, notesUrl, minimumVersion, assets }`, where `assets` maps
  `<platform>-<arch>` (`darwin-arm64`, `darwin-x64`, `win32-x64`, `linux-x64`) to
  `{ url, size, sha256 }`. Main fetches
  `https://github.com/tranphucbol/table-craft/releases/latest/download/update-manifest.json` with
  `net.fetch`, verifies the signature against the public key committed in
  `packages/desktop/src/main/update/manifest.ts` before it parses a byte, and then accepts only
  `https:` asset URLs without credentials. A download is hashed while it streams and deleted when
  its size or SHA-256 differs from the manifest.
- **Key custody**: the private key exists in two places, the maintainer's
  `~/.config/table-craft/update-signing-key.pem` (mode 600) and the GitHub secret
  `TABLE_CRAFT_UPDATE_SIGNING_KEY`, stored in the `release` environment with required reviewers.
  Only the release job reads it, through `packages/desktop/scripts/update-manifest.ts`, which
  signs, verifies the signature against the committed public key before writing, and refuses to
  run in an update test build. The key is never committed, uploaded elsewhere or logged.
- **Install**: macOS downloads the release zip, expands it with `ditto -x -k` into
  `.table-craft-update-<id>` beside the bundle and, after the app quits, a detached `/bin/sh`
  script waits for the old process, moves the bundle aside, moves the new one in, restores the old
  one if the new one is missing its executable, strips the quarantine attribute and starts the new
  executable with the arguments the old one had. Windows runs the NSIS installer with
  `/S --updated --force-run`; Linux downloads the AppImage beside `$APPIMAGE` and renames it over
  the old one.
- **Eligibility**: only a packaged app replaces itself, and on macOS only from a writable folder
  that is neither a mounted disk image nor App Translocation. Otherwise the Update button explains
  why and links to the release.
- **Testing**: a build made with `TABLE_CRAFT_UPDATE_TEST_BUILD=1` is a different product
  ("TableCraft Update Test": its own bundle, profile and keychain item) and is the only packaged
  build that honours `TABLE_CRAFT_UPDATE_MANIFEST_URL`, `TABLE_CRAFT_UPDATE_PUBLIC_KEY` and
  `TABLE_CRAFT_UPDATE_FIRST_CHECK_MS`. The flag is a compile-time constant, so a release build
  carries no code path that reads them; development runs honour them too.

## Rationale

Squirrel.Mac installs only updates signed by the same Developer ID as the running app, and
TableCraft is ad-hoc signed (decision 033): there is no stable identity for Squirrel to compare.
`electron-updater` on macOS goes through Squirrel and inherits the limit. GitHub's TLS proves where
a file came from, not who built it; a signature checked against a key in the app does, and it stays
valid if the files ever move to another host. Ed25519 is in `node:crypto`, so the verifier adds no
dependency. A shell script is the smallest thing that can replace a bundle after the process that
holds it has exited.

## Consequences

- The private key is the root of distribution: whoever holds it can ship code to every install.
  Losing it means a release that changes the committed public key, installed by hand.
- `releases/latest/download/` resolves only a published release, so a draft release reaches no
  install until it is published. Release `v0.1.0` has no manifest and no updater; the first
  install that updates itself is the next release.
- macOS ties a keychain item's access list to the code hash of an ad-hoc signed app, so after
  every update, in-app or by hand, macOS asks for the login keychain password before the new
  version can read "TableCraft Safe Storage", and the app waits on that prompt at startup (plan 020,
  live test scenario 9). A Developer ID would end it; that is a separate decision.
- The swap writes `update-swap.log` in the profile; the next launch logs its lines under scope
  `update` and deletes it. `update-state.json` remembers the skipped version.
