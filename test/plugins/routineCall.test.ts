import mssql from "@table-craft/plugin-mssql";
import mysql from "@table-craft/plugin-mysql";
import postgres from "@table-craft/plugin-postgres";
import {
  isPluginError,
  type DatasourcePlugin,
  type Routine,
  type RoutineArgument,
  type RoutineCall,
  type RoutineParameter,
} from "@table-craft/plugin-api";
import { describe, expect, it } from "vitest";

function parameter(name: string | null, type: string, mode: RoutineParameter["mode"] = "in", hasDefault = false) {
  return { name, type, mode, hasDefault };
}

function routine(kind: Routine["kind"], parameters: readonly RoutineParameter[], name = "f"): Routine {
  return { name, kind, signature: "", parameters, returns: kind === "function" ? "numeric" : null };
}

function value(text: string | null): RoutineArgument {
  return { kind: "value", value: text };
}

const DEFAULT: RoutineArgument = { kind: "default" };

function call(plugin: DatasourcePlugin, target: Routine, args: readonly RoutineArgument[]): RoutineCall {
  const routineCall = plugin.language?.routineCall?.bind(plugin.language);
  if (routineCall === undefined) throw new Error(`${plugin.id} declares routineCall`);
  return routineCall(target, `s.${target.name}`, args);
}

function failure(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (isPluginError(error) && error.code === "statementFailed") return error.message;
    throw error;
  }
  throw new Error("expected statementFailed");
}

describe("postgres routineCall", () => {
  it("givenFunction_whenCall_thenSelectFromWithCasts", () => {
    const target = routine("function", [parameter("amount", "numeric"), parameter("rate", "numeric")]);
    expect(call(postgres, target, [value("100"), value(null)])).toEqual({
      sql: "SELECT * FROM s.f(CAST(:amount AS numeric), CAST(:rate AS numeric));",
      params: { ":amount": "100", ":rate": null },
    });
  });

  it("givenPgDefaultSkipped_whenLaterValue_thenNamedNotation", () => {
    const target = routine("procedure", [
      parameter("a", "integer"),
      parameter("b", "integer", "in", true),
      parameter("Total", "numeric", "out"),
    ]);
    expect(call(postgres, target, [value("1"), DEFAULT, value(null)]).sql).toBe(
      'CALL s.f(CAST(:a AS integer), "Total" => CAST(NULL AS numeric));',
    );
  });

  it("givenTrailingDefault_whenOmitted_thenPositional", () => {
    const target = routine("function", [parameter("a", "integer"), parameter("b", "integer", "in", true)]);
    expect(call(postgres, target, [value("1"), DEFAULT]).sql).toBe("SELECT * FROM s.f(CAST(:a AS integer));");
  });

  it("givenFunctionOut_whenCall_thenOutNotPassed", () => {
    const target = routine("function", [parameter("a", "integer"), parameter("b", "integer", "out")]);
    expect(call(postgres, target, [value("1"), value(null)]).sql).toBe("SELECT * FROM s.f(CAST(:a AS integer));");
  });

  it("givenUnnamedAfterSkippedDefault_whenCall_thenStatementFailed", () => {
    const target = routine("function", [parameter("a", "integer", "in", true), parameter(null, "integer", "in", true)]);
    expect(failure(() => call(postgres, target, [DEFAULT, value("2")]))).toMatch(/no name/);
  });

  it("givenVariadic_whenCall_thenVariadicArray", () => {
    const target = routine("function", [parameter("nums", "integer[]", "variadic")]);
    expect(call(postgres, target, [value("{1,2}")]).sql).toBe("SELECT * FROM s.f(VARIADIC CAST(:nums AS integer[]));");
  });

  it("givenOddParameterName_whenCall_thenPositionalMarker", () => {
    const target = routine("function", [
      parameter("my amount", "numeric"),
      parameter(null, "text"),
      parameter("arg2", "text"),
    ]);
    expect(call(postgres, target, [value("1"), value("x"), value("y")])).toEqual({
      sql: "SELECT * FROM s.f(CAST(:arg1 AS numeric), CAST(:arg2 AS text), CAST(:arg2_2 AS text));",
      params: { ":arg1": "1", ":arg2": "x", ":arg2_2": "y" },
    });
  });

  it("givenPseudoType_whenCall_thenNoCast", () => {
    const target = routine("function", [parameter("v", "anyelement"), parameter("w", '"any"')]);
    expect(call(postgres, target, [value("1"), value("2")]).sql).toBe("SELECT * FROM s.f(:v, :w);");
  });

  it("givenWrongArgumentCount_whenCall_thenStatementFailed", () => {
    const target = routine("function", [parameter("a", "integer")]);
    expect(failure(() => call(postgres, target, []))).toMatch(/takes 1 arguments/);
  });

  it("givenDefaultWithoutOne_whenCall_thenStatementFailed", () => {
    const target = routine("function", [parameter("a", "integer")]);
    expect(failure(() => call(postgres, target, [DEFAULT]))).toMatch(/has no default/);
  });
});

