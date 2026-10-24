/**
 * The plugin contract's version. Unstable while the major is 0: a minor bump is a breaking change,
 * so a plugin is compatible only with the exact minor it was built against.
 */
export const API_VERSION = "0.21.0";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const UNSTABLE_MAJOR = 0;

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

/** Whether a plugin built against `apiVersion` can be loaded by this `API_VERSION`, by caret rules. */
export function isCompatible(apiVersion: string, hostVersion: string = API_VERSION): boolean {
  const plugin = parseVersion(apiVersion);
  const host = parseVersion(hostVersion);
  if (plugin === null || host === null || plugin.major !== host.major) return false;
  if (host.major === UNSTABLE_MAJOR) return plugin.minor === host.minor && plugin.patch <= host.patch;
  return plugin.minor < host.minor || (plugin.minor === host.minor && plugin.patch <= host.patch);
}
