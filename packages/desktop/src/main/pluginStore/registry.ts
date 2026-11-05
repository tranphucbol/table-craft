/**
 * The npm registry, read the way npm does (decision 110): one packument per package, the newest
 * version whose `tableCraft.apiVersion` this host accepts, and its tarball checked against the
 * packument's sha512 before anything is unpacked. A private registry (decision 158) may need a
 * token, may sit under a path, and may answer GitLab's thinner packument: no `tableCraft`, a SHA-1
 * `shasum` instead of an `integrity`.
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
const SHA1 = "sha1-";
const NOT_FOUND = 404;
const UNAUTHORIZED = new Set([401, 403]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

export const UNAUTHORIZED_HINT = "Set the registry's token in Settings → Plugins (a GitLab token with read_api).";

export type RegistryFetch = (
  url: string,
  init: { readonly headers?: Record<string, string>; readonly redirect?: "manual" },
) => Promise<Response>;

/** Where a packument or tarball comes from, and what it may be sent. */
export interface RegistryAccess {
  readonly url: string;
  /** Null for the official registry and a registry without a stored token. */
  readonly token: string | null;
  /** True for a private registry: SHA-1 accepted, tarball metadata read from the package. */
  readonly private: boolean;
}

/** The parts of one packument version TableCraft reads. */
export interface RegistryVersion {
  readonly version: string;
  readonly apiVersion: string;
  readonly tarball: string;
  readonly integrity: string;
}

/** One version of a private package worth trying, newest first; `tableCraft` null means read the tarball. */
export interface RegistryCandidate {
  readonly version: string;
  readonly tarball: string;
  readonly dist: { readonly integrity?: string; readonly shasum?: string };
  readonly tableCraft: { readonly id: string; readonly apiVersion: string } | null;
}

/** https anywhere; plain http only to this machine, where the tests' registry runs. */
export function registryUrlAllowed(url: string): boolean {
  return registryUrlError(url) === null;
}

export function officialRegistry(url: string): RegistryAccess {
  return { url, token: null, private: false };
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

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** `headers` plus the bearer token, only when `url` is on the registry's own origin. */
export function authorizedHeaders(
  access: RegistryAccess,
  url: string,
  headers: Record<string, string> = {},
): Record<string, string> {
  if (access.token === null || originOf(url) !== originOf(access.url)) return { ...headers };
  return { ...headers, authorization: `Bearer ${access.token}` };
}

class CrossOriginRedirect extends Error {
  constructor(readonly location: string) {
    super(`redirected to ${location}`);
  }
}

async function send(fetch: RegistryFetch, url: string, init: Parameters<RegistryFetch>[1]): Promise<Response> {
  if (!registryUrlAllowed(url)) throw insecure(url);
  try {
    return await fetch(url, init);
  } catch (cause) {
    throw new PluginInstallError(
      "offline",
      `The plugin registry could not be reached: ${cause instanceof Error ? cause.message : String(cause)}.`,
      OFFLINE_HINT,
    );
  }
}

function initOf(headers: Record<string, string>): Parameters<RegistryFetch>[1] {
  return Object.keys(headers).length === 0 ? {} : { headers };
}

/**
 * The official registry is fetched as before. A private one follows redirects by hand, one hop at
 * a time, and never off the origin a request carrying the token went to. A packument never leaves
 * the registry's origin at all: GitLab forwards a package it does not hold to npmjs, where a
 * stranger may own the same name.
 */
async function request(
  fetch: RegistryFetch,
  access: RegistryAccess,
  url: string,
  options: { readonly headers?: Record<string, string>; readonly stayOnOrigin?: boolean } = {},
): Promise<Response> {
  if (!access.private) return send(fetch, url, initOf(authorizedHeaders(access, url, options.headers)));
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers = authorizedHeaders(access, current, options.headers);
    const response = await send(fetch, current, { ...initOf(headers), redirect: "manual" });
    const location = response.headers.get("location");
    if (!REDIRECTS.has(response.status) || location === null) return response;
    const next = new URL(location, current).href;
    const leaves = originOf(next) !== originOf(current);
    if (leaves && (options.stayOnOrigin === true || headers.authorization !== undefined)) {
      throw new CrossOriginRedirect(next);
    }
    current = next;
  }
  throw new PluginInstallError(
    "offline",
    `The plugin registry redirected more than ${String(MAX_REDIRECTS)} times.`,
    "Check the registry's address in Settings → Plugins.",
  );
}

function unauthorized(registry: string, status: number): PluginInstallError {
  return new PluginInstallError(
    "unauthorized",
    `The plugin registry ${registry} refused the request (${String(status)}).`,
    UNAUTHORIZED_HINT,
  );
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
  throw incompatibleError(packageName, newest.version, newest.apiVersion, hostVersion);
}

function readCandidate(raw: unknown): RegistryCandidate | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as {
    version?: unknown;
    tableCraft?: { id?: unknown; apiVersion?: unknown };
    dist?: { tarball?: unknown; integrity?: unknown; shasum?: unknown };
  };
  const { version, tableCraft, dist } = entry;
  if (typeof version !== "string" || typeof dist?.tarball !== "string") return null;
  const integrity = typeof dist.integrity === "string" ? dist.integrity : undefined;
  const shasum = typeof dist.shasum === "string" ? dist.shasum : undefined;
  if (integrity === undefined && shasum === undefined) return null;
  const declared =
    typeof tableCraft?.id === "string" && typeof tableCraft.apiVersion === "string"
      ? { id: tableCraft.id, apiVersion: tableCraft.apiVersion }
      : null;
  return {
    version,
    tarball: dist.tarball,
    dist: { ...(integrity === undefined ? {} : { integrity }), ...(shasum === undefined ? {} : { shasum }) },
    tableCraft: declared,
  };
}

