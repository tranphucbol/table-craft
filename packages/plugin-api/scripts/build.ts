/**
 * Stages the publishable `@table-craft/plugin-api` in `packages/plugin-api/release/` (decision 107):
 * JavaScript and declarations compiled from `src/` into `dist/`, a `package.json` whose exports
 * point there and whose version is `API_VERSION`, this package's README and the repository's
 * LICENSE. The workspace package stays private and exports TypeScript source; only the staged copy
 * is publishable (`npm publish release/`, which this repository does not run yet).
 * `bun run --cwd packages/plugin-api build` stages it.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { API_VERSION } from "@table-craft/plugin-api";

const PACKAGE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(PACKAGE_DIRECTORY, "..", "..");
const BUILD_CONFIG = join(PACKAGE_DIRECTORY, "tsconfig.build.json");
const PACKAGE_FILE = "package.json";
const README_FILE = "README.md";
const LICENSE_FILE = "LICENSE";
const DIST = "dist";
const JSON_INDENT = 2;
const ENTRIES = { ".": "index", "./sql": "sql/index", "./testing": "testing/index" } as const;
/** Fields of the workspace `package.json` that describe the published package unchanged. */
const COPIED_FIELDS = [
  "description",
  "license",
  "type",
  "repository",
  "dependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "publishConfig",
] as const;

export const RELEASE_DIRECTORY = join(PACKAGE_DIRECTORY, "release");

export class PackageBuildError extends Error {
  override readonly name = "PackageBuildError";
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => ROOT,
    getNewLine: () => "\n",
  });
}

function compile(outDir: string): void {
  const config = ts.getParsedCommandLineOfConfigFile(
    BUILD_CONFIG,
    { outDir },
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
  );
  if (config === undefined || config.errors.length > 0) {
    throw new PackageBuildError(`Cannot read ${BUILD_CONFIG}: ${formatDiagnostics(config?.errors ?? [])}`);
  }
  const program = ts.createProgram(config.fileNames, config.options);
  const emitted = program.emit();
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics];
  if (diagnostics.length > 0 || emitted.emitSkipped) {
    throw new PackageBuildError(`plugin-api does not compile; fix these first:\n${formatDiagnostics(diagnostics)}`);
  }
}

function releaseManifest(): Record<string, unknown> {
  const workspace = JSON.parse(readFileSync(join(PACKAGE_DIRECTORY, PACKAGE_FILE), "utf8")) as Record<string, unknown>;
  const manifest: Record<string, unknown> = { name: workspace.name, version: API_VERSION };
  for (const field of COPIED_FIELDS) {
    if (workspace[field] !== undefined) manifest[field] = workspace[field];
  }
  manifest.files = [DIST];
  manifest.exports = Object.fromEntries(
    Object.entries(ENTRIES).map(([specifier, entry]) => [
      specifier,
      { types: `./${DIST}/${entry}.d.ts`, default: `./${DIST}/${entry}.js` },
    ]),
  );
  return manifest;
}

/** Stages the package and returns its directory. */
export function stagePackage(): string {
  rmSync(RELEASE_DIRECTORY, { recursive: true, force: true });
  mkdirSync(RELEASE_DIRECTORY, { recursive: true });
  compile(join(RELEASE_DIRECTORY, DIST));
  writeFileSync(join(RELEASE_DIRECTORY, PACKAGE_FILE), `${JSON.stringify(releaseManifest(), null, JSON_INDENT)}\n`);
  copyFileSync(join(PACKAGE_DIRECTORY, README_FILE), join(RELEASE_DIRECTORY, README_FILE));
  copyFileSync(join(ROOT, LICENSE_FILE), join(RELEASE_DIRECTORY, LICENSE_FILE));
  return RELEASE_DIRECTORY;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`staged ${stagePackage()}`);
