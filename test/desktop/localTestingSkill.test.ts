import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SKILL_DIRECTORY = ".agents/skills/local-testing";
const SKILL_NAME = "local-testing";
const SKILL_FILE = join(SKILL_DIRECTORY, "SKILL.md");
const REFERENCES_DIRECTORY = join(SKILL_DIRECTORY, "references");
const PARALLEL_CHECKOUTS = join(REFERENCES_DIRECTORY, "parallel-checkouts.md");
const DATABASES = join(REFERENCES_DIRECTORY, "databases.md");
const SMOKE_SCENARIOS = join(REFERENCES_DIRECTORY, "smoke-scenarios.md");
const COMPOSE_FILE = "test/db/compose.yml";
const HARNESS_FILE = "test/e2e/harness.ts";
const HELPERS_HEADING = "## Harness helpers";
/** Set by the headless box for its own network, never by a checkout. */
const BOX_ONLY_PORTS = new Set(["TABLE_CRAFT_TIDB_E2E_PORT"]);
/** Folders the skill names that are git-ignored, so a fresh clone has none of them. */
const UNTRACKED_PREFIXES = ["docs/evidence/", "packages/desktop/release/"];
const REPOSITORY_PATH = /`((?:\.agents|\.github|docs|packages|plugins|scripts|test)\/[^`\s]*)`/g;
const PLACEHOLDER = /NNN|<[^>]+>/;
const BUN_RUN = /bun run (\w[\w:-]*)/g;
const COMPOSE_PORT = /\$\{(TABLE_CRAFT_\w+_PORTS?):-([\d-]+)\}/g;
const PORT_ROW = /^\| `(TABLE_CRAFT_\w+)` +\| ([\d-]+) +\|/gm;
const MARKDOWN_LINK = /\]\(([^)#\s]+\.md)\)/g;
const CODE_SPAN = /`(\w+)`/g;
const FRONTMATTER_NAME = /^---\nname: ([\w-]+)\n/;

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function skillFiles(): string[] {
  const references = readdirSync(join(ROOT, REFERENCES_DIRECTORY)).map((name) => join(REFERENCES_DIRECTORY, name));
  return [SKILL_FILE, ...references];
}

function captures(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1] ?? "");
}

function composePorts(): Map<string, string> {
  const ports = [...read(COMPOSE_FILE).matchAll(COMPOSE_PORT)]
    .filter((match) => !BOX_ONLY_PORTS.has(match[1] ?? ""))
    .map((match): [string, string] => [match[1] ?? "", match[2] ?? ""]);
  return new Map(ports);
}

function helperNames(): string[] {
  const text = read(SMOKE_SCENARIOS);
  const start = text.indexOf(HELPERS_HEADING);
  const end = text.indexOf("\n## ", start + HELPERS_HEADING.length);
  const rows = text
    .slice(start, end === -1 ? undefined : end)
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| :"))
    .slice(1);
  return rows.flatMap((row) => captures(row.split("|")[2] ?? "", CODE_SPAN));
}

describe("local-testing skill", () => {
  it("givenSkill_whenFrontmatterRead_thenItIsNamedAfterItsFolder", () => {
    expect(FRONTMATTER_NAME.exec(read(SKILL_FILE))?.[1]).toBe(SKILL_NAME);
  });

  it("givenSkillFiles_whenScriptsRun_thenEveryScriptExists", () => {
    const scripts = Object.keys((JSON.parse(read("package.json")) as { scripts: object }).scripts);
    for (const file of skillFiles()) {
      for (const script of captures(read(file), BUN_RUN)) {
        expect(scripts, `${file}: bun run ${script}`).toContain(script);
      }
    }
  });

  it("givenSkillFiles_whenRepositoryPathsNamed_thenEachExists", () => {
    for (const file of skillFiles()) {
      const paths = captures(read(file), REPOSITORY_PATH).filter(
        (path) => !PLACEHOLDER.test(path) && !UNTRACKED_PREFIXES.some((prefix) => path.startsWith(prefix)),
      );
      for (const path of paths) expect(existsSync(join(ROOT, path)), `${file}: ${path}`).toBe(true);
    }
  });

  it("givenSkillFiles_whenLinkingAnotherPage_thenThePageExists", () => {
    for (const file of skillFiles()) {
      for (const link of captures(read(file), MARKDOWN_LINK)) {
        expect(existsSync(join(ROOT, dirname(file), link)), `${file}: ${link}`).toBe(true);
      }
    }
  });

  it("givenParallelCheckouts_whenPortTableRead_thenItMatchesComposeDefaults", () => {
    const table = new Map(
      [...read(PARALLEL_CHECKOUTS).matchAll(PORT_ROW)].map((match): [string, string] => [
        match[1] ?? "",
        match[2] ?? "",
      ]),
    );

    expect(Object.fromEntries(table)).toEqual(Object.fromEntries(composePorts()));
  });

  it("givenParallelCheckouts_whenExampleRead_thenItMovesEveryPort", () => {
    const text = read(PARALLEL_CHECKOUTS);
    for (const [variable, port] of composePorts()) {
      const assigned = new RegExp(`${variable}=([\\d-]+)`).exec(text)?.[1];
      expect(assigned, variable).toBeDefined();
      expect(assigned, variable).not.toBe(port);
    }
  });

  it("givenDatabasesReference_whenRead_thenItNamesEveryDefaultPort", () => {
    const text = read(DATABASES);
    for (const [variable, port] of composePorts()) expect(text, `${variable} ${port}`).toContain(port);
  });

  it("givenSmokeScenarios_whenHelpersListed_thenEachIsAHarnessExport", () => {
    const harness = read(HARNESS_FILE);
    const helpers = helperNames();

    expect(helpers.length).toBeGreaterThan(0);
    for (const helper of helpers) {
      expect(harness, helper).toMatch(new RegExp(`^export (?:async )?(?:function|const) ${helper}\\b`, "m"));
    }
  });
});
