import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ESLint, type Linter } from "eslint";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUDGET_FIXTURE = "packages/desktop/src/engine/fixture.ts";
const MAX_LINES_RULE_ID = "max-lines";

interface Budget {
  readonly MAX_LINES: number;
  readonly OVERSIZED_FILES: readonly string[];
}

/** The config is plain JavaScript outside every TypeScript program, so it is loaded by URL. */
async function loadBudget(): Promise<Budget> {
  return (await import(pathToFileURL(join(REPOSITORY_ROOT, "eslint.config.js")).href)) as Budget;
}

function budgetLinter(rules: Linter.RulesRecord = {}): ESLint {
  return new ESLint({
    cwd: REPOSITORY_ROOT,
    overrideConfig: { languageOptions: { parserOptions: { projectService: false } }, rules },
    ruleFilter: ({ ruleId }) => ruleId === MAX_LINES_RULE_ID,
  });
}

function budgetMessages(results: ESLint.LintResult[]): string[] {
  return results.flatMap((result) => result.messages.map((message) => message.message));
}

function codeLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `export const line${index} = ${index};`).join("\n\n");
}

describe("the source file size budget", () => {
  it("givenAFileOverTheBudget_whenNotAllowlisted_thenLintFails", async () => {
    const { MAX_LINES } = await loadBudget();
    const eslint = budgetLinter();
    const commented = `/**\n${" * a comment line\n".repeat(MAX_LINES)} */\n${codeLines(MAX_LINES)}\n`;

    const over = await eslint.lintText(`${codeLines(MAX_LINES + 1)}\n`, { filePath: BUDGET_FIXTURE });
    const within = await eslint.lintText(commented, { filePath: BUDGET_FIXTURE });

    expect(budgetMessages(over)).toEqual([
      `File has too many lines (${MAX_LINES + 1}). Maximum allowed is ${MAX_LINES}.`,
    ]);
    expect(budgetMessages(within)).toEqual([]);
  });

  it("givenOversizedAllowlist_whenAFileShrinks_thenItMustLeaveTheList", async () => {
    const { MAX_LINES, OVERSIZED_FILES } = await loadBudget();
    const eslint = budgetLinter({
      [MAX_LINES_RULE_ID]: ["error", { max: MAX_LINES, skipBlankLines: true, skipComments: true }],
    });

    for (const file of OVERSIZED_FILES) {
      expect(existsSync(join(REPOSITORY_ROOT, file)), `${file} is gone: drop it from OVERSIZED_FILES`).toBe(true);
      const messages = budgetMessages(await eslint.lintFiles([file]));
      expect(messages, `${file} fits ${MAX_LINES} code lines now: drop it from OVERSIZED_FILES`).toHaveLength(1);
    }
  });
});
