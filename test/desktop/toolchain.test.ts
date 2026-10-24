import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const BUN_VERSION = readFileSync(join(ROOT, ".bun-version"), "utf8").trim();
const DOCKERFILE_DEFAULT = /^ARG BUN_VERSION=(\S+)$/m;
const README_VERSION = /\[Bun\]\([^)]*\) (\S+) \(the version in `\.bun-version`\)/;
const E2E_SERVICE = /^ {2}e2e:\n((?: {4}.*\n|\s*\n)+)/m;
const BUILD_ARG_FROM_ENVIRONMENT = /^ {4}build:\n {6}context: \.\.\/e2e\/docker\n {6}args:\n {8}BUN_VERSION:\n/m;

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("toolchain pin", () => {
  it("givenBunVersionFile_whenDockerfileRead_thenItsDefaultMatches", () => {
    expect(read("test/e2e/docker/Dockerfile").match(DOCKERFILE_DEFAULT)?.[1]).toBe(BUN_VERSION);
  });

  it("givenBunVersionFile_whenReadmeRead_thenItNamesTheSameVersion", () => {
    expect(read("README.md").match(README_VERSION)?.[1]).toBe(BUN_VERSION);
  });

  it("givenComposeFile_whenE2eBuildRead_thenItPassesBunVersionFromTheEnvironment", () => {
    const service = read("test/db/compose.yml").match(E2E_SERVICE)?.[1] ?? "";
    expect(service).toMatch(BUILD_ARG_FROM_ENVIRONMENT);
  });
});
