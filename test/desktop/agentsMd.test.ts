import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const AGENTS_MD = join(REPOSITORY_ROOT, "AGENTS.md");
const ENGINE_DIRECTORY = join(REPOSITORY_ROOT, "packages/desktop/src/engine");
const ENGINE_ENTRY = "  src/engine/";
/** Layout continuation lines are indented to the description column; an entry starts before it. */
const DESCRIPTION_COLUMN = "                           ";
const MODULE_PATTERN = /`([^`]+\.ts)`/g;
const PLACEHOLDER = /<[a-z]+>/;

function engineLayoutEntry(): string {
  const lines = readFileSync(AGENTS_MD, "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith(ENGINE_ENTRY));
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => !line.startsWith(DESCRIPTION_COLUMN));
  return [lines[start], ...rest.slice(0, end)].join("\n");
}

function namedModules(entry: string): string[] {
  return [...entry.matchAll(MODULE_PATTERN)].map((match) => match[1] ?? "");
}

describe("AGENTS.md", () => {
  it("givenAgentsMd_whenLayoutNamesEngineModules_thenEachPathExists", () => {
    const modules = namedModules(engineLayoutEntry());

    expect(modules).toEqual(
      expect.arrayContaining(["protocol.ts", "engine.ts", "context.ts", "connection.ts", "failures.ts"]),
    );
    for (const module of modules) {
      const path = join(ENGINE_DIRECTORY, module);
      if (PLACEHOLDER.test(module)) {
        const directory = dirname(path);
        expect(existsSync(directory), `${module}: no ${directory}`).toBe(true);
        expect(
          readdirSync(directory).some((name) => name.endsWith(".ts")),
          `${module}: no modules`,
        ).toBe(true);
      } else {
        expect(existsSync(path), `${module}: no ${path}`).toBe(true);
      }
    }
  });
});
