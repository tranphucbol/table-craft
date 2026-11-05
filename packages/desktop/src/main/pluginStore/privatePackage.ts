/**
 * Picks the release of a package on a private registry (decision 158). GitLab's packuments carry
 * no `tableCraft` field, so a version is judged by the `package.json` inside its tarball; the
 * newest few are downloaded until one fits this TableCraft.
 */
import { API_VERSION, isCompatible } from "@table-craft/plugin-api";
import { PluginInstallError } from "@table-craft/desktop/main/pluginStore/errors.js";
import {
  readManifestSummary,
  readPackageJson,
  type ManifestSummary,
  type PackageJson,
} from "@table-craft/desktop/main/pluginStore/packageFile.js";
import {
  candidateVersions,
  checkIntegrity,
  downloadTarball,
  fetchPackument,
  incompatibleError,
  type RegistryAccess,
  type RegistryFetch,
} from "@table-craft/desktop/main/pluginStore/registry.js";
import { readPackageTarball, type PackageFile } from "@table-craft/desktop/main/pluginStore/tarball.js";
import type { ReleaseChannel } from "@table-craft/desktop/settings/channel.js";

/** Tarballs read before giving up: each is a download, and a newer TableCraft is the likelier fix. */
export const MAX_PRIVATE_DOWNLOADS = 3;

export interface PrivateRelease {
  readonly meta: PackageJson;
  readonly summary: ManifestSummary;
  readonly files: readonly PackageFile[];
  readonly bytes: number;
  readonly integrity: "sha512" | "sha1";
}

export interface PrivateReleaseRequest {
  readonly fetch: RegistryFetch;
  readonly access: RegistryAccess;
  readonly packageName: string;
  readonly channel: ReleaseChannel;
  readonly hostVersion?: string;
  readonly onProgress: (received: number, total: number | null) => void;
  /** True when the installed copy already is, or should stay, `version`: nothing is downloaded. */
  readonly keeps?: (version: string) => Promise<boolean>;
}

function mismatch(packageName: string, version: string, meta: PackageJson): PluginInstallError {
  return new PluginInstallError(
    "invalid",
    `The registry's ${packageName} ${version} holds ${meta.name} ${meta.version} (${meta.id}).`,
    "Nothing was installed. Check the registry in Settings → Plugins.",
  );
}

/** The newest release on the channel this host can load; null when `keeps` stopped at the installed one. */
export async function resolvePrivateRelease(request: PrivateReleaseRequest): Promise<PrivateRelease | null> {
  const { packageName, access } = request;
  const hostVersion = request.hostVersion ?? API_VERSION;
  const packument = await fetchPackument(request.fetch, access, packageName);
  let refused: { version: string; apiVersion: string } | null = null;
  let downloads = 0;
  for (const candidate of candidateVersions(packument, packageName, request.channel)) {
    if ((await request.keeps?.(candidate.version)) === true) return null;
    if (candidate.tableCraft !== null && !isCompatible(candidate.tableCraft.apiVersion, hostVersion)) {
      refused ??= { version: candidate.version, apiVersion: candidate.tableCraft.apiVersion };
      continue;
    }
    if (downloads === MAX_PRIVATE_DOWNLOADS) break;
    downloads += 1;
    const bytes = await downloadTarball(request.fetch, access, candidate.tarball, request.onProgress);
    const integrity = checkIntegrity(bytes, candidate.dist, packageName, true);
    const files = readPackageTarball(bytes);
    const meta = readPackageJson(files);
    if (meta.name !== packageName || meta.version !== candidate.version) {
      throw mismatch(packageName, candidate.version, meta);
    }
    const summary = readManifestSummary(files, meta.id);
    const apiVersion = meta.apiVersion ?? summary.apiVersion;
    if (apiVersion !== null && isCompatible(apiVersion, hostVersion)) {
      return { meta, summary, files, bytes: bytes.byteLength, integrity };
    }
    refused ??= { version: candidate.version, apiVersion: apiVersion ?? "none" };
  }
  if (refused === null) {
    throw new PluginInstallError(
      "notFound",
      `The registry has no ${request.channel} release of ${packageName} for this TableCraft.`,
      "Check the package name and that the registry holds a published version.",
    );
  }
  throw incompatibleError(packageName, refused.version, refused.apiVersion, hostVersion);
}