describe("mssql routineCall", () => {
  it("givenScalarFunction_whenCall_thenSelectWithCastsAndDefault", () => {
    const target = routine(
      "function",
      [parameter("amount", "decimal(12,2)"), parameter("rate", "decimal(6,4)", "in", true)],
      "calc_fee",
    );
    expect(call(mssql, target, [value("100"), DEFAULT])).toEqual({
      sql: "SELECT s.calc_fee(CAST(:amount AS decimal(12,2)), DEFAULT) AS calc_fee;",
      params: { ":amount": "100" },
    });
  });

  it("givenTableFunction_whenCall_thenSelectFrom", () => {
    const target = { ...routine("function", [parameter("customer", "int")]), returns: "TABLE(id int)" };
    expect(call(mssql, target, [value("1")]).sql).toBe("SELECT * FROM s.f(CAST(:customer AS int));");
  });

  it("givenProcedureWithOutput_whenCall_thenDeclareExecSelectInOneBatch", () => {
    const target = routine("procedure", [
      parameter("id", "int"),
      parameter("total", "decimal(12,2)", "out"),
      parameter("note", "nvarchar(64)", "inout"),
      parameter("flag", "bit", "in", true),
    ]);
    const called = call(mssql, target, [value("3"), value(null), value("x"), DEFAULT]);
    expect(called.sql.split("\n")).toEqual([
      "DECLARE @table_craft_return int",
      "DECLARE @table_craft_out2 decimal(12,2)",
      "DECLARE @table_craft_out3 nvarchar(64)",
      "SET @table_craft_out3 = :note",
      "EXEC @table_craft_return = s.f @id = :id, @total = @table_craft_out2 OUTPUT, @note = @table_craft_out3 OUTPUT",
      "SELECT @table_craft_return AS RETURN_VALUE, @table_craft_out2 AS total, @table_craft_out3 AS note;",
    ]);
    expect(called.params).toEqual({ ":id": "3", ":note": "x" });
    expect(mssql.language?.split(called.sql)).toHaveLength(1);
  });
});

describe("mysql routineCall", () => {
  it("givenFunction_whenCall_thenSelectAliasedByName", () => {
    const target = routine("function", [parameter("amount", "decimal(12,2)")], "calc_fee");
    expect(call(mysql, target, [value("5")])).toEqual({
      sql: "SELECT s.calc_fee(:amount) AS calc_fee;",
      params: { ":amount": "5" },
    });
  });

  it("givenMysqlInout_whenCall_thenSetCallSelect", () => {
    const target = routine("procedure", [
      parameter("id", "int"),
      parameter("total", "decimal(12,2)", "out"),
      parameter("note", "varchar(64)", "inout"),
    ]);
    expect(call(mysql, target, [value("3"), value(null), value("x")])).toEqual({
      sql: "SET @out3 = :note;\nCALL s.f(:id, @out2, @out3);\nSELECT @out2 AS total, @out3 AS note;",
      params: { ":id": "3", ":note": "x" },
    });
  });

  it("givenProcedureWithoutOut_whenCall_thenCallOnly", () => {
    const target = routine("procedure", [parameter("id", "int")]);
    expect(call(mysql, target, [value("3")]).sql).toBe("CALL s.f(:id);");
  });
});
