/**
 * Writes `SHA256SUMS` for a release (plan 128, decision 135): one `<sha256>  <name>` line per file
 * the release attaches, sorted by name, in the format `sha256sum -c` and `shasum -a 256 -c` read.
 * Pass exactly the files `gh release create` attaches, so the list and the release cannot drift:
 *
 *   bun packages/desktop/scripts/checksums.ts --out installers/SHA256SUMS installers/* plugin-packages/*.tgz
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";

export const CHECKSUMS_FILE = "SHA256SUMS";
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** What `sha256sum` and `shasum` can read back from a line; a release asset name never needs more. */
const SAFE_NAME = /^[A-Za-z0-9._+-]+$/;

export class ChecksumsScriptError extends Error {
  override readonly name = "ChecksumsScriptError";
}

export interface FileChecksum {
  readonly name: string;
  readonly sha256: string;
}

export async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The file's exact bytes: GNU text-mode lines (two spaces), sorted by name so a rerun matches. */
export function checksumsBody(files: readonly FileChecksum[]): Buffer {
  if (files.length === 0) throw new ChecksumsScriptError("No files to checksum; pass the release assets.");
  const seen = new Set<string>();
  for (const file of files) {
    if (!SAFE_NAME.test(file.name))
      throw new ChecksumsScriptError(`"${file.name}" is not a release asset name; rename it or leave it out.`);
    if (!SHA256_HEX.test(file.sha256))
      throw new ChecksumsScriptError(`"${file.sha256}" is not a SHA-256 for ${file.name}.`);
    if (seen.has(file.name))
      throw new ChecksumsScriptError(`Two files are named ${file.name}; a release attaches one of each name.`);
    seen.add(file.name);
  }
  const lines = [...files]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((file) => `${file.sha256}  ${file.name}\n`);
  return Buffer.from(lines.join(""));
}

/** Hashes `paths`, skipping `out` itself, so `installers/*` may already hold a previous run's file. */
export async function checksumsOf(paths: readonly string[], out: string): Promise<FileChecksum[]> {
  const files: FileChecksum[] = [];
  for (const path of paths) {
    if (resolve(path) === resolve(out)) continue;
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile())
      throw new ChecksumsScriptError(`${path} is not a file; pass the files the release attaches.`);
    files.push({ name: basename(path), sha256: await sha256Of(path) });
  }
  return files;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options: { out: { type: "string" } }, allowPositionals: true });
  const out = values.out ?? CHECKSUMS_FILE;
  const body = checksumsBody(await checksumsOf(positionals, out));
  await writeFile(out, body);
  console.log(`${out}: ${body.toString().split("\n").length - 1} files`);
}

if (import.meta.main) await main();
