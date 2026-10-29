/**
 * Publishes the packed `.tgz` files (decision 109): plugin-api first, since plugins are built
 * against it, then each plugin. A version already on the registry is skipped, so rerunning a
 * failed release is safe. The dist-tag is `latest`, or `next` for a pre-release version.
 *
 * `bun scripts/plugins/publish.ts [--from <dir>] [--dry-run] [--provenance] [--dist-tag <tag>]
 * [--notes <file> [--release <version>]]`. Only `.github/workflows/publish-plugins.yml` runs it
 * without `--dry-run`.
 */
import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PUBLISHED_NAME } from "../../packages/plugin-api/scripts/build.js";
import { readPackageTarball } from "../../packages/desktop/src/main/pluginStore/tarball.js";
import { compareVersions } from "../../packages/desktop/src/main/update/manifest.js";
import { PACKAGES_DIRECTORY } from "./pack.js";

const PACKAGE_FILE = "package.json";
const TARBALL = ".tgz";
const NOT_FOUND = "E404";
const LATEST = "latest";
const NEXT = "next";

export interface NpmResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type Npm = (args: readonly string[]) => NpmResult;

export const systemNpm: Npm = (args) => {
  const result = spawnSync("npm", args, { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
};

export class PublishError extends Error {
  override readonly name = "PublishError";
}

export interface PackageTarball {
  readonly file: string;
  readonly name: string;
  readonly version: string;
}

export interface PublishOutcome extends PackageTarball {
  readonly status: "published" | "skipped";
  readonly distTag: string;
}

export interface PublishOptions {
  readonly packages: readonly PackageTarball[];
  readonly dryRun: boolean;
  readonly provenance: boolean;
  /** Overrides the tag picked from each version. */
  readonly distTag?: string;
  readonly npm?: Npm;
  readonly log?: (line: string) => void;
}

export function distTagFor(version: string): string {
  return version.includes("-") ? NEXT : LATEST;
}

/** plugin-api first, then the plugins by name. */
export function publishOrder<T extends PackageTarball>(packages: readonly T[]): T[] {
  const rank = (entry: T) => (entry.name === PUBLISHED_NAME ? 0 : 1);
  return [...packages].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** True when `name@version` is already on the registry; a 404 means it is not. */
export function alreadyPublished(npm: Npm, name: string, version: string): boolean {
  const result = npm(["view", `${name}@${version}`, "version", "--json"]);
  if (result.status === 0) return result.stdout.trim() !== "";
  if (result.stderr.includes(NOT_FOUND) || result.stdout.includes(NOT_FOUND)) return false;
  throw new PublishError(
    `Cannot tell whether ${name}@${version} is on the registry: ${result.stderr.trim()}. Check the network and npm login, then rerun.`,
  );
}

export async function readTarballs(directory: string): Promise<PackageTarball[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(TARBALL)).sort();
  if (names.length === 0) throw new PublishError(`No ${TARBALL} in ${directory}; run scripts/plugins/pack.ts first.`);
  const tarballs: PackageTarball[] = [];
  for (const name of names) {
    const file = join(directory, name);
    const packageFile = readPackageTarball(await readFile(file)).find((entry) => entry.path === PACKAGE_FILE);
    const json = JSON.parse(packageFile?.data.toString("utf8") ?? "{}") as { name?: unknown; version?: unknown };
    if (typeof json.name !== "string" || typeof json.version !== "string") {
      throw new PublishError(`${file} has no package.json name and version; repack it.`);
    }
    tarballs.push({ file, name: json.name, version: json.version });
  }
  return tarballs;
}

export function publishPackages(options: PublishOptions): PublishOutcome[] {
  const npm = options.npm ?? systemNpm;
  const log = options.log ?? (() => undefined);
  const outcomes: PublishOutcome[] = [];
  for (const entry of publishOrder(options.packages)) {
    const distTag = options.distTag ?? distTagFor(entry.version);
    if (alreadyPublished(npm, entry.name, entry.version)) {
      log(`skip ${entry.name}@${entry.version}: already on the registry`);
      outcomes.push({ ...entry, status: "skipped", distTag });
      continue;
    }
    const args = ["publish", entry.file, "--access", "public", "--tag", distTag];
    if (options.provenance) args.push("--provenance");
    if (options.dryRun) args.push("--dry-run");
    const result = npm(args);
    if (result.status !== 0) {
      throw new PublishError(
        `npm publish ${entry.name}@${entry.version} failed: ${result.stderr.trim()}. Fix it and rerun; published versions are skipped.`,
      );
    }
    if (options.dryRun) log(result.stderr.trim());
    log(`${options.dryRun ? "would publish" : "published"} ${entry.name}@${entry.version} (${distTag})`);
    outcomes.push({ ...entry, status: "published", distTag });
  }
  return outcomes;
}

function outcomeNote(entry: PublishOutcome, release: string | undefined): string {
  if (entry.status === "published") return ` (\`${entry.distTag}\`)`;
  const older = release !== undefined && compareVersions(entry.version, release) < 0;
  return older ? ` (unchanged, still \`${entry.version}\`)` : " (already published)";
}

/**
 * The section appended to the release notes. Given the `release` version, a skipped package older
 * than it reads as unchanged, attached by `pack.ts --reuse-published`; one at the release's own
 * version was published by an earlier run of the same release.
 */
export function releaseNotes(outcomes: readonly PublishOutcome[], release?: string): string {
  const lines = outcomes.map(
    (entry) =>
      `- [\`${entry.name}@${entry.version}\`](https://www.npmjs.com/package/${entry.name}/v/${entry.version})` +
      outcomeNote(entry, release),
  );
  return ["", "### Plugins on npm", "", ...lines, ""].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      "dry-run": { type: "boolean" },
      provenance: { type: "boolean" },
      "dist-tag": { type: "string" },
      notes: { type: "string" },
      release: { type: "string" },
    },
  });
  const packages = await readTarballs(values.from === undefined ? PACKAGES_DIRECTORY : resolve(values.from));
  const outcomes = publishPackages({
    packages,
    dryRun: values["dry-run"] === true,
    provenance: values.provenance === true,
    ...(values["dist-tag"] === undefined ? {} : { distTag: values["dist-tag"] }),
    log: (line) => console.log(line),
  });
  if (values.notes !== undefined) await writeFile(values.notes, releaseNotes(outcomes, values.release));
}
