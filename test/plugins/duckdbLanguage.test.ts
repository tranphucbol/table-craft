import { readFileSync } from "node:fs";
import duckdb from "@table-craft/plugin-duckdb";
import { duckdbErrorPosition } from "@table-craft/plugin-duckdb/errorPosition";
import { describe, expect, it } from "vitest";
import { readVocabulary, renderVocabulary } from "../../plugins/duckdb/scripts/vocabulary.js";
import { fakeCatalog, fixtureRelations } from "../support/completionCatalog.js";

const GENERATED = new URL("../../plugins/duckdb/src/vocabulary.generated.ts", import.meta.url);
const FORMAT = {
  style: "standard",
  keywordCase: "upper",
  indentWidth: 2,
  linesBetweenStatements: 1,
  alignAliases: false,
} as const;

describe("DuckDB language", () => {
  it("givenParserError_whenErrorPosition_thenCaretOffset", () => {
    const message = 'Parser Error: syntax error at or near "selec"\n\nLINE 1: selec 1\n        ^^^^^';

    expect(duckdbErrorPosition("selec 1", message)).toEqual({ line: 1, column: 1 });
  });

  it("givenCatalogErrorOnSecondLine_whenErrorPosition_thenLineAndColumn", () => {
    const sql = "SELECT 1\nFROM missing_table";
    const message =
      'Catalog Error: Table with name missing_table does not exist!\nDid you mean "main.orders"?\n\nLINE 2: FROM missing_table\n             ^';

    expect(duckdbErrorPosition(sql, message)).toEqual({ line: 2, column: 6 });
  });

  it("givenShortenedErrorLine_whenErrorPosition_thenNull", () => {
    const sql = `SELECT ${"x, ".repeat(60)}y FROM missing_table`;
    const message =
      "Catalog Error: Table with name missing_table does not exist!\n\nLINE 1: ...y FROM missing_table\n                ^";

    expect(duckdbErrorPosition(sql, message)).toBeUndefined();
  });

  it("givenDollarQuotedBody_whenSplit_thenOneStatement", () => {
    const text = "CREATE MACRO m() AS $$ select 1; $$;\nSELECT m()";

    expect(duckdb.language.split(text).map((statement) => statement.sql)).toEqual([
      "CREATE MACRO m() AS $$ select 1; $$",
      "SELECT m()",
    ]);
  });

  it("givenPinnedDriver_whenVocabularyRegenerated_thenMatchesCommittedFiles", async () => {
    const committed = readFileSync(GENERATED, "utf8");

    expect(renderVocabulary(await readVocabulary())).toBe(committed);
  });

  it("givenFromFirstQuery_whenFormat_thenDuckdbDialectLayout", () => {
    const formatted = duckdb.language.format("from orders select status, count(*) group by all", FORMAT);

    expect(formatted).toMatch(/^FROM\n {2}orders\nSELECT\n {2}status,\n {2}count\(\*\)\nGROUP BY\s+ALL$/u);
  });

  it("givenFunctionPrefix_whenComplete_thenDuckdbFunctionsOffered", async () => {
    const text = "SELECT str_spl";
    const { items } = await duckdb.language.complete({ text, offset: text.length }, fakeCatalog(fixtureRelations()));
    const names = items.map((item) => item.label.toLowerCase());

    expect(names).toContain("str_split");
  });
});
