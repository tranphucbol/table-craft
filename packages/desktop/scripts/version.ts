/**
 * The version a build packages as (decision 033): `X.Y.Z` or `X.Y.Z-beta.N` when `HEAD` carries a
 * `vX.Y.Z` or `vX.Y.Z-beta.N` tag (plan 124), else `0.0.0-dev.<short sha>`. The `package.json`
 * files stay `0.0.0`. `bun packages/desktop/scripts/version.ts` prints it;
 * `--notes-start <tag>` prints the tag that release's notes start at, or nothing for the first.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { channelOf, type ReleaseChannel } from "../src/settings/channel.js";
import { compareVersions } from "../src/main/update/manifest.js";

/** Runs `git <args>` in the repository and returns its trimmed stdout. */
export type Git = (args: readonly string[]) => string;

const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-beta\.\d+)?)$/;
const SHORT_SHA_LENGTH = 7;
const DEVELOPMENT_BASE = "0.0.0-dev";

export class VersionError extends Error {
  override readonly name = "VersionError";
}

/** The version a release tag names, or null when `tag` is not one. */
export function releaseTagVersion(tag: string): string | null {
  return RELEASE_TAG.exec(tag.trim())?.[1] ?? null;
}

function releaseTags(git: Git, args: readonly string[]): string[] {
  return git(args)
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => releaseTagVersion(tag) !== null);
}

function onlyOne(tags: readonly string[]): string | undefined {
  if (tags.length > 1) {
    throw new VersionError(
      `HEAD carries ${tags.length} release tags (${tags.join(", ")}); delete all but one before packaging.`,
    );
  }
  return tags[0];
}

/** A stable tag wins over beta tags on the same commit: promoting the last beta's commit as it is. */
export function appVersion(git: Git): string {
  const releases = releaseTags(git, ["tag", "--points-at", "HEAD"]);
  const stable = onlyOne(releases.filter((tag) => channelOf(releaseTagVersion(tag) ?? "") === "stable"));
  const release = stable ?? onlyOne(releases.filter((tag) => channelOf(releaseTagVersion(tag) ?? "") === "beta"));
  if (release !== undefined) return releaseTagVersion(release) ?? release;
  return `${DEVELOPMENT_BASE}.${git(["rev-parse", `--short=${SHORT_SHA_LENGTH}`, "HEAD"])}`;
}

/**
 * The highest release tag in `tags` below `tag`, limited to `channel` unless it is `"any"`; null
 * when there is none. Non-release tags are ignored.
 */
export function previousTag(tags: readonly string[], tag: string, channel: ReleaseChannel | "any"): string | null {
  const version = releaseTagVersion(tag);
  if (version === null) throw new VersionError(`"${tag}" is not a release tag; use vX.Y.Z or vX.Y.Z-beta.N.`);
  let best: { tag: string; version: string } | null = null;
  for (const candidate of tags) {
    const candidateVersion = releaseTagVersion(candidate);
    if (candidateVersion === null || compareVersions(candidateVersion, version) >= 0) continue;
    if (channel !== "any" && channelOf(candidateVersion) !== channel) continue;
    if (best === null || compareVersions(candidateVersion, best.version) > 0) {
      best = { tag: candidate.trim(), version: candidateVersion };
    }
  }
  return best?.tag ?? null;
}

/**
 * Where a release's notes start: a stable release lists everything since the previous stable one,
 * a beta only what came since the tag before it, beta or stable.
 */
export function notesStartTag(tags: readonly string[], tag: string): string | null {
  const version = releaseTagVersion(tag);
  if (version === null) throw new VersionError(`"${tag}" is not a release tag; use vX.Y.Z or vX.Y.Z-beta.N.`);
  return previousTag(tags, tag, channelOf(version) === "stable" ? "stable" : "any");
}

export const systemGit: Git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { "notes-start": { type: "string" } } });
  const tag = values["notes-start"];
  console.log(tag === undefined ? appVersion(systemGit) : (notesStartTag(releaseTags(systemGit, ["tag"]), tag) ?? ""));
}
