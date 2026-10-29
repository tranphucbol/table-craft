import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { API_VERSION } from "@table-craft/plugin-api";
import { checkVersion, classify, parseCompatibilityFile, requiredVersion } from "../../scripts/api-report/classify.js";
import { checkSurface, compareWithBaseline, quietGit, readBaseline } from "../../scripts/api-report/check.js";
import { generateReports, renderReport, REPORT_ENTRIES } from "../../scripts/api-report/generate.js";
import { parseReport, ReportFormatError } from "../../scripts/api-report/model.js";

const ROOT = join(import.meta.dirname, "..", "..");
const ENTRY = "@table-craft/plugin-api";
const RELEASED = "1.0.0";
const NEXT_MINOR = "1.1.0";
const LIVE_SURFACE_TIMEOUT_MS = 60_000;

const SESSION = [
  "interface Session {",
  "  close(): Promise<void>;",
  "  execute(sql: string): Promise<ExecuteResult>;",
  "}",
  "",
  "interface ExecuteResult {",
  "  readonly rows: readonly Row[];",
  "}",
  "",
  "type Row = readonly WireValue[];",
];

function report(version: string, lines: readonly string[]): string {
  return [`# Public surface of \`${ENTRY}\``, "", `API_VERSION: ${version}`, "", "```ts", ...lines, "```", ""].join(
    "\n",
  );
}

function check(before: readonly string[], after: readonly string[], version: string, classifications = "[]") {
  const changes = classify(
    parseReport(report(RELEASED, before)),
    parseReport(report(version, after)),
    parseCompatibilityFile(`{ "classifications": ${classifications} }`),
  );
  return { changes, problems: checkVersion(RELEASED, version, changes) };
}

function replaced(lines: readonly string[], from: string, to: string | null): string[] {
  return lines.flatMap((line) => (line === from ? (to === null ? [] : [to]) : [line]));
}