/**
 * The versions of a private package on `channel`, newest first, that carry a tarball and a
 * checksum. A version without `tableCraft` stays in: GitLab drops the field, so the installer
 * reads it from the tarball instead.
 */
export function candidateVersions(
  packument: unknown,
  packageName: string,
  channel: ReleaseChannel,
): RegistryCandidate[] {
  const versions = (packument as { versions?: unknown } | null)?.versions;
  const candidates = Object.values(typeof versions === "object" && versions !== null ? versions : {})
    .map(readCandidate)
    .filter((entry): entry is RegistryCandidate => entry !== null && onChannel(entry.version, channel))
    .sort((left, right) => compareVersions(right.version, left.version));
  if (candidates.length > 0) return candidates;
  throw new PluginInstallError(
    "notFound",
    `The registry has no ${channel} release of ${packageName} with a checksum.`,
    channel === "stable"
      ? "Check the package name; for a beta, set Updates → Channel to beta in Settings."
      : "Check the package name and that the registry holds a published version.",
  );
}

/** The error `pickVersion` gives when the newest version needs another plugin API. */
export function incompatibleError(
  packageName: string,
  version: string,
  apiVersion: string,
  hostVersion: string = API_VERSION,
): PluginInstallError {
  const why = incompatibility(apiVersion, hostVersion);
  const hint =
    why === "newer"
      ? "Update TableCraft, then install the plugin again."
      : "Install a version of the plugin built for this TableCraft, from a file.";
  return new PluginInstallError(
    "incompatible",
    `${packageName} ${version} needs plugin API ${apiVersion}; this TableCraft provides ${hostVersion}.`,
    hint,
  );
}

/** True when `version` is a release newer than `than`. */
export function isNewerRelease(version: string, than: string): boolean {
  const left = releaseParts(version);
  const right = releaseParts(than);
  return left !== null && (right === null || newer(left, right));
}

function notOnRegistry(packageName: string, access: RegistryAccess): PluginInstallError {
  return new PluginInstallError(
    "notFound",
    `${packageName} is not on the registry ${access.url}.`,
    access.private && access.token === null
      ? `Check the package name; a registry that hides packages from strangers needs a token. ${UNAUTHORIZED_HINT}`
      : "Check the registry in Settings → Plugins, or install the plugin from a file.",
  );
}

export async function fetchPackument(
  fetch: RegistryFetch,
  access: RegistryAccess,
  packageName: string,
): Promise<unknown> {
  const registry = access.url;
  let response: Response;
  try {
    response = await request(fetch, access, packumentUrl(registry, packageName), {
      headers: { accept: PACKUMENT_ACCEPT },
      stayOnOrigin: true,
    });
  } catch (cause) {
    if (cause instanceof CrossOriginRedirect) throw notOnRegistry(packageName, access);
    throw cause;
  }
  if (response.status === NOT_FOUND) throw notOnRegistry(packageName, access);
  if (UNAUTHORIZED.has(response.status)) throw unauthorized(registry, response.status);
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
  access: RegistryAccess,
  url: string,
  onProgress: (received: number, total: number | null) => void,
): Promise<Buffer> {
  let response: Response;
  try {
    response = await request(fetch, access, url);
  } catch (cause) {
    if (!(cause instanceof CrossOriginRedirect)) throw cause;
    throw new PluginInstallError(
      "insecureUrl",
      `The plugin download was redirected to ${originOf(cause.location) ?? cause.location}, away from the registry it was authorized for, so it stopped there.`,
      "Nothing was installed. Ask the registry's administrator to serve packages from its own address.",
    );
  }
  if (UNAUTHORIZED.has(response.status)) throw unauthorized(access.url, response.status);
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

function hashesOf(integrity: string | undefined, prefix: string): string[] {
  return (integrity ?? "")
    .split(/\s+/)
    .filter((hash) => hash.startsWith(prefix))
    .map((hash) => hash.slice(prefix.length));
}

function mismatch(packageName: string, algorithm: string): PluginInstallError {
  return new PluginInstallError(
    "integrity",
    `The download of ${packageName} does not match the registry's ${algorithm} checksum, so it was not installed.`,
    "Nothing was installed. Try again later; if it persists, the registry or a proxy is altering the package.",
  );
}

/**
 * Checks `bytes` against the packument's `dist`. A sha512 `integrity` always decides when there is
 * one. Without it, `allowSha1` (private registries only, decision 158) accepts a SHA-1 from
 * `integrity` or the hex `shasum` GitLab gives; the official registry always has sha512.
 */
export function checkIntegrity(
  bytes: Uint8Array,
  dist: { readonly integrity?: string; readonly shasum?: string },
  packageName: string,
  allowSha1: boolean,
): void {
  const sha512 = hashesOf(dist.integrity, SHA512);
  if (sha512.length > 0) {
    if (sha512.includes(createHash("sha512").update(bytes).digest("base64"))) return;
    throw mismatch(packageName, "sha512");
  }
  const sha1 = createHash("sha1").update(bytes);
  const sha1Hashes = [
    ...hashesOf(dist.integrity, SHA1),
    ...(dist.shasum === undefined ? [] : [Buffer.from(dist.shasum, "hex").toString("base64")]),
  ];
  if (allowSha1 && sha1Hashes.length > 0) {
    if (sha1Hashes.includes(sha1.digest("base64"))) return;
    throw mismatch(packageName, "SHA-1");
  }
  throw new PluginInstallError(
    "integrity",
    `The registry gave no sha512 checksum for ${packageName}, so it was not installed.`,
    "Nothing was installed. Try again later; if it persists, the registry or a proxy is altering the package.",
  );
}
