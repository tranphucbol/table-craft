/**
 * Whether this copy of TableCraft can replace itself, decided from facts main gathers once. Pure;
 * the file system is reached only through `writable`.
 */
import { dirname, join, sep } from "node:path";
import { compareVersions, type UpdateManifest } from "@table-craft/desktop/main/update/manifest.js";

export const INELIGIBLE_REASONS = [
  "unpackaged",
  "noAsset",
  "tooOld",
  "translocated",
  "readOnlyVolume",
  "notWritable",
  "appManagement",
  "notAppImage",
] as const;
export type IneligibleReason = (typeof INELIGIBLE_REASONS)[number];

/** Where the update goes, per platform; decided here so the updater never branches on `platform` itself. */
export type InstallTarget =
  | { readonly kind: "macBundle"; readonly bundlePath: string }
  | { readonly kind: "nsis" }
  | { readonly kind: "appImage"; readonly appImagePath: string };

export interface InstallFacts {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly packaged: boolean;
  readonly currentVersion: string;
  /** `process.execPath`. */
  readonly executablePath: string;
  /** `$APPIMAGE`, set by the AppImage runtime to the image's own path; undefined otherwise. */
  readonly appImagePath: string | undefined;
  readonly writable: (directory: string) => boolean;
  /**
   * Whether TableCraft may change its own `.app`. macOS App Management can refuse that to an
   * ad-hoc signed app whose folder is writable, and otherwise only the swap script finds out.
   */
  readonly bundleModifiable: (bundlePath: string) => boolean;
}

export type Eligibility =
  | { readonly eligible: true; readonly target: InstallTarget }
  | { readonly eligible: false; readonly reason: IneligibleReason };

const APP_BUNDLE_SUFFIX = ".app";
/** `X.app/Contents/MacOS/X`: the bundle is three levels above the executable. */
const BUNDLE_DEPTH = 3;
/** Gatekeeper's App Translocation runs a quarantined app from a randomised read-only mount. */
const TRANSLOCATION_SEGMENT = `${sep}AppTranslocation${sep}`;
/** Where a mounted DMG lives; replacing a bundle there is replacing it on a read-only image. */
const VOLUMES_PREFIX = `${sep}Volumes${sep}`;

/** The `.app` the executable runs from, or null when it is not inside one. */
export function bundlePathFrom(executablePath: string): string | null {
  let path = executablePath;
  for (let level = 0; level < BUNDLE_DEPTH; level += 1) path = dirname(path);
  return path.endsWith(APP_BUNDLE_SUFFIX) && join(path, "Contents", "MacOS") === dirname(executablePath) ? path : null;
}

function macTarget(facts: InstallFacts): Eligibility {
  const bundlePath = bundlePathFrom(facts.executablePath);
  if (bundlePath === null) return { eligible: false, reason: "unpackaged" };
  if (bundlePath.includes(TRANSLOCATION_SEGMENT)) return { eligible: false, reason: "translocated" };
  if (bundlePath.startsWith(VOLUMES_PREFIX)) return { eligible: false, reason: "readOnlyVolume" };
  if (!facts.writable(dirname(bundlePath))) return { eligible: false, reason: "notWritable" };
  if (!facts.bundleModifiable(bundlePath)) return { eligible: false, reason: "appManagement" };
  return { eligible: true, target: { kind: "macBundle", bundlePath } };
}

function appImageTarget(facts: InstallFacts): Eligibility {
  const path = facts.appImagePath;
  if (path === undefined || path === "") return { eligible: false, reason: "notAppImage" };
  if (!facts.writable(dirname(path))) return { eligible: false, reason: "notWritable" };
  return { eligible: true, target: { kind: "appImage", appImagePath: path } };
}

/** Checked in the order a user can act on: a missing asset or version floor before anything local. */
export function eligibility(facts: InstallFacts, manifest: UpdateManifest, assetKey: string): Eligibility {
  if (!facts.packaged) return { eligible: false, reason: "unpackaged" };
  if (manifest.assets[assetKey] === undefined) return { eligible: false, reason: "noAsset" };
  if (manifest.minimumVersion !== null && compareVersions(facts.currentVersion, manifest.minimumVersion) < 0)
    return { eligible: false, reason: "tooOld" };
  if (facts.platform === "darwin") return macTarget(facts);
  if (facts.platform === "win32") return { eligible: true, target: { kind: "nsis" } };
  if (facts.platform === "linux") return appImageTarget(facts);
  return { eligible: false, reason: "noAsset" };
}

/** Shared with the swap failure, which ends the same way when the permission went missing after the check. */
export const APP_MANAGEMENT_HINT =
  "macOS does not allow TableCraft to replace itself. Turn TableCraft on in System Settings → Privacy & Security → App Management and check again, or download and install the release by hand.";

/** What the popover says; each names what to do instead. */
export const INELIGIBLE_MESSAGES: Readonly<Record<IneligibleReason, string>> = {
  unpackaged: "This is a development build; it cannot replace itself. Download the release instead.",
  noAsset: "This release has no build for this platform and architecture. See the release page.",
  tooOld: "This version is too old to update in place. Download and install the release by hand.",
  translocated:
    "macOS is running TableCraft from a temporary read-only copy. Move TableCraft.app to Applications, open it from there, and check again.",
  readOnlyVolume:
    "TableCraft is running from a disk image. Drag it to Applications, open it from there, and check again.",
  notWritable: "TableCraft cannot write to the folder it is installed in. Download and install the release by hand.",
  appManagement: APP_MANAGEMENT_HINT,
  notAppImage: "Only the AppImage updates itself. Install the release from the release page.",
};
