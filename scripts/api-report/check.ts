/**
 * `bun run api:report` writes the plugin-api surface reports; `bun run api:check` regenerates them,
 * fails when they differ from the committed ones, and checks `API_VERSION` against the reports at
 * the last release tag (decision 107).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { API_VERSION } from "@table-craft/plugin-api";
import {
  checkVersion,
  classify,
  parseCompatibilityFile,
  type CompatibilityFile,
  type SurfaceChange,
} from "./classify.js";
import { generateReports, REPORT_DIRECTORY, REPORT_ENTRIES, type ApiReport } from "./generate.js";
import { parseReport, type SurfaceModel } from "./model.js";

export const COMPATIBILITY_FILE = `${REPORT_DIRECTORY}/compatibility.json`;
const RELEASE_TAG_PATTERN = "v*";
// A beta never publishes plugin-api, so an addition first shipped in a beta must still raise
// API_VERSION against the stable release before it.
const PRERELEASE_TAG_PATTERN = "v*-*";
const WRITE_FLAG = "--write";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Runs git with `args`; throws when git fails. */
export type Git = (args: readonly string[]) => string;

export const quietGit =
  (root: string): Git =>
  (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export interface Baseline {
  tag: string;
  /** Committed report text at the tag, by report path; undefined where the tag has none. */
  reports: Map<string, string | undefined>;
}

export interface CheckResult {
  problems: string[];
  notes: string[];
  changes: SurfaceChange[];
}

export function readBaseline(git: Git): Baseline | null {
  let tag: string;
  try {
    tag = git([
      "describe",
      "--tags",
      "--abbrev=0",
      "--match",
      RELEASE_TAG_PATTERN,
      "--exclude",
      PRERELEASE_TAG_PATTERN,
    ]);
  } catch {
    return null;
  }
  const reports = new Map<string, string | undefined>();
  for (const entry of REPORT_ENTRIES) {
    try {
      reports.set(entry.report, git(["show", `${tag}:${entry.report}`]) + "\n");
    } catch {
      reports.set(entry.report, undefined);
    }
  }
  return { tag, reports };
}

function emptyModel(entry: string, apiVersion: string): SurfaceModel {
  return { entry, apiVersion, symbols: new Map() };
}

/** Compares freshly generated reports with the release's; the pure half of `api:check`. */
export function compareWithBaseline(
  current: readonly ApiReport[],
  baseline: Baseline | null,
  compatibility: CompatibilityFile,
): CheckResult {
  if (baseline === null) {
    return { problems: [], notes: ["No release tag is reachable; the version check is skipped."], changes: [] };
  }
  const texts = [...baseline.reports.values()].filter((text): text is string => text !== undefined);
  const [first] = texts;
  if (first === undefined) {
    return {
      problems: [],
      notes: [`${baseline.tag} predates the surface reports; the version check is skipped.`],
      changes: [],
    };
  }
  const baselineVersion = parseReport(first).apiVersion;
  const currentModels = current.map((report) => parseReport(report.text));
  const currentVersion = currentModels[0]?.apiVersion ?? API_VERSION;
  const changes = current.flatMap((report, index) => {
    const text = baseline.reports.get(report.entry.report);
    const before = text === undefined ? emptyModel(report.entry.specifier, baselineVersion) : parseReport(text);
    const after = currentModels[index] ?? emptyModel(report.entry.specifier, currentVersion);
    return classify(before, after, compatibility);
  });
  return {
    problems: checkVersion(baselineVersion, currentVersion, changes),
    notes: [`Compared with ${baseline.tag} (plugin API ${baselineVersion}); ${changes.length} change(s).`],
    changes,
  };
}

function readCompatibility(root: string): CompatibilityFile {
  const path = join(root, COMPATIBILITY_FILE);
  return existsSync(path) ? parseCompatibilityFile(readFileSync(path, "utf8")) : { classifications: [] };
}

/** Regenerates the reports, compares them with the committed files and with the last release. */
export function checkSurface(root: string, git: Git, apiVersion = API_VERSION): CheckResult {
  const reports = generateReports(root, apiVersion);
  const stale = reports.filter((report) => {
    const path = join(root, report.entry.report);
    return !existsSync(path) || readFileSync(path, "utf8") !== report.text;
  });
  const result = compareWithBaseline(reports, readBaseline(git), readCompatibility(root));
  if (stale.length === 0) return result;
  const files = stale.map((report) => report.entry.report).join(", ");
  return {
    ...result,
    problems: [`The plugin-api surface changed; run \`bun run api:report\` and commit ${files}.`, ...result.problems],
  };
}

export function writeReports(root: string, apiVersion = API_VERSION): string[] {
  return generateReports(root, apiVersion).map((report) => {
    const path = join(root, report.entry.report);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, report.text);
    return report.entry.report;
  });
}

function main(args: readonly string[]): void {
  if (args.includes(WRITE_FLAG)) {
    for (const path of writeReports(ROOT)) console.log(`wrote ${path}`);
    return;
  }
  const result = checkSurface(ROOT, quietGit(ROOT));
  for (const note of result.notes) console.log(note);
  for (const change of result.changes) console.log(`  ${change.kind}: ${change.description}`);
  if (result.problems.length === 0) {
    console.log(`plugin API ${API_VERSION}: surface reports are current.`);
    return;
  }
  for (const problem of result.problems) console.error(problem);
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
