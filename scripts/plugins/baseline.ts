/**
 * The published version a new plugin package is compared with (plan 124): a stable release
 * against the newest stable on npm, a beta against the newest of either kind, so a stable release
 * never reuses a package only beta users have run.
 */
import { compareVersions } from "../../packages/desktop/src/main/update/manifest.js";
import { PluginInstallError } from "../../packages/desktop/src/main/pluginStore/errors.js";
import {
  checkIntegrity,
  downloadTarball,
  fetchPackument,
  type RegistryFetch,
} from "../../packages/desktop/src/main/pluginStore/registry.js";
import { BETA_VERSION, type ReleaseChannel } from "../../packages/desktop/src/settings/channel.js";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

export interface Baseline {
  readonly version: string;
  readonly integrity: string;
  readonly bytes: Buffer;
}

interface PublishedVersion {
  readonly version: string;
  readonly tarball: string;
  readonly integrity: string;
}

function publishedVersions(packument: unknown): PublishedVersion[] {
  const versions = (packument as { versions?: unknown } | null)?.versions;
  if (typeof versions !== "object" || versions === null) return [];
  return Object.values(versions).flatMap((raw: unknown) => {
    const entry = raw as { version?: unknown; dist?: { tarball?: unknown; integrity?: unknown } } | null;
    const version = entry?.version;
    const tarball = entry?.dist?.tarball;
    const integrity = entry?.dist?.integrity;
    if (typeof version !== "string" || typeof tarball !== "string" || typeof integrity !== "string") return [];
    return [{ version, tarball, integrity }];
  });
}

function channelTakes(channel: ReleaseChannel, version: string): boolean {
  return STABLE_VERSION.test(version) || (channel === "beta" && BETA_VERSION.test(version));
}

/**
 * The newest version of `packageName` a `channel` release compares with, downloaded and checked
 * against the packument's sha512; null when nothing on that channel was ever published. An
 * unreachable registry or a tarball that fails its checksum throws, so nothing is reused blind.
 */
export async function baselineFor(
  packageName: string,
  channel: ReleaseChannel,
  fetch: RegistryFetch,
  registry: string = DEFAULT_REGISTRY,
): Promise<Baseline | null> {
  let packument: unknown;
  try {
    packument = await fetchPackument(fetch, registry, packageName);
  } catch (cause) {
    if (cause instanceof PluginInstallError && cause.failure === "notFound") return null;
    throw cause;
  }
  const [newest] = publishedVersions(packument)
    .filter((entry) => channelTakes(channel, entry.version))
    .sort((left, right) => compareVersions(right.version, left.version));
  if (newest === undefined) return null;
  const bytes = await downloadTarball(fetch, newest.tarball, () => undefined);
  checkIntegrity(bytes, newest.integrity, packageName);
  return { version: newest.version, integrity: newest.integrity, bytes };
}
