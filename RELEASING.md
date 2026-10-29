# Releasing TableCraft

One annotated `vX.Y.Z` tag on `main` makes a release, and a `vX.Y.Z-beta.N` tag makes a beta (see
[Cutting a beta](#cutting-a-beta)). CI builds and checks everything from that tag and drafts a
GitHub release. A maintainer reviews the draft and publishes it, and publishing is what reaches
users: installed apps update from the published release, and the optional plugins that changed go
to npm. Follow these steps in order every time, so every release is built, checked and described
the same way.

Only a maintainer who can approve the `release` and `plugins` environments cuts a release. Agents
and contributors never create or push a tag, never publish a draft, and never run
`bun run plugins:publish` without `--dry-run`.

## What a release ships

Nothing in the tree names the version: every `package.json` stays `0.0.0`, and
`packages/desktop/scripts/version.ts` reads the version from the tag on `HEAD`. A build with no
release tag is `0.0.0-dev.<short sha>`, and nothing built from a branch is published.

| Artifact                                               | Where               | Version                            |
| ------------------------------------------------------ | ------------------- | ---------------------------------- |
| macOS `.dmg` and `.zip`, arm64 and x64                 | the GitHub release  | the tag                            |
| Windows `.exe`, Linux `.AppImage` (best-effort)        | the GitHub release  | the tag                            |
| `update-manifest.json` and `update-manifest.json.sig`  | the GitHub release  | the tag (decision 044)             |
| `@tablecraft-app/plugin-<id>`, one per optional plugin | npm and the release | the release it last changed in     |
| `@tablecraft-app/plugin-api` (stable releases only)    | npm and the release | `API_VERSION` (decisions 106, 107) |

A plugin gets a new version only when its contents changed (decision 134): an unchanged plugin's
release attachment is the tarball already on npm, and the notes say `unchanged, still 1.14.0`. See
[Which plugins publish](#which-plugins-publish). The plugin API keeps its own version: a release
whose API did not change republishes nothing for it, and the publish step reports it as already
published.

## Choose the version

Look at what merged since the last release:

```sh
git fetch origin --tags
git describe --tags --abbrev=0 --exclude 'v*-*' origin/main
git log --first-parent --oneline "$(git describe --tags --abbrev=0 --exclude 'v*-*' origin/main)..origin/main"
```

`--exclude 'v*-*'` skips betas, so the log covers everything since the last stable release.

- **Patch** (`v1.14.0` to `v1.14.1`): only fixes, including a fix to one plugin. A plugin-only fix
  ships as an app patch release (decision 109).
- **Minor** (`v1.14.0` to `v1.15.0`): anything new a user can see or a plugin can use: a feature, a
  plan, a setting, a plugin, or a plugin API addition.
- **Major**: only the project owner decides on a new major version. A plugin API major (decision 106) is a separate decision with its own plan; it never comes from a release step.

A stable tag is `v` and three numbers. The only pre-release is a beta, `v1.15.0-beta.1`; any other
suffix, such as `v1.15.0-rc.1`, builds as a development version and never releases.

Never reuse, move or delete a published tag. If a published release is wrong, the fix ships as the
next patch.

## Check main before you tag

1. Every pull request for the release has merged, and nothing else is about to. Tag the merge commit
   on `main` that `git log` above ends with, never a branch commit.
2. CI on that commit is green:

   ```sh
   gh run list --workflow ci.yml --branch main --limit 1
   ```

3. Your checkout matches it, with nothing uncommitted:

   ```sh
   git switch main
   git pull --ff-only
   git status --short
   ```

4. The plugin API version matches its surface. `bun run api:check` compares the surface with the
   last tag's and fails when an addition did not raise `API_VERSION`. That raise belongs in the
   pull request that made the addition, with the built-in manifests; never in a release commit. If
   the check fails, fix it in a pull request first.

   ```sh
   bun install --frozen-lockfile
   bun run api:check
   ```

5. Optionally, rehearse the plugin packages the way CI will:

   ```sh
   bun run plugins:pack
   bun run plugins:check
   bun run plugins:publish -- --dry-run
   ```

6. Decisions merged since the last release may need something done at release time. Read the
   Consequences of each decision added since the last tag:

   ```sh
   git diff --name-only --diff-filter=A "$(git describe --tags --abbrev=0 --exclude 'v*-*')..HEAD" -- docs/decisions/
   ```

## Tag

Use an annotated tag whose message is the tag itself, as every release so far has:

```sh
git tag -a v1.15.0 -m v1.15.0
git push origin v1.15.0
```

One commit carries one stable tag and at most one beta tag. `version.ts` stops a build when `HEAD`
has two of the same kind, and builds the stable version when it has one of each.

## Let CI build the draft

The tag runs `.github/workflows/ci.yml`. Follow it with:

```sh
gh run list --workflow ci.yml --branch v1.15.0 --limit 1
gh run watch <run id>
```

| Job       | What it does on a tag                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------- |
| `verify`  | lint, format check, typecheck, `test` and `test:db`                                                       |
| `changes` | decides which opt-in database suites the commit needs                                                     |
| `test-db` | runs `test:db:postgres` on every tag, plus the Oracle and SQL Server suites when their paths changed      |
| `package` | builds the installers and runs the packaged suite on each platform; macOS blocks, Windows and Linux don't |
| `plugins` | packs the plugins that changed, reuses the npm tarball of the rest, load-checks them and keeps them       |
| `release` | waits for approval of the `release` environment, signs the update manifest and drafts the release         |

The `plugins` job needs the npm registry on a tag: when it cannot reach it, the job fails rather
than republish every plugin. Rerun it.

Approve the `release` environment when the run asks for it. That job is the only one that reads the
update signing key.

When the Windows or Linux build fails, the release still drafts without that installer, and the
manifest leaves that platform out: installs there do not update until a release carries it again.
Decide whether that is acceptable before you publish. A macOS failure, or any other job failing,
stops the release job: see [When something goes wrong](#when-something-goes-wrong).

## Review the draft

```sh
gh release view v1.15.0
```

Check that the draft has:

- `TableCraft-1.15.0-arm64.dmg`, `.zip`, and the same two for x64.
- The Windows `.exe` and the Linux `.AppImage`, unless you accepted their absence above.
- `update-manifest.json` and `update-manifest.json.sig`.
- A `.tgz` for `@tablecraft-app/plugin-api` (not on a beta) and one for each optional plugin. An
  unchanged plugin's tarball carries its older version, such as
  `tablecraft-app-plugin-postgres-1.14.0.tgz`.

For a release that changes how the app starts, updates or packages, download the macOS `.zip` or
`.dmg` for your machine and open it once before you publish ([Running the unsigned macOS
app](docs/guide/install.md#running-the-unsigned-macos-app)).

## Write the release notes

Users read the notes: an installed app's update offer opens the release page. Every release's notes
have the same three parts, in this order.

1. **Highlights**, written by you: what a user can now do, not how it was built.
2. **What's Changed**, generated: every merged pull request under the heading of its label, then
   the full changelog link.
3. **Plugins on npm**, appended by the publish workflow.

The draft holds only the generated part. `.github/release.yml` sorts the pull requests by label,
and each goes under the first heading whose label it carries:

| Label           | Heading          | For                                                     |
| --------------- | ---------------- | ------------------------------------------------------- |
| `enhancement`   | New features     | something a user can do that they could not before      |
| `plugins`       | Database plugins | a change confined to one datasource plugin              |
| `bug`           | Fixes            | a behaviour that was wrong and now is right             |
| `documentation` | Documentation    | the README, the guide, CONTRIBUTING or RELEASING        |
| `internal`      | left out         | tests, CI, tooling and refactors a user cannot see      |
| none            | Other changes    | a pull request merged without a label; label it instead |

Read the generated list first. Give a pull request under Other changes its label, or move one under
the wrong heading by changing its label, then generate the list again. Fix a title a user would not
understand on the pull request itself, so the next generation keeps it. Leave the list otherwise as
it is, so every release reads the same way.

Then write the Highlights above it:

The list starts at the previous stable tag for a stable release, and at the previous tag of either
kind for a beta; `version.ts --notes-start` names it, as the draft did:

```sh
start=$(bun packages/desktop/scripts/version.ts --notes-start v1.15.0)
gh api repos/tranphucbol/table-craft/releases/generate-notes \
  -f tag_name=v1.15.0 -f previous_tag_name="$start" --jq .body > /tmp/v1.15.0-notes.md
# add the Highlights at the top of /tmp/v1.15.0-notes.md
gh release edit v1.15.0 --notes-file /tmp/v1.15.0-notes.md
```

```markdown
## Highlights

- **Oracle databases.** Connect to Oracle Database 12.1 and later with nothing else to
  install; TableCraft downloads the plugin the first time you pick Oracle. [Guide](https://github.com/tranphucbol/table-craft/blob/main/docs/guide/oracle.md)

## Before you update

Only when a user must act: install by hand after a signing key change, a setting that moved.
```

- One to three bullets, each a bold phrase in a user's words and a sentence or two on how to use it,
  linking its guide page by full URL (a relative link breaks on the release page).
- No plan numbers, decision numbers, file names or class names.
- A patch release of fixes alone may skip Highlights and keep only the generated list.
- Keep **Before you update** only when there is something to do, and say exactly what.
- Do not add a `### Plugins on npm` heading: the publish workflow writes it, and skips writing it
  when one is already there.

## Publish

```sh
gh release edit v1.15.0 --draft=false
```

A beta's draft is already marked as a pre-release; publishing keeps it one.

Publishing starts `.github/workflows/publish-plugins.yml`. Approve the `plugins` environment when it
asks. It downloads the tarballs attached to the release, load-checks them against the tag,
publishes `@tablecraft-app/plugin-api` first and then each plugin with npm provenance, skipping
every version already on npm, and appends what each plugin is at this release to the notes.

## Check the release

```sh
gh run list --workflow publish-plugins.yml --limit 1
npm view @tablecraft-app/plugin-postgres version
curl -sL https://github.com/tranphucbol/table-craft/releases/latest/download/update-manifest.json
```

The manifest's `version` equals the new release, and so does the npm version of every plugin that
changed. The release notes end with a `### Plugins on npm` list. Installed apps offer the update a
little after their next launch, or within a day while running.

Nothing goes back into the tree: there is no version file to bump and no changelog to commit.

## Cutting a beta

A beta goes only to the apps whose **Get beta versions** box is checked (Settings → Advanced), and
to a beta build someone installed by hand. Everyone else stays on the last stable release.

1. Check main exactly as for a release. Count the beta number from 1 for each upcoming version:
   `v1.16.0-beta.1`, `v1.16.0-beta.2`, and so on.
2. Tag and push it:

   ```sh
   git tag -a v1.16.0-beta.1 -m v1.16.0-beta.1
   git push origin v1.16.0-beta.1
   ```

3. CI drafts the release as a pre-release, with notes starting at the previous tag of either kind.
   Review the draft as above; it has no plugin-api tarball, since a beta never publishes the
   plugin API (decision 134).
4. Highlights are optional for a beta. Say what to try and what is known to be unfinished.
5. Publish it with `gh release edit v1.16.0-beta.1 --draft=false`. Two workflows run:
   - `publish-plugins.yml` publishes the changed plugins under the npm dist-tag `next`, so
     `latest` stays on the stable release.
   - `publish-channel.yml` commits the signed manifest to `beta/` on the `update-channels` branch,
     where beta-channel apps look. It refuses a beta lower than the one already there.
6. Check it:

   ```sh
   gh run list --workflow publish-channel.yml --limit 1
   curl -sL https://raw.githubusercontent.com/tranphucbol/table-craft/update-channels/beta/update-manifest.json
   ```

   The manifest's `version` is the beta and its `channel` is `beta`.

## Promoting a beta to stable

A beta is never relabelled. When the last beta is ready, tag a stable release from `main` as usual,
on the beta's commit when nothing merged since. `version.ts` builds the stable version when a commit
carries both tags, and its notes start at the previous stable tag, so they cover every beta.

A stable `v1.16.0` is above every `v1.16.0-beta.N`, so beta-channel apps take it too, and keep
following betas afterwards. Plugins changed only in a beta get a stable version now: a stable
release compares each plugin with the newest stable version on npm.

## Retracting a beta

Never delete a published beta or its tag. To stop offering a broken beta before its fix is ready,
put the previous beta's manifest back on the channel branch:

```sh
git fetch origin update-channels
git switch update-channels
git revert --no-edit HEAD
git push origin update-channels
```

Apps that already installed the broken beta keep it until a higher version: ship the fix as the
next beta. The plugins it published stay on npm under `next`; never unpublish them.

## Which plugins publish

Before a tag build packs, `bun run plugins:pack -- --reuse-published` compares each optional
plugin's contents with a baseline on npm, ignoring only its version number:

| Release | Baseline                                  |
| ------- | ----------------------------------------- |
| Stable  | the newest stable version on npm          |
| Beta    | the newest version on npm, beta or stable |

When the contents match, the job puts the baseline's npm tarball into the release, and the publish
step skips it as already published; the notes say `unchanged, still 1.14.0`. When they differ, it
packs a new version at the release's version. There is no override: the same bytes are nothing new
to ship. Rehearse it locally with:

```sh
bun run plugins:pack -- --reuse-published
```

The `plugins` job also packs twice and compares the results. If that fails, a plugin's build is not
reproducible and every release would republish it; fix the build in a pull request.

## When something goes wrong

| What happened                                             | What to do                                                                                                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A job failed before the release job, so no draft exists   | Fix it in a pull request on `main`. Delete the tag (`git push origin :refs/tags/v1.15.0`, `git tag -d v1.15.0`) and tag the fixed merge commit with the same version        |
| The draft exists but is wrong, and it was never published | Delete the draft (`gh release delete v1.15.0`) and the tag as above, fix on `main`, and tag again. Nothing outside the repository has seen it                               |
| The release job waits                                     | Approve the `release` environment in the run                                                                                                                                |
| The release job fails on the signing key                  | The `TABLE_CRAFT_UPDATE_SIGNING_KEY` secret is missing or does not match the public key in `packages/desktop/src/main/update/manifest.ts`. Fix the secret and rerun the job |
| `publish-plugins` failed partway                          | Rerun it (`gh run rerun <run id>`): versions already on npm are skipped                                                                                                     |
| The `plugins` job says the registry is unreachable        | Rerun the job once npm answers. On a tag it never falls back to republishing every plugin                                                                                   |
| `publish-channel` refused the manifest                    | A higher beta is already on `update-channels`. Publish betas in order; the refused one reaches nobody, which is what you want                                               |
| A published beta is broken                                | [Retract it](#retracting-a-beta) and ship the fix as the next beta                                                                                                          |
| A published release is broken                             | Fix it on `main` and release the next patch. Never delete or retag a published release, and never unpublish from npm                                                        |
| The signing key is lost or leaked                         | Follow decision 044: a release that changes the public key, which every user installs by hand once. Say so under **Before you update**                                      |
| A published release's notes are wrong                     | Edit them (`gh release edit v1.15.0 --notes-file ...`), keeping the `### Plugins on npm` list. Notes are the one thing you may change after publishing                      |

## One-time setup

A fork, or a new maintainer, needs this before its first release:

- The GitHub environment `release`, with required reviewers and the secret
  `TABLE_CRAFT_UPDATE_SIGNING_KEY`: the Ed25519 private key whose public half is compiled into
  `packages/desktop/src/main/update/manifest.ts`. The maintainer keeps the only other copy in
  `~/.config/table-craft/update-signing-key.pem` (mode 600). It is never committed, shared or
  logged.
- The GitHub environment `plugins`, with a deployment rule for `v*` tags, optional reviewers, and
  the secret `NPM_TOKEN`: a granular npm token that can publish only `@tablecraft-app/*`.
- Membership of the `@tablecraft-app` scope on npm.
- A branch protection rule for `update-channels` that lets only GitHub Actions and maintainers push.
  The first published beta creates the branch.
