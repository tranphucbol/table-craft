import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHECKSUMS_FILE,
  ChecksumsScriptError,
  checksumsBody,
  checksumsOf,
} from "../../packages/desktop/scripts/checksums.js";

const SCRIPT = join(import.meta.dirname, "../../packages/desktop/scripts/checksums.ts");
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** The stock checker on this host: GNU coreutils on Linux, Perl's shasum on macOS. */
const CHECKER = process.platform === "darwin" ? ["shasum", "-a", "256"] : ["sha256sum"];

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "table-craft-checksums-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function releaseAssets(): Promise<{ installers: string; plugins: string }> {
  const installers = join(root, "installers");
  const plugins = join(root, "plugin-packages");
  await mkdir(installers);
  await mkdir(plugins);
  await writeFile(join(installers, "TableCraft-0.2.0-arm64.dmg"), "abc");
  await writeFile(join(installers, "update-manifest.json"), "");
  await writeFile(join(plugins, "tablecraft-app-plugin-postgres-0.2.0.tgz"), "tarball");
  return { installers, plugins };
}

function writeChecksums(installers: string, plugins: string) {
  const out = join(installers, CHECKSUMS_FILE);
  return spawnSync(
    "bun",
    [
      SCRIPT,
      "--out",
      out,
      join(installers, "TableCraft-0.2.0-arm64.dmg"),
      join(installers, "update-manifest.json"),
      join(installers, CHECKSUMS_FILE),
      join(plugins, "tablecraft-app-plugin-postgres-0.2.0.tgz"),
    ],
    { encoding: "utf8" },
  );
}

function check(directory: string) {
  const [command = "", ...args] = CHECKER;
  return spawnSync(command, [...args, "-c", CHECKSUMS_FILE], { cwd: directory, encoding: "utf8" });
}

describe("release checksums", () => {
  it("givenFiles_whenListed_thenOneTextModeLinePerFileSortedByName", () => {
    const body = checksumsBody([
      { name: "update-manifest.json", sha256: SHA256_EMPTY },
      { name: "TableCraft-0.2.0-arm64.dmg", sha256: SHA256_ABC },
    ]);

    expect(body.toString()).toBe(`${SHA256_ABC}  TableCraft-0.2.0-arm64.dmg\n${SHA256_EMPTY}  update-manifest.json\n`);
  });

  it.each([
    ["no files", []],
    [
      "two files of one name",
      [
        { name: "a.tgz", sha256: SHA256_ABC },
        { name: "a.tgz", sha256: SHA256_EMPTY },
      ],
    ],
    ["a name with a space", [{ name: "Table Craft.dmg", sha256: SHA256_ABC }]],
    ["a name with a newline", [{ name: "a\nb.dmg", sha256: SHA256_ABC }]],
    ["a hash that is not hex", [{ name: "a.dmg", sha256: "z".repeat(64) }]],
  ])("givenFiles with %s_whenListed_thenItFailsSayingWhy", (_situation, files) => {
    expect(() => checksumsBody(files)).toThrow(ChecksumsScriptError);
  });

  it("givenTheOutputAmongThePaths_whenHashed_thenItIsSkipped", async () => {
    const out = join(root, CHECKSUMS_FILE);
    await writeFile(join(root, "a.dmg"), "abc");
    await writeFile(out, "stale");

    const files = await checksumsOf([join(root, "a.dmg"), out], out);

    expect(files).toEqual([{ name: "a.dmg", sha256: SHA256_ABC }]);
  });

  it("givenADirectory_whenHashed_thenItFailsAskingForFiles", async () => {
    await expect(checksumsOf([root], join(root, CHECKSUMS_FILE))).rejects.toThrow(/is not a file/);
  });

  it("givenTheReleaseAssets_whenWritten_thenTheStockCheckerPassesEveryFile", async () => {
    const { installers, plugins } = await releaseAssets();

    const written = writeChecksums(installers, plugins);
    await writeFile(join(installers, "tablecraft-app-plugin-postgres-0.2.0.tgz"), "tarball");
    const checked = check(installers);

    expect(written.status, written.stderr).toBe(0);
    expect(await readFile(join(installers, CHECKSUMS_FILE), "utf8")).toContain(
      `${SHA256_ABC}  TableCraft-0.2.0-arm64.dmg`,
    );
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stdout.trim().split("\n")).toEqual([
      "TableCraft-0.2.0-arm64.dmg: OK",
      "tablecraft-app-plugin-postgres-0.2.0.tgz: OK",
      "update-manifest.json: OK",
    ]);
  });

  it("givenADamagedDownload_whenChecked_thenTheStockCheckerFails", async () => {
    const { installers, plugins } = await releaseAssets();
    writeChecksums(installers, plugins);
    await writeFile(join(installers, "tablecraft-app-plugin-postgres-0.2.0.tgz"), "tarball");
    await writeFile(join(installers, "TableCraft-0.2.0-arm64.dmg"), "abd");

    const checked = check(installers);

    expect(checked.status).not.toBe(0);
    expect(checked.stdout).toContain("TableCraft-0.2.0-arm64.dmg: FAILED");
  });
});
