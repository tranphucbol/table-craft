/**
 * Writes and signs `update-manifest.json` for a release (plan 020, decision 044): hashes the
 * installers in a directory, names each by platform and architecture, signs the document with the
 * Ed25519 key in `TABLE_CRAFT_UPDATE_SIGNING_KEY`, and checks the signature against the public key
 * the app compiles in, so a secret that does not match it fails the release instead of every install.
 *
 *   bun packages/desktop/scripts/update-manifest.ts --tag v0.2.0 --assets installers --out installers
 *
 * `--key-file`, `--public-key-file` and `--base-url` exist for the live test's local release only.
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  assetKey,
  isVersion,
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  SIGNATURE_FILE,
  UPDATE_PUBLIC_KEY,
  verifyManifest,
  type UpdateAsset,
} from "../src/main/update/manifest.js";
import { channelOf } from "../src/settings/channel.js";
import { releaseTagVersion } from "./version.js";

export const SIGNING_KEY_ENV = "TABLE_CRAFT_UPDATE_SIGNING_KEY";
/** The live test's build flag; a release must never be built with it (decision 044). */
export const TEST_BUILD_ENV = "TABLE_CRAFT_UPDATE_TEST_BUILD";
const REPOSITORY_URL = "https://github.com/tranphucbol/table-craft";
/** electron-builder's `${productName}-${version}-${arch}.${ext}` (electron-builder.yml). */
const INSTALLER = /^TableCraft-(.+)-(x64|arm64|x86_64|aarch64)\.(zip|exe|AppImage)$/;
const PLATFORM_OF_EXTENSION: Readonly<Record<string, NodeJS.Platform>> = {
  zip: "darwin",
  exe: "win32",
  AppImage: "linux",
};
const ARCH_ALIASES: Readonly<Record<string, string>> = { x86_64: "x64", aarch64: "arm64" };

export class ManifestScriptError extends Error {
  override readonly name = "ManifestScriptError";
}

export interface InstallerFile {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

/** The manifest key an installer file serves, or null for anything else in the directory (blockmaps, DMGs). */
export function installerKey(name: string, version: string): string | null {
  const match = INSTALLER.exec(name);
  if (match === null || match[1] !== version) return null;
  const [, , arch = "", extension = ""] = match;
  const platform = PLATFORM_OF_EXTENSION[extension];
  return platform === undefined ? null : assetKey(platform, ARCH_ALIASES[arch] ?? arch);
}

export interface ManifestInput {
  readonly version: string;
  readonly notesUrl: string;
  readonly minimumVersion: string | null;
  readonly baseUrl: string;
  readonly installers: readonly InstallerFile[];
}

/** The manifest's exact bytes; the signature covers these, so they are written as they are signed. */
export function manifestBody(input: ManifestInput): Buffer {
  const assets: Record<string, UpdateAsset> = {};
  for (const file of [...input.installers].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = installerKey(file.name, input.version);
    if (key === null) continue;
    if (assets[key] !== undefined) throw new ManifestScriptError(`Two installers serve ${key}; keep one.`);
    assets[key] = { url: `${input.baseUrl}${encodeURIComponent(file.name)}`, size: file.size, sha256: file.sha256 };
  }
  if (Object.keys(assets).length === 0)
    throw new ManifestScriptError(
      `No TableCraft-${input.version}-<arch>.zip, .exe or .AppImage found; build the installers first.`,
    );
  const document = {
    schema: MANIFEST_SCHEMA,
    version: input.version,
    channel: channelOf(input.version),
    notesUrl: input.notesUrl,
    minimumVersion: input.minimumVersion,
    assets,
  };
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
}

export function signBody(body: Buffer, privateKeyPem: string): string {
  return sign(null, body, createPrivateKey(privateKeyPem)).toString("base64");
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function installersIn(directory: string): Promise<InstallerFile[]> {
  const files: InstallerFile[] = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const info = await stat(path);
    if (info.isFile() && INSTALLER.test(name)) files.push({ name, size: info.size, sha256: await sha256Of(path) });
  }
  return files;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tag: { type: "string" },
      assets: { type: "string" },
      out: { type: "string" },
      "minimum-version": { type: "string" },
      "base-url": { type: "string" },
      "notes-url": { type: "string" },
      "key-file": { type: "string" },
      "public-key-file": { type: "string" },
    },
  });
  const version = releaseTagVersion(values.tag ?? "");
  if (version === null)
    throw new ManifestScriptError(`--tag must be vX.Y.Z or vX.Y.Z-beta.N, not "${values.tag ?? ""}".`);
  const testRelease = values["key-file"] !== undefined || values["base-url"] !== undefined;
  if ((process.env[TEST_BUILD_ENV] ?? "") !== "" && !testRelease)
    throw new ManifestScriptError(`${TEST_BUILD_ENV} is set; a release is never a test build. Unset it.`);
  const minimumVersion = values["minimum-version"] ?? null;
  if (minimumVersion !== null && !isVersion(minimumVersion))
    throw new ManifestScriptError(`--minimum-version must be semver, not "${values["minimum-version"] ?? ""}".`);
  const privateKeyPem =
    values["key-file"] === undefined
      ? (process.env[SIGNING_KEY_ENV] ?? "")
      : await readFile(values["key-file"], "utf8");
  if (privateKeyPem.trim() === "")
    throw new ManifestScriptError(`${SIGNING_KEY_ENV} is empty; add the repository secret (decision 044).`);
  const publicKeyPem =
    values["public-key-file"] === undefined ? UPDATE_PUBLIC_KEY : await readFile(values["public-key-file"], "utf8");
  const assets = values.assets ?? ".";
  const body = manifestBody({
    version,
    notesUrl: values["notes-url"] ?? `${REPOSITORY_URL}/releases/tag/v${version}`,
    minimumVersion,
    baseUrl: values["base-url"] ?? `${REPOSITORY_URL}/releases/download/v${version}/`,
    installers: await installersIn(assets),
  });
  const signature = signBody(body, privateKeyPem);
  const verdict = verifyManifest(body, signature, { publicKeyPem, allowLoopbackHttp: testRelease });
  if (!verdict.ok)
    throw new ManifestScriptError(
      `The signed manifest does not verify (${verdict.reason}: ${verdict.detail}); the signing key does not match the public key in src/main/update/manifest.ts.`,
    );
  const out = values.out ?? assets;
  await writeFile(join(out, MANIFEST_FILE), body);
  await writeFile(join(out, SIGNATURE_FILE), `${signature}\n`);
  console.log(`${MANIFEST_FILE} for ${version}: ${Object.keys(verdict.manifest.assets).join(", ")}`);
}

if (import.meta.main) await main();
