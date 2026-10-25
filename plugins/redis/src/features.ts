import { PluginError } from "@table-craft/plugin-api";

/** The oldest server the plugin speaks to (decision 116): RESP3, `CLIENT` subcommands, `SCAN … TYPE`. */
export const MINIMUM_VERSION = "6.2.0";

const VERSION_7 = "7.0.0";

/**
 * What the connected server can do that 6.2 cannot (decision 24 of plan 058). The one place a
 * version is compared; everything else asks a field, so a 6.2 server and a 7.4 one share a path.
 */
export interface RedisFeatures {
  /** The lowest version over every primary, as `INFO server` reports it. */
  readonly version: string;
  /** `COMMAND DOCS` (7.0); without it completion reads the 7.4 snapshot. */
  readonly commandDocs: boolean;
  /** `COMMAND INFO` lists container subcommands with their flags (7.0); else the snapshot's. */
  readonly subcommandInfo: boolean;
  /** `INFO` takes several sections in one call (7.0); else one call per section. */
  readonly multiSectionInfo: boolean;
  /** `CONFIG GET` takes several parameters in one call (7.0); else one call per parameter. */
  readonly multiParamConfigGet: boolean;
  /** `EXPIRETIME` and `PEXPIRETIME` (7.0); else the TTL is read relative. */
  readonly expireTime: boolean;
  /** `EXPIRE … NX | XX | GT | LT` (7.0). */
  readonly expireOptions: boolean;
  /** `HTTL` and the other hash-field expiry commands (7.4); else the TTL column is left out. */
  readonly hashFieldTtl: boolean;
}

function parts(version: string): number[] {
  return version.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
}

/** Negative when `a` is older than `b`, zero when equal, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The oldest of `versions`, which a cluster's features follow. */
export function lowestVersion(versions: readonly string[]): string {
  return versions.reduce((lowest, version) => (compareVersions(version, lowest) < 0 ? version : lowest));
}

/** Refuses a server older than `MINIMUM_VERSION`, naming the version it found. */
export function requireSupported(version: string): void {
  if (compareVersions(version, MINIMUM_VERSION) >= 0) return;
  throw new PluginError(
    "connectionFailed",
    `Redis ${MINIMUM_VERSION.replace(/\.0$/, "")} or later is required (server is ${version}).`,
  );
}

/**
 * The features of a server at `version` whose command table holds `commands` (upper-case names):
 * a command the table lists is probed there, so one renamed or disabled away reads as missing.
 */
export function featuresOf(version: string, commands: ReadonlySet<string>): RedisFeatures {
  const seven = compareVersions(version, VERSION_7) >= 0;
  return {
    version,
    commandDocs: seven,
    subcommandInfo: seven,
    multiSectionInfo: seven,
    multiParamConfigGet: seven,
    expireTime: commands.has("EXPIRETIME"),
    expireOptions: seven,
    hashFieldTtl: commands.has("HTTL"),
  };
}

/** `redis_version` out of an `INFO server` reply. */
export function versionOfInfo(info: string): string {
  const match = /^redis_version:(\S+)/m.exec(info);
  return match?.[1] ?? "";
}
