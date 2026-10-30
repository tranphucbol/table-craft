/**
 * Guards what the publish-channel workflow commits to `beta/` on the `chore/update-channels` branch
 * (decision 134): the release's signed manifest must verify, name the tag's version and the beta
 * channel, and be no older than the beta already published, so republishing an old pre-release
 * cannot move beta apps back to it.
 *
 *   bun packages/desktop/scripts/channel-manifest.ts --tag v1.16.0-beta.2 \
 *     --manifest release/update-manifest.json --published channels/beta/update-manifest.json
 *
 * Prints `publish` or `unchanged`; anything else exits non-zero with the reason.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  compareVersions,
  RELEASE_TRUST,
  SIGNATURE_FILE,
  verifyManifest,
  type ManifestTrust,
} from "../src/main/update/manifest.js";
import { channelOf } from "../src/settings/channel.js";
import { releaseTagVersion } from "./version.js";

export class ChannelManifestError extends Error {
  override readonly name = "ChannelManifestError";
}

export interface ChannelCandidate {
  readonly tag: string;
  readonly body: Uint8Array;
  readonly signature: string;
  /** The manifest on the branch now, unverified: it only bounds the version; null before the first beta. */
  readonly published: Uint8Array | null;
}

export type ChannelVerdict = "publish" | "unchanged";

function publishedVersion(body: Uint8Array): string | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string")
      return parsed.version;
  } catch {
    // An unreadable file on the branch is replaced, as if nothing were published.
  }
  return null;
}

export function checkBetaManifest(candidate: ChannelCandidate, trust: ManifestTrust = RELEASE_TRUST): ChannelVerdict {
  const version = releaseTagVersion(candidate.tag);
  if (version === null || channelOf(version) !== "beta")
    throw new ChannelManifestError(`--tag must be vX.Y.Z-beta.N, not "${candidate.tag}".`);
  const verdict = verifyManifest(candidate.body, candidate.signature, trust);
  if (!verdict.ok)
    throw new ChannelManifestError(
      `The release's manifest does not verify (${verdict.reason}: ${verdict.detail}); re-run the release job for ${candidate.tag}.`,
    );
  if (verdict.manifest.version !== version)
    throw new ChannelManifestError(`The manifest names ${verdict.manifest.version}, the tag ${version}.`);
  if (verdict.manifest.channel !== "beta")
    throw new ChannelManifestError(`The manifest of ${candidate.tag} names the ${verdict.manifest.channel} channel.`);
  const current = candidate.published === null ? null : publishedVersion(candidate.published);
  if (current === null) return "publish";
  const order = compareVersions(version, current);
  if (order < 0)
    throw new ChannelManifestError(
      `The beta channel already offers ${current}; ${version} is older and is not published to it.`,
    );
  return order === 0 ? "unchanged" : "publish";
}

async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    throw cause;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { tag: { type: "string" }, manifest: { type: "string" }, published: { type: "string" } },
  });
  const manifest = values.manifest ?? "";
  if (manifest === "") throw new ChannelManifestError("--manifest names the release's update-manifest.json.");
  const signaturePath = manifest.replace(/[^/]*$/, SIGNATURE_FILE);
  const verdict = checkBetaManifest({
    tag: values.tag ?? "",
    body: await readFile(manifest),
    signature: await readFile(signaturePath, "utf8"),
    published: values.published === undefined ? null : await readIfPresent(values.published),
  });
  console.log(verdict);
}

if (import.meta.main) await main();
