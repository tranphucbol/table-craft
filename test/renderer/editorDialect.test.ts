import { MSSQL, MySQL, PLSQL, PostgreSQL, SQLite, StandardSQL } from "@codemirror/lang-sql";
import { describe, expect, it } from "vitest";
import { dialectOf } from "@table-craft/desktop/renderer/console/Editor.js";

describe("editor dialect", () => {
  it("givenHighlightPlsqlAndMssql_whenEditorBuilt_thenDialectApplied", () => {
    expect(dialectOf("plsql")).toBe(PLSQL);
    expect(dialectOf("mssql")).toBe(MSSQL);
  });

  it("givenExistingHighlights_whenEditorBuilt_thenDialectsUnchanged", () => {
    expect(dialectOf("postgresql")).toBe(PostgreSQL);
    expect(dialectOf("mysql")).toBe(MySQL);
    expect(dialectOf("sqlite")).toBe(SQLite);
    expect(dialectOf("db2")).toBe(StandardSQL);
    expect(dialectOf(null)).toBe(StandardSQL);
  });
});
