/**
 * The live test's way in (plan 020): a local release served over loopback http, signed with a
 * throwaway key. Honoured only by a development run or a build packaged with
 * `TABLE_CRAFT_UPDATE_TEST_BUILD=1`; the release workflow refuses that variable, so an installed
 * release only ever trusts {@link RELEASE_TRUST} and the GitHub URL (decision 044).
 */
import { MANIFEST_FILE, RELEASE_TRUST, type ManifestTrust } from "@table-craft/desktop/main/update/manifest.js";

export const RELEASE_MANIFEST_URL = `https://github.com/tranphucbol/table-craft/releases/latest/download/${MANIFEST_FILE}`;
/**
 * GitHub's `releases/latest` skips pre-releases, so the publish-channel workflow commits each beta's
 * signed manifest to this branch instead (decision 134); the signature, not the host, is trusted.
 */
export const BETA_MANIFEST_URL = `https://raw.githubusercontent.com/tranphucbol/table-craft/refs/heads/chore/update-channels/beta/${MANIFEST_FILE}`;
/** Where Help → Check for Updates sends a user whose install cannot update itself and no notes are known. */
export const RELEASES_PAGE_URL = "https://github.com/tranphucbol/table-craft/releases/latest";

export const UPDATE_OVERRIDE_ENV = {
  manifestUrl: "TABLE_CRAFT_UPDATE_MANIFEST_URL",
  betaManifestUrl: "TABLE_CRAFT_UPDATE_BETA_MANIFEST_URL",
  /** A path to a PEM public key, read at launch. */
  publicKey: "TABLE_CRAFT_UPDATE_PUBLIC_KEY",
  firstCheckMs: "TABLE_CRAFT_UPDATE_FIRST_CHECK_MS",
} as const;

/** After the first window shows, so the check never competes with launch (plan 020 decision 6). */
export const FIRST_CHECK_DELAY_MS = 10_000;
export const CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;

export interface UpdateEndpoint {
  readonly manifestUrl: string;
  readonly betaManifestUrl: string;
  readonly trust: ManifestTrust;
  readonly firstCheckMs: number;
  /** Whether anything here came from the environment; logged at launch so a test build says so. */
  readonly overridden: boolean;
}

export function updateEndpoint(
  env: Readonly<Record<string, string | undefined>>,
  honoured: boolean,
  readKey: (path: string) => string,
): UpdateEndpoint {
  const release: UpdateEndpoint = {
    manifestUrl: RELEASE_MANIFEST_URL,
    betaManifestUrl: BETA_MANIFEST_URL,
    trust: RELEASE_TRUST,
    firstCheckMs: FIRST_CHECK_DELAY_MS,
    overridden: false,
  };
  if (!honoured) return release;
  const manifestUrl = env[UPDATE_OVERRIDE_ENV.manifestUrl] ?? "";
  const betaManifestUrl = env[UPDATE_OVERRIDE_ENV.betaManifestUrl] ?? "";
  const keyPath = env[UPDATE_OVERRIDE_ENV.publicKey] ?? "";
  const firstCheckText = env[UPDATE_OVERRIDE_ENV.firstCheckMs] ?? "";
  const firstCheck = firstCheckText === "" ? Number.NaN : Number(firstCheckText);
  if (manifestUrl === "" && betaManifestUrl === "" && keyPath === "" && firstCheckText === "") return release;
  return {
    manifestUrl: manifestUrl === "" ? release.manifestUrl : manifestUrl,
    betaManifestUrl: betaManifestUrl === "" ? release.betaManifestUrl : betaManifestUrl,
    trust: {
      publicKeyPem: keyPath === "" ? release.trust.publicKeyPem : readKey(keyPath),
      allowLoopbackHttp: manifestUrl !== "" || betaManifestUrl !== "",
    },
    firstCheckMs: Number.isFinite(firstCheck) && firstCheck >= 0 ? firstCheck : release.firstCheckMs,
    overridden: true,
  };
}
