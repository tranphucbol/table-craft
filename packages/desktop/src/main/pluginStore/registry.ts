/**
 * The npm registry, read the way npm does (decision 110): one packument per package, the newest
 * version whose `tableCraft.apiVersion` this host accepts, and its tarball checked against the
 * packument's sha512 before anything is unpacked.
 */
import { createHash } from "node:crypto";
import { API_VERSION, incompatibility, isCompatible } from "@table-craft/plugin-api";
import { OFFLINE_HINT, PluginInstallError } from "@table-craft/desktop/main/pluginStore/errors.js";
import { compareVersions } from "@table-craft/desktop/main/update/manifest.js";
import { BETA_VERSION, type ReleaseChannel } from "@table-craft/desktop/settings/channel.js";
import { registryUrlError } from "@table-craft/desktop/settings/settings.js";

/** Far above any plugin bundle (PostgreSQL's is under 1 MB); stops a hostile mirror filling the disk. */
export const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
/**
 * The full packument. npm's abbreviated one (`application/vnd.npm.install-v1+json`) keeps only the
 * fields an installer needs and drops `tableCraft`, so every version would look like no plugin.
 */
const PACKUMENT_ACCEPT = "application/json";
const SHA512 = "sha512-";
const NOT_FOUND = 404;
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

export type RegistryFetch = (url: string, init: { readonly headers?: Record<string, string> }) => Promise<Response>;

/** The parts of one packument version TableCraft reads. */
export interface RegistryVersion {
  readonly version: string;
  readonly apiVersion: string;
  readonly tarball: string;
  readonly integrity: string;
}

/** https anywhere; plain http only to this machine, where the tests' registry runs. */
export function registryUrlAllowed(url: string): boolean {
  return registryUrlError(url) === null;
}

function insecure(url: string): PluginInstallError {
  return new PluginInstallError(
    "insecureUrl",
    `The plugin registry address ${url} is not https.`,
    "Set an https registry in Settings → Plugins.",
  );
}

/** `<registry>/@scope%2fname`, the escaped form every npm registry answers. */
export function packumentUrl(registry: string, packageName: string): string {
  return `${registry.replace(/\/+$/, "")}/${packageName.replace("/", "%2f")}`;
}

async function request(fetch: RegistryFetch, url: string, headers?: Record<string, string>): Promise<Response> {
  if (!registryUrlAllowed(url)) throw insecure(url);
  try {
    return await fetch(url, headers === undefined ? {} : { headers });
  } catch (cause) {
    throw new PluginInstallError(
      "offline",
      `The plugin registry could not be reached: ${cause instanceof Error ? cause.message : String(cause)}.`,
      OFFLINE_HINT,
    );
  }
}

function releaseParts(version: string): readonly number[] | null {
  const match = RELEASE.exec(version);
  return match === null ? null : match.slice(1).map(Number);
}

function newer(left: readonly number[], right: readonly number[]): boolean {
  for (let index = 0; index < left.length; index++) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return false;
}

function readVersion(raw: unknown, pluginId: string): RegistryVersion | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as {
    version?: unknown;
    tableCraft?: { id?: unknown; apiVersion?: unknown };
    dist?: { tarball?: unknown; integrity?: unknown };
  };
  const { version, tableCraft, dist } = entry;
  if (typeof version !== "string" || tableCraft?.id !== pluginId || typeof tableCraft.apiVersion !== "string") {
    return null;
  }
  if (typeof dist?.tarball !== "string" || typeof dist.integrity !== "string") return null;
  return { version, apiVersion: tableCraft.apiVersion, tarball: dist.tarball, integrity: dist.integrity };
}

function onChannel(version: string, channel: ReleaseChannel): boolean {
  return RELEASE.test(version) || (channel === "beta" && BETA_VERSION.test(version));
}

/**
 * The newest version of `pluginId` on `channel` this host can load: releases only on stable, betas
 * too on beta; other pre-releases never. When versions exist but none fits, the error says why for
 * the newest, in `incompatibility()`'s terms.
 */
