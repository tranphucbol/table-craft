/**
 * Reads an npm package tarball (gzip over ustar, with pax headers) without running or trusting
 * anything in it: only regular files under `package/` come out, and any link, device, absolute
 * path or `..` refuses the whole tarball (decision 110).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { PluginInstallError } from "@table-craft/desktop/main/pluginStore/errors.js";

export interface PackageFile {
  /** Relative to the package root, `/`-separated, e.g. `index.js`. */
  readonly path: string;
  readonly data: Buffer;
}

const BLOCK_BYTES = 512;
const PACKAGE_PREFIX = "package/";
const NAME = [0, 100] as const;
const SIZE = [124, 136] as const;
const CHECKSUM = [148, 156] as const;
const TYPE_OFFSET = 156;
const MAGIC = [257, 262] as const;
const PREFIX = [345, 500] as const;
const USTAR = "ustar";
const OCTAL = 8;
const SPACE = 0x20;
const REGULAR_TYPES = new Set(["0", "\0", "7"]);
const DIRECTORY_TYPE = "5";
const PAX_TYPE = "x";
const PAX_GLOBAL_TYPE = "g";
const PAX_PATH = "path";
/** A Windows drive (`C:`) makes a path absolute there even when Node on POSIX would not say so. */
const DRIVE = /^[A-Za-z]:/;
const CORRUPT_HINT = "Download it again, or ask the plugin's author for a new package.";

function corrupt(detail: string): PluginInstallError {
  return new PluginInstallError("invalid", `The plugin package is not a valid npm tarball: ${detail}.`, CORRUPT_HINT);
}

function unsafe(path: string, why: string): PluginInstallError {
  return new PluginInstallError(
    "unsafeEntry",
    `The plugin package was refused: entry "${path}" ${why}.`,
    "Nothing was installed. Get the plugin from its official source.",
  );
}

function text(header: Buffer, [start, end]: readonly [number, number]): string {
  const field = header.subarray(start, end);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

function octal(header: Buffer, field: readonly [number, number], name: string): number {
  const raw = text(header, field).trim();
  if (!/^[0-7]+$/.test(raw)) throw corrupt(`${name} "${raw}" is not octal`);
  return Number.parseInt(raw, OCTAL);
}

function checksumMatches(header: Buffer): boolean {
  let sum = 0;
  for (let index = 0; index < BLOCK_BYTES; index++) {
    sum += index >= CHECKSUM[0] && index < CHECKSUM[1] ? SPACE : (header[index] ?? 0);
  }
  return sum === octal(header, CHECKSUM, "checksum");
}

/** `<length> <key>=<value>\n` records (POSIX pax); only `path` matters here. */
function paxPath(data: Buffer): string | null {
  let path: string | null = null;
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(SPACE, offset);
    if (space === -1) throw corrupt("a pax record has no length");
    const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isInteger(length) || length <= 0) throw corrupt("a pax record has a bad length");
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals !== -1 && record.slice(0, equals) === PAX_PATH) path = record.slice(equals + 1);
    offset += length;
  }
  return path;
}

/** The path below `package/`, or an error when it could land anywhere else. */
function packagePath(path: string): string {
  if (path.startsWith("/") || path.includes("\\") || DRIVE.test(path)) throw unsafe(path, "is an absolute path");
  if (path.split("/").includes("..")) throw unsafe(path, "climbs out of the package with ..");
  if (!path.startsWith(PACKAGE_PREFIX)) throw unsafe(path, "is outside the package/ folder");
  return path.slice(PACKAGE_PREFIX.length).replace(/\/+$/, "");
}

/** Every regular file in the gzipped tarball `bytes`; refuses it whole on the first unsafe entry. */
export function readPackageTarball(bytes: Uint8Array): PackageFile[] {
  let archive: Buffer;
  try {
    archive = gunzipSync(bytes);
  } catch (cause) {
    throw corrupt(`it does not unzip (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  const files: PackageFile[] = [];
  let offset = 0;
  let nextPath: string | null = null;
  while (offset + BLOCK_BYTES <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) break;
    if (!text(header, MAGIC).startsWith(USTAR)) throw corrupt("a header is not ustar");
    if (!checksumMatches(header)) throw corrupt("a header checksum does not match");
    const size = octal(header, SIZE, "size");
    const type = String.fromCharCode(header[TYPE_OFFSET] ?? 0);
    const dataStart = offset + BLOCK_BYTES;
    const data = archive.subarray(dataStart, dataStart + size);
    if (data.length !== size) throw corrupt("it ends inside a file");
    offset = dataStart + Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;
    if (type === PAX_TYPE) {
      nextPath = paxPath(data);
      continue;
    }
    if (type === PAX_GLOBAL_TYPE) continue;
    const prefix = text(header, PREFIX);
    const name = nextPath ?? (prefix === "" ? text(header, NAME) : `${prefix}/${text(header, NAME)}`);
    nextPath = null;
    const path = packagePath(name);
    if (type === DIRECTORY_TYPE) continue;
    if (!REGULAR_TYPES.has(type)) throw unsafe(name, "is a link or a device, not a file");
    if (path === "") throw corrupt("a file has no name");
    files.push({ path, data: Buffer.from(data) });
  }
  return files;
}

/** Writes `files` under `directory`, checking once more that each lands inside it. */
export async function writePackageFiles(directory: string, files: readonly PackageFile[]): Promise<void> {
  const root = resolve(directory);
  for (const file of files) {
    const target = resolve(root, file.path);
    const inside = relative(root, target);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside))
      throw unsafe(file.path, "leaves the plugin folder");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.data);
  }
}
