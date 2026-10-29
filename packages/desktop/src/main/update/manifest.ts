/**
 * The signed document that says a newer TableCraft exists (decision 044). Pure but for
 * `node:crypto`: bytes in, a verdict out, so every branch runs against a key pair a test generates.
 *
 * The signature covers this document, not the payload; the payload is reached through the
 * `sha256` each asset carries, which is only worth anything because it sits inside the signature.
 */
import { createPublicKey, verify } from "node:crypto";
import { isReleaseChannel, type ReleaseChannel } from "@table-craft/desktop/settings/channel.js";

/**
 * The public half of TableCraft's update key. Committed, never fetched: a key the app downloads is
 * a key an attacker can substitute. Changing it strands every install that has not updated, because
 * an installed build trusts only the key compiled into it (decision 044).
 */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAqNvGHGNMVPoN8blP/r/j8l1ggxcS0i/JCH8i7fmWt9w=
-----END PUBLIC KEY-----
`;

/** The one manifest shape this build reads; any other is refused rather than guessed at. */
export const MANIFEST_SCHEMA = 1;
export const MANIFEST_FILE = "update-manifest.json";
/** The detached Ed25519 signature over the manifest's exact bytes, base64, published beside it. */
export const SIGNATURE_FILE = `${MANIFEST_FILE}.sig`;

/** `${process.platform}-${process.arch}`, the key of {@link UpdateManifest.assets}. */
export type AssetKey = string;

export interface UpdateAsset {
  readonly url: string;
  readonly size: number;
  /** Lowercase hex; the download is hashed as it streams and compared with this. */
  readonly sha256: string;
}

export interface UpdateManifest {
  readonly schema: typeof MANIFEST_SCHEMA;
  readonly version: string;
  /**
   * Signed with the rest, so a beta manifest served where the stable one lives is refused by a
   * stable-channel app (plan 124). A manifest without it is stable: every one before betas existed.
   */
  readonly channel: ReleaseChannel;
  readonly notesUrl: string;
  /** The oldest installed version that may update in place; an older one is sent to the release page. */
  readonly minimumVersion: string | null;
  readonly assets: Readonly<Record<AssetKey, UpdateAsset>>;
}

export const MANIFEST_REJECTIONS = ["signature", "schema", "malformed"] as const;
export type ManifestRejection = (typeof MANIFEST_REJECTIONS)[number];

export type ManifestVerdict =
  | { readonly ok: true; readonly manifest: UpdateManifest }
  | { readonly ok: false; readonly reason: ManifestRejection; readonly detail: string };

export interface ManifestTrust {
  readonly publicKeyPem: string;
  /**
   * Whether an asset may be served over plain http from a loopback host. Only the live test's local
   * release sets it, through an override a release build never honours (`overrides.ts`).
   */
  readonly allowLoopbackHttp: boolean;
}

export const RELEASE_TRUST: ManifestTrust = { publicKeyPem: UPDATE_PUBLIC_KEY, allowLoopbackHttp: false };

const DEFAULT_CHANNEL: ReleaseChannel = "stable";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HTTPS = "https:";
const HTTP = "http:";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const SIGNATURE_ENCODING = "base64";
/** An Ed25519 signature is 64 bytes, whatever the encoding around it. */
const ED25519_SIGNATURE_BYTES = 64;

export function assetKey(platform: string, arch: string): AssetKey {
  return `${platform}-${arch}`;
}

export function isVersion(value: unknown): value is string {
  return typeof value === "string" && SEMVER.test(value);
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Semver order: -1, 0 or 1. A prerelease sorts below its release, so `0.0.0-dev.<sha>`, what a
 * packaged build off an untagged commit reports (decision 033), is older than every release.
 */
export function compareVersions(left: string, right: string): number {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (a === null || b === null) throw new Error(`"${a === null ? left : right}" is not a semver version.`);
  for (let index = 1; index <= 3; index += 1) {
    const order = Math.sign(Number(a[index]) - Number(b[index]));
    if (order !== 0) return order;
  }
  const [preA, preB] = [a[4], b[4]];
  if (preA === undefined || preB === undefined) return preA === preB ? 0 : preA === undefined ? 1 : -1;
  const partsA = preA.split(".");
  const partsB = preB.split(".");
  for (let index = 0; index < Math.max(partsA.length, partsB.length); index += 1) {
    const [partA, partB] = [partsA[index], partsB[index]];
    if (partA === undefined) return -1;
    if (partB === undefined) return 1;
    const order = compareIdentifiers(partA, partB);
    if (order !== 0) return order;
  }
  return 0;
}

export function signatureValid(body: Uint8Array, signature: string, publicKeyPem: string): boolean {
  try {
    const bytes = Buffer.from(signature.trim(), SIGNATURE_ENCODING);
    if (bytes.length !== ED25519_SIGNATURE_BYTES) return false;
    return verify(null, body, createPublicKey(publicKeyPem), bytes);
  } catch {
    return false;
  }
}

function assetUrlAllowed(value: string, trust: ManifestTrust): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === HTTPS) return true;
  return trust.allowLoopbackHttp && url.protocol === HTTP && LOOPBACK_HOSTS.has(url.hostname);
}

function readAsset(value: unknown, trust: ManifestTrust): UpdateAsset | string {
  if (typeof value !== "object" || value === null) return "is not an object";
  const { url, size, sha256 } = value as Record<string, unknown>;
  if (typeof url !== "string" || !assetUrlAllowed(url, trust)) return `has a URL that is not https: ${String(url)}`;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return "has no positive size";
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) return "has no lowercase hex sha256";
  return { url, size, sha256 };
}

function readManifest(value: unknown, trust: ManifestTrust): ManifestVerdict {
  const malformed = (detail: string): ManifestVerdict => ({ ok: false, reason: "malformed", detail });
  if (typeof value !== "object" || value === null || Array.isArray(value)) return malformed("not a JSON object");
  const document = value as Record<string, unknown>;
  if (document.schema !== MANIFEST_SCHEMA)
    return {
      ok: false,
      reason: "schema",
      detail: `schema ${String(document.schema)}, this build reads ${MANIFEST_SCHEMA}`,
    };
  if (!isVersion(document.version)) return malformed(`version "${String(document.version)}" is not semver`);
  const channel = document.channel ?? DEFAULT_CHANNEL;
  if (!isReleaseChannel(channel)) return malformed(`channel ${JSON.stringify(channel)} is neither stable nor beta`);
  if (typeof document.notesUrl !== "string" || !document.notesUrl.startsWith(`${HTTPS}//`))
    return malformed("notesUrl is not an https URL");
  const minimumVersion = document.minimumVersion ?? null;
  if (minimumVersion !== null && !isVersion(minimumVersion)) return malformed("minimumVersion is not semver");
  if (typeof document.assets !== "object" || document.assets === null || Array.isArray(document.assets))
    return malformed("assets is not an object");
  const assets: Record<AssetKey, UpdateAsset> = {};
  for (const [key, raw] of Object.entries(document.assets)) {
    const asset = readAsset(raw, trust);
    if (typeof asset === "string") return malformed(`asset ${key} ${asset}`);
    assets[key] = asset;
  }
  return {
    ok: true,
    manifest: {
      schema: MANIFEST_SCHEMA,
      version: document.version,
      channel,
      notesUrl: document.notesUrl,
      minimumVersion,
      assets,
    },
  };
}

/**
 * The signature is checked over the raw bytes before they are parsed, so nothing unauthenticated
 * is ever interpreted, not even as JSON.
 */
export function verifyManifest(body: Uint8Array, signature: string, trust: ManifestTrust): ManifestVerdict {
  if (!signatureValid(body, signature, trust.publicKeyPem))
    return { ok: false, reason: "signature", detail: "the manifest signature does not match TableCraft's update key" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { ok: false, reason: "malformed", detail: "not JSON" };
  }
  return readManifest(parsed, trust);
}
