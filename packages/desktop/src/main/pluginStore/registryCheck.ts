/**
 * Test connection for a private registry (decision 158): one packument request, authorized as an
 * install would be, read as reached, refused or failed.
 */
import { PluginInstallError } from "@table-craft/desktop/main/pluginStore/errors.js";
import {
  fetchPackument,
  type RegistryAccess,
  type RegistryFetch,
} from "@table-craft/desktop/main/pluginStore/registry.js";
import type { RegistryCheck } from "@table-craft/desktop/preload/bridge.js";

/**
 * Asked for when the registry names no package yet. Its 404 proves the registry answered; GitLab
 * redirects an unknown package to npmjs whatever the token, so only a known package proves a token.
 */
export const PROBE_PACKAGE = "tablecraft-registry-check";

/** The package Test asks for: the first one the registry serves, else the probe under its first scope. */
export function checkedPackage(packages: readonly string[], scopes: readonly string[]): string | null {
  const known = packages.find((name) => scopes.some((scope) => name.startsWith(`${scope}/`)));
  if (known !== undefined) return known;
  const scope = scopes[0];
  return scope === undefined ? null : `${scope}/${PROBE_PACKAGE}`;
}

export async function checkRegistry(
  fetch: RegistryFetch,
  access: RegistryAccess,
  packageName: string,
  probe: boolean,
  now: () => number = Date.now,
): Promise<RegistryCheck> {
  try {
    await fetchPackument(fetch, access, packageName);
    return { status: "reached", at: now() };
  } catch (cause) {
    if (!(cause instanceof PluginInstallError)) {
      return { status: "failed", at: now(), message: cause instanceof Error ? cause.message : String(cause) };
    }
    if (cause.failure === "unauthorized") return { status: "refused", at: now(), httpStatus: cause.httpStatus ?? 0 };
    if (cause.failure === "notFound" && probe) return { status: "reached", at: now() };
    return { status: "failed", at: now(), message: cause.message };
  }
}