export function pickVersion(
  packument: unknown,
  pluginId: string,
  packageName: string,
  hostVersion: string = API_VERSION,
  channel: ReleaseChannel = "stable",
): RegistryVersion {
  const versions = (packument as { versions?: unknown } | null)?.versions;
  const candidates = Object.values(typeof versions === "object" && versions !== null ? versions : {})
    .map((raw) => readVersion(raw, pluginId))
    .filter((entry): entry is RegistryVersion => entry !== null && onChannel(entry.version, channel))
    .sort((left, right) => compareVersions(right.version, left.version));
  const fitting = candidates.find((candidate) => isCompatible(candidate.apiVersion, hostVersion));
  if (fitting !== undefined) return fitting;
  const [newest] = candidates;
  if (newest === undefined) {
    throw new PluginInstallError(
      "notFound",
      `The registry has no TableCraft plugin release of ${packageName}.`,
      "Check the registry in Settings → Plugins, or install the plugin from a file.",
    );
  }
  const why = incompatibility(newest.apiVersion, hostVersion);
  const hint =
    why === "newer"
      ? "Update TableCraft, then install the plugin again."
      : "Install a version of the plugin built for this TableCraft, from a file.";
  throw new PluginInstallError(
    "incompatible",
    `${packageName} ${newest.version} needs plugin API ${newest.apiVersion}; this TableCraft provides ${hostVersion}.`,
    hint,
  );
}

/** True when `version` is a release newer than `than`. */
export function isNewerRelease(version: string, than: string): boolean {
  const left = releaseParts(version);
  const right = releaseParts(than);
  return left !== null && (right === null || newer(left, right));
}

export async function fetchPackument(fetch: RegistryFetch, registry: string, packageName: string): Promise<unknown> {
  const url = packumentUrl(registry, packageName);
  const response = await request(fetch, url, { accept: PACKUMENT_ACCEPT });
  if (response.status === NOT_FOUND) {
    throw new PluginInstallError(
      "notFound",
      `${packageName} is not on the registry ${registry}.`,
      "Check the registry in Settings → Plugins, or install the plugin from a file.",
    );
  }
  if (!response.ok) {
    throw new PluginInstallError(
      "offline",
      `The plugin registry answered ${String(response.status)} for ${packageName}.`,
      OFFLINE_HINT,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new PluginInstallError(
      "offline",
      `The plugin registry sent an unreadable answer for ${packageName}.`,
      OFFLINE_HINT,
    );
  }
}

function tooLarge(): PluginInstallError {
  return new PluginInstallError(
    "tooLarge",
    `The plugin package is larger than ${String(MAX_TARBALL_BYTES / 1024 / 1024)} MB.`,
    "Nothing was installed. Check the registry in Settings → Plugins.",
  );
}

/** Downloads the tarball, reporting bytes as they arrive; the integrity is checked by the caller. */
export async function downloadTarball(
  fetch: RegistryFetch,
  url: string,
  onProgress: (received: number, total: number | null) => void,
): Promise<Buffer> {
  const response = await request(fetch, url);
  if (!response.ok || response.body === null) {
    throw new PluginInstallError("offline", `The plugin download answered ${String(response.status)}.`, OFFLINE_HINT);
  }
  const length = Number(response.headers.get("content-length"));
  const total = Number.isFinite(length) && length > 0 ? length : null;
  if (total !== null && total > MAX_TARBALL_BYTES) throw tooLarge();
  const chunks: Buffer[] = [];
  let received = 0;
  const body = response.body as unknown as AsyncIterable<Uint8Array>;
  try {
    for await (const value of body) {
      received += value.byteLength;
      if (received > MAX_TARBALL_BYTES) throw tooLarge();
      chunks.push(Buffer.from(value));
      onProgress(received, total);
    }
  } catch (cause) {
    if (cause instanceof PluginInstallError) throw cause;
    throw new PluginInstallError(
      "offline",
      `The plugin download broke off: ${cause instanceof Error ? cause.message : String(cause)}.`,
      OFFLINE_HINT,
    );
  }
  return Buffer.concat(chunks);
}

/** Checks `bytes` against an SRI string such as the packument's `dist.integrity`; only sha512 counts. */
export function checkIntegrity(bytes: Uint8Array, integrity: string, packageName: string): void {
  const expected = integrity
    .split(/\s+/)
    .filter((hash) => hash.startsWith(SHA512))
    .map((hash) => hash.slice(SHA512.length));
  const actual = createHash("sha512").update(bytes).digest("base64");
  if (expected.includes(actual)) return;
  throw new PluginInstallError(
    "integrity",
    expected.length === 0
      ? `The registry gave no sha512 checksum for ${packageName}, so it was not installed.`
      : `The download of ${packageName} does not match the registry's sha512 checksum, so it was not installed.`,
    "Nothing was installed. Try again later; if it persists, the registry or a proxy is altering the package.",
  );
}