describe("API surface report", () => {
  it("givenUnchangedSurface_whenChecked_thenPasses", () => {
    const { changes, problems } = check(SESSION, SESSION, RELEASED);

    expect(changes).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("givenAddedExport_withoutMinorBump_whenChecked_thenFailsNamingIt", () => {
    const { changes, problems } = check(SESSION, [...SESSION, "", "const NEW_LIMIT = 10;"], RELEASED);

    expect(changes).toEqual([{ key: "NEW_LIMIT", kind: "addition", description: "NEW_LIMIT was added" }]);
    expect(problems.join("\n")).toMatch(/need API_VERSION 1\.1\.0[\s\S]*NEW_LIMIT was added/);
  });

  it("givenAddedExport_withMinorBump_whenChecked_thenPasses", () => {
    const { problems } = check(SESSION, [...SESSION, "", "const NEW_LIMIT = 10;"], NEXT_MINOR);

    expect(problems).toEqual([]);
  });

  it("givenRemovedField_whenChecked_thenFailsAskingForMajor", () => {
    const after = replaced(SESSION, "  readonly rows: readonly Row[];", null);

    const { changes, problems } = check(SESSION, after, NEXT_MINOR);

    expect(changes.map((change) => [change.key, change.kind])).toEqual([["ExecuteResult.rows", "breaking"]]);
    expect(problems.join("\n")).toMatch(/need API_VERSION 2\.0\.0, a new major, which only the user may take/);
  });

  it("givenRemovedField_classifiedAsAddition_whenChecked_thenStillBreaking", () => {
    const after = replaced(SESSION, "  readonly rows: readonly Row[];", null);
    const verdict = '[{ "key": "ExecuteResult.rows", "kind": "addition", "reason": "unused" }]';

    const { changes } = check(SESSION, after, NEXT_MINOR, verdict);

    expect(changes.map((change) => change.kind)).toEqual(["breaking"]);
  });

  it("givenNewRequiredMember_whenChecked_thenBreaking", () => {
    const after = replaced(SESSION, "  close(): Promise<void>;", "  close(): Promise<void>;\n  ping(): Promise<void>;");

    const { changes } = check(SESSION, after.join("\n").split("\n"), NEXT_MINOR);

    expect(changes.map((change) => [change.key, change.kind])).toEqual([["Session.ping", "breaking"]]);
  });

  it("givenNewOptionalMember_whenChecked_thenAddition", () => {
    const after = [...SESSION.slice(0, 2), "  ping?(): Promise<void>;", ...SESSION.slice(2)];

    const { changes, problems } = check(SESSION, after, NEXT_MINOR);

    expect(changes.map((change) => [change.key, change.kind])).toEqual([["Session.ping", "addition"]]);
    expect(problems).toEqual([]);
  });

  it("givenChangedSignature_unclassified_whenChecked_thenFailsAskingForClassification", () => {
    const after = replaced(
      SESSION,
      "  execute(sql: string): Promise<ExecuteResult>;",
      "  execute(sql: string, options?: ExecuteOptions): Promise<ExecuteResult>;",
    );

    const { changes, problems } = check(SESSION, after, NEXT_MINOR);

    expect(changes.map((change) => [change.key, change.kind])).toEqual([["Session.execute", "unclassified"]]);
    expect(problems.join("\n")).toMatch(/need a verdict in packages\/plugin-api\/api\/compatibility\.json/);
  });

  it("givenChangedSignature_classifiedAsAddition_whenChecked_thenNeedsMinor", () => {
    const after = replaced(
      SESSION,
      "type Row = readonly WireValue[];",
      "type Row = readonly (WireValue | Uint8Array)[];",
    );
    const verdict = '[{ "key": "Row", "kind": "addition", "reason": "plugins return rows; the host reads both" }]';

    const sameVersion = check(SESSION, after, RELEASED, verdict);
    const nextMinor = check(SESSION, after, NEXT_MINOR, verdict);

    expect(sameVersion.changes.map((change) => change.kind)).toEqual(["addition"]);
    expect(sameVersion.problems.join("\n")).toMatch(/need API_VERSION 1\.1\.0/);
    expect(nextMinor.problems).toEqual([]);
  });

  it("givenDeprecatedMember_whenChecked_thenAddition", () => {
    const after = replaced(SESSION, "  close(): Promise<void>;", "  /** @deprecated */ close(): Promise<void>;");

    const { changes } = check(SESSION, after, NEXT_MINOR);

    expect(changes.map((change) => [change.key, change.kind])).toEqual([["Session.close", "addition"]]);
  });

  it("givenVersionBelowRelease_whenChecked_thenFails", () => {
    expect(checkVersion("1.2.0", "1.1.0", [])).toEqual([
      "API_VERSION 1.1.0 is below the release's 1.2.0; it never goes back.",
    ]);
  });

  it("givenChanges_whenRequiredVersionAsked_thenMinorForAdditionsAndMajorForBreaks", () => {
    const addition = { key: "A", kind: "addition" as const, description: "A was added" };
    const breaking = { key: "B", kind: "breaking" as const, description: "B was removed" };

    expect(requiredVersion("1.4.2", [])).toBe("1.4.2");
    expect(requiredVersion("1.4.2", [addition])).toBe("1.5.0");
    expect(requiredVersion("1.4.2", [addition, breaking])).toBe("2.0.0");
  });

  it("givenTextThatIsNotAReport_whenParsed_thenRefused", () => {
    expect(() => parseReport("# notes\n")).toThrow(ReportFormatError);
  });

  it("givenTagWithoutReports_whenCompared_thenSkippedWithNote", () => {
    const reports = REPORT_ENTRIES.map((entry) => ({ entry, text: report(RELEASED, SESSION) }));
    const baseline = { tag: "v0.9.0", reports: new Map(REPORT_ENTRIES.map((entry) => [entry.report, undefined])) };

    const result = compareWithBaseline(reports, baseline, { classifications: [] });

    expect(result.problems).toEqual([]);
    expect(result.notes).toEqual(["v0.9.0 predates the surface reports; the version check is skipped."]);
  });

  it("givenBetaTagAfterStable_whenBaselineRead_thenStableTag", () => {
    const repository = mkdtempSync(join(tmpdir(), "api-baseline-"));
    try {
      const git = quietGit(repository);
      git(["init", "--quiet"]);
      for (const tag of ["v1.0.0", "v1.1.0-beta.1"]) {
        git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", tag]);
        git(["tag", tag]);
      }

      expect(readBaseline(git)?.tag).toBe("v1.0.0");
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it(
    "givenLiveSurface_whenRegenerated_thenMatchesCommittedReports",
    () => {
      const reports = generateReports(ROOT, API_VERSION);

      for (const generated of reports) {
        const committed = readFileSync(join(ROOT, generated.entry.report), "utf8");
        expect(generated.text, `${generated.entry.report} is stale; run \`bun run api:report\``).toBe(committed);
        expect(renderReport(parseReport(committed))).toBe(committed);
      }
    },
    LIVE_SURFACE_TIMEOUT_MS,
  );

  it(
    "givenLiveSurface_whenComparedWithLastReleaseTag_thenVersionSuffices",
    () => {
      const result = checkSurface(ROOT, quietGit(ROOT));

      expect(result.problems).toEqual([]);
    },
    LIVE_SURFACE_TIMEOUT_MS,
  );
});
