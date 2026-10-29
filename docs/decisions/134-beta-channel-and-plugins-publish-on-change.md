# 134: A beta channel, and plugins publish only when they change

Status: Accepted. Plan 124. Amends 044 and 109.

## Decision

**Betas.** A beta is an annotated `vX.Y.Z-beta.N` tag on `main` (N from 1). It is a semver
pre-release, so `1.16.0-beta.2 < 1.16.0` and the stable release replaces it with no special case.
Only `beta` is accepted; `rc`, `alpha` and the like build as `0.0.0-dev.<sha>`.

- `packages/desktop/scripts/version.ts` accepts beta tags. When `HEAD` carries a stable tag and a
  beta tag (a beta promoted unchanged), the stable tag wins; two tags of the same kind still stop
  the build.
- CI drafts a beta release with `--prerelease`. A beta's generated notes start at the previous tag
  of either kind, a stable release's at the previous stable tag.
- `api:check` compares with the last stable tag (decision 107), and a beta never publishes
  `@tablecraft-app/plugin-api`: an API minor added in a beta must not become npm's `latest` before
  the stable release that freezes it.

**Where the manifests live (amends 044).** The signed manifest gains `channel: "stable" | "beta"`;
a missing channel means stable, so `MANIFEST_SCHEMA` stays 1. The stable manifest stays at
`releases/latest/download/`, which skips pre-releases. Publishing a beta runs
`.github/workflows/publish-channel.yml`, which commits the beta's manifest and signature to `beta/`
on the orphan branch `update-channels`; the app reads it from `raw.githubusercontent.com`. The
workflow refuses a manifest whose version is below the one already there.

**The setting.** `updates.channel` is `"auto"`, `"stable"` or `"beta"`, default `"auto"`: the kind
of build that is running, so a beta installed by hand follows beta. Settings → Advanced shows it as
**Get beta versions**. On the beta channel the updater fetches both manifests and offers the higher
version; a failing beta manifest only logs a warning when the stable one answers. On the stable
channel it fetches only the stable manifest and ignores a manifest signed for another channel.
Leaving the beta channel never downgrades: the app waits for a stable release above it.

**Plugins follow the channel.** On the beta channel the plugin store also picks `X.Y.Z-beta.N`
plugin versions. On the stable channel an installed beta plugin stays until a stable version above
it exists, unless it no longer fits the host's plugin API.

**Plugins publish on change (amends 109).** A plugin's version is the release at which its bytes
last changed, not every release. Before a tag build packs, `scripts/plugins/pack.ts
--reuse-published` fingerprints each plugin (sha256 over its files sorted by path, with `version`
removed from `package.json` and `table-craft-plugin.json`) and compares it with a baseline on npm:
the newest stable version for a stable release, the newest of any kind for a beta. A match puts
that exact npm tarball into `dist/plugin-packages/`, so the release attaches it and the publish step
skips it as already published; a difference packs a new version at the release's version. The
notes say `unchanged, still X` for a reused plugin. On a tag, an unreachable registry fails the
pack; on a branch it warns and packs everything. There is no force-publish override.

## Rationale

A beta has to reach the people who ask for it without reaching anyone else, and without using up
version numbers. A semver pre-release tag gives both, and keeps one ordering rule for the app, the
plugins and npm.

The beta manifest needs a stable URL that GitHub's `latest` does not shadow. A branch in the same
repository needs no new host or secret beyond the workflow's `contents: write`, and the Ed25519
signature, not the host, is what the app trusts. Putting the channel inside the signed body means a
beta manifest copied to the stable URL cannot reach a stable-channel app.

`"auto"` makes a beta someone installed by hand keep updating as a beta, and a stable install stay
stable, without the user finding the setting first.

Republishing identical plugin bytes on every release made every installed app download them again
and filled npm with versions that differ only in their number. Comparing contents rather than git
paths also catches a change that comes from a shared dependency such as plugin-api's SQL helpers.
Reusing the npm tarball, rather than repacking it, keeps the release's attachments byte-identical to
npm.

## Consequences

- Plugins are no longer lockstep with the app. Which plugin goes with an app is the newest one its
  plugin API accepts, as the plugin store has always chosen; the release notes name each plugin's
  version.
- Fingerprints rely on reproducible builds. The `plugins` job packs twice and compares the
  fingerprints; if a build stops being reproducible, every plugin looks changed again, which is
  wasteful but not wrong.
- Retracting a beta means reverting `beta/` on `update-channels` to the previous beta and
  publishing a fix as the next beta; apps that already installed it keep it until a higher version.
- Before the first beta, `update-channels` does not exist; beta-channel apps log a warning and keep
  following stable until it does.
