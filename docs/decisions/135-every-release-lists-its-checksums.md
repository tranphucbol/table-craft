# 135: Every release lists its checksums

Status: Accepted. Plan 128.

## Decision

Every GitHub release attaches `SHA256SUMS`: one `<sha256>  <file name>` line per other asset on
the release (installers, `update-manifest.json` and its `.sig`, plugin tarballs), sorted by name,
in the GNU coreutils text format (plan 128).

- The release job writes it with `packages/desktop/scripts/checksums.ts` after it signs the update
  manifest and before it drafts the release, from the same globs `gh release create` attaches, so
  the list cannot name a file the release lacks or miss one it has. The script skips its own output
  file and fails on an empty list, a directory, a duplicate name, or a name `sha256sum` cannot read
  back.
- A user checks a download with `sha256sum -c --ignore-missing SHA256SUMS` on Linux,
  `shasum -a 256 -c --ignore-missing SHA256SUMS` on macOS, or `Get-FileHash` on Windows
  (`docs/guide/install.md`).
- The file is not signed. It proves a download is intact, not who made it; the app's own updates
  keep trusting only the Ed25519-signed manifest (decision 044).

## Rationale

The update manifest already carries a SHA-256 for each zip, exe and AppImage, but it is JSON a
person cannot feed to a checksum tool, it leaves out the DMGs people install from by hand, and it
says nothing about the plugin tarballs. `SHA256SUMS` is the name and format Linux distributions,
Go and most GitHub projects use, so every platform's stock tool reads it with no instructions.

Hashing the exact globs the release attaches, rather than a fixed list of expected files, keeps the
file right when a best-effort Windows or Linux build is missing or a new asset kind is added.

Signing it would add a second signature users must learn to verify (`openssl pkeyutl` for Ed25519,
or a GPG key the project does not have) for little gain: the release page is served over HTTPS by
the same account that would sign it.

## Consequences

- A release has one more asset, which the release checklist in `RELEASING.md` names.
  `publish-plugins.yml` and `publish-channel.yml` download assets by pattern, so they ignore it.
- An asset replaced by hand on a published release no longer matches the list. `RELEASING.md`
  already ships a fix to a published release as the next patch rather than editing it.
- If authenticity of manual downloads becomes a requirement, sign `SHA256SUMS` with the update key
  in a later decision rather than adding a second checksum file.
