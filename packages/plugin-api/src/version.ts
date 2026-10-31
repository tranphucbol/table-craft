/**
 * The plugin contract's version, by semver (decision 106): a host loads a plugin built for the same
 * major and an older or equal minor. Typed `string` so a bump does not change the API report.
 */
export const API_VERSION: string = "1.10.0";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** `major.minor.patch` and nothing else; pre-release and build tags are not accepted. */
export function parseVersion(text: string): Version | null {
  const match = SEMVER.exec(text);
  if (match === null) return null;
  const [, major, minor, patch] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

/**
 * Why a plugin built against `apiVersion` cannot load on `hostVersion`: it needs a `newer` host
 * (a later minor, or a later major), it was built for an `olderMajor`, or the version is `invalid`.
 * Null when it loads.
 */
export type Incompatibility = "newer" | "olderMajor" | "invalid";

export function incompatibility(apiVersion: string, hostVersion: string = API_VERSION): Incompatibility | null {
  const plugin = parseVersion(apiVersion);
  const host = parseVersion(hostVersion);
  if (plugin === null || host === null) return "invalid";
  if (plugin.major < host.major) return "olderMajor";
  if (plugin.major > host.major || plugin.minor > host.minor) return "newer";
  return null;
}

/** Whether a plugin built against `apiVersion` can be loaded by this `API_VERSION`, by semver. */
export function isCompatible(apiVersion: string, hostVersion: string = API_VERSION): boolean {
  return incompatibility(apiVersion, hostVersion) === null;
}
