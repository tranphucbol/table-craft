import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PluginError, type Column, type PlanNode, type Routine } from "@table-craft/plugin-api";
import { boundRow, insertStatement, oracleDecimal } from "@table-craft/plugin-oracle/bulk";
import {
  connectAttributes,
  connectDescriptor,
  connectFailure,
  connectionSchema,
} from "@table-craft/plugin-oracle/connect";
import { serverErrorPosition } from "@table-craft/plugin-oracle/errorPosition";
import { explainStatement, planTree, type PlanRow } from "@table-craft/plugin-oracle/explain";
import { columnType } from "@table-craft/plugin-oracle/introspect";
import { createdUnit } from "@table-craft/plugin-oracle/output";
import { oracleRoutineCall } from "@table-craft/plugin-oracle/routines";
import { cancelStatement, readOracleSession, terminateStatement } from "@table-craft/plugin-oracle/sessions";
import { classify, isPlsql, oracleTransactionEffect, serverText } from "@table-craft/plugin-oracle/statements";
import { describe, expect, it } from "vitest";

const CONFIG = connectionSchema.parse({ host: "db.internal", service: "FREEPDB1", user: "scott" });

function captured(name: string): PlanRow[] {
  return JSON.parse(readFileSync(new URL(`../support/plans/${name}`, import.meta.url), "utf8")) as PlanRow[];
}

describe("oracle statements", () => {
  it("givenSqlWithTrailingSemicolon_whenSent_thenStripped", () => {
    expect(serverText("SELECT 1 FROM DUAL;  \n")).toBe("SELECT 1 FROM DUAL");
  });

  it("givenPlsqlBlockWithTrailingSemicolon_whenSent_thenKept", () => {
    expect(serverText("BEGIN NULL; END;\n")).toBe("BEGIN NULL; END;");
    expect(serverText("CREATE OR REPLACE PACKAGE BODY p AS END;")).toBe("CREATE OR REPLACE PACKAGE BODY p AS END;");
    expect(isPlsql("CREATE OR REPLACE EDITIONABLE TRIGGER t BEFORE INSERT ON x BEGIN NULL; END;")).toBe(true);
    expect(isPlsql("CREATE TABLE t (n NUMBER)")).toBe(false);
  });

  it("givenBlocksAndTransactionStatements_whenClassified_thenOracleKinds", () => {
    expect(classify("BEGIN NULL; END;").kind).toBe("other");
    expect(classify("DECLARE n NUMBER; BEGIN NULL; END;").kind).toBe("other");
    expect(classify("SET TRANSACTION READ ONLY").kind).toBe("transaction");
    expect(classify("ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY'").kind).toBe("other");
    expect(classify("ALTER TABLE t ADD (n NUMBER)").kind).toBe("ddl");
    expect(classify("ALTER SESSION SET CURRENT_SCHEMA = archive").setsNamespace).toBe(true);
  });

  it("givenTransactionStatements_whenRead_thenEffect", () => {
    expect(oracleTransactionEffect("SET TRANSACTION READ WRITE")).toBe("begin");
    expect(oracleTransactionEffect("COMMIT")).toBe("end");
    expect(oracleTransactionEffect("ROLLBACK")).toBe("end");
    expect(oracleTransactionEffect("ROLLBACK TO SAVEPOINT a")).toBeNull();
    expect(oracleTransactionEffect("BEGIN NULL; END;")).toBeNull();
  });
});

describe("oracle connect", () => {
  it("givenServiceName_whenDescribed_thenServiceDescriptor", () => {
    expect(connectDescriptor(CONFIG)).toBe(
      "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db.internal)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=FREEPDB1)))",
    );
  });

  it("givenSidAndTls_whenDescribed_thenSidOverTcps", () => {
    const config = { ...CONFIG, connectBy: "sid" as const, service: "ORCL", sslMode: "verify-full" as const };
    expect(connectDescriptor(config)).toBe(
      "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=db.internal)(PORT=1521))(CONNECT_DATA=(SID=ORCL)))",
    );
  });

  it("givenVerifyFullWithCaFile_whenAttributes_thenTcpsWithWalletAndHostCheck", async () => {
    const caFile = join(import.meta.dirname, "../db/tls/ca.crt");
    const config = { ...CONFIG, sslMode: "verify-full" as const, sslRootCert: caFile };

    const attributes = await connectAttributes(config, {});

    expect(attributes.connectString).toContain("(PROTOCOL=TCPS)");
    expect(attributes).toMatchObject({ sslServerDNMatch: true, walletContent: readFileSync(caFile, "utf8") });
  });

  it("givenVerifyCa_whenAttributes_thenChainCheckedWithoutHostCheck", async () => {
    const attributes = await connectAttributes({ ...CONFIG, sslMode: "verify-ca" as const }, {});

    expect(attributes).toMatchObject({ sslServerDNMatch: false });
    expect(attributes).not.toHaveProperty("walletContent");
  });

  it("givenTlsDisabled_whenAttributes_thenPlainTcp", async () => {
    const attributes = await connectAttributes(CONFIG, { keepAliveInitialDelayMs: 30_000 });

    expect(attributes.connectString).toContain("(PROTOCOL=TCP)");
    expect(attributes).not.toHaveProperty("sslServerDNMatch");
    expect(attributes).toMatchObject({ expireTime: 1 });
  });

  it("givenDescriptorCharacters_whenDescribed_thenRefused", () => {
    expect(() => connectDescriptor({ ...CONFIG, service: "x)(HOST=evil" })).toThrow(PluginError);
  });

  it("givenServer11g_whenConnect_thenVersionMessage", () => {
    const cause = new Error(
      "NJS-138: connections to this database server version are not supported by node-oracledb in Thin mode",
    );
    const failure = connectFailure(CONFIG, cause);
    expect(failure.code).toBe("connectionFailed");
    expect(failure.message).toBe("TableCraft connects to Oracle 12.1 or later; this server is 11.x or older.");
  });

  it("givenServerError_whenConnectFails_thenHelpLinkDropped", () => {
    const cause = new Error(
      "ORA-01017: invalid credential or not authorized; logon denied\nHelp: https://docs.oracle.com/error-help/db/ora-01017/",
    );
    expect(connectFailure(CONFIG, cause).message).toBe("ORA-01017: invalid credential or not authorized; logon denied");
  });
});

describe("oracle error position", () => {
  it("givenOraOffset_whenFailed_thenEditorPosition", () => {
    expect(serverErrorPosition("SELECT nope FROM t", { offset: 7 })).toEqual({ offset: 7 });
  });

  it("givenZeroOffset_whenFailed_thenNoPosition", () => {
    expect(serverErrorPosition("SELECT 1 FROM t", { offset: 0 })).toBeUndefined();
  });

  it("givenMultiByteCharactersBefore_whenFailed_thenUtf16Offset", () => {
    // Offsets as Oracle 23ai reported them for these statements: bytes of UTF-8.
    const astral = "SELECT '🌍', nope FROM DUAL";
    expect(serverErrorPosition(astral, { offset: 15 })).toEqual({ offset: astral.indexOf("nope") });
    const accented = "SELECT 'é', nope FROM DUAL";
    expect(serverErrorPosition(accented, { offset: 13 })).toEqual({ offset: accented.indexOf("nope") });
  });
});

describe("oracle plan reader", () => {
  it("givenExplainPlan_whenRead_thenTreeWithIndexAndPredicates", () => {
    const roots = planTree(captured("oracle-explain.json"), false);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.operation).toBe("SELECT STATEMENT");
    const flat = (nodes: readonly PlanNode[]): PlanNode[] => nodes.flatMap((node) => [node, ...flat(node.children)]);
    const nodes = flat(roots);
    expect(nodes.some((node) => node.target?.startsWith("ORDERS") === true)).toBe(true);
    expect(nodes.some((node) => node.properties.some((property) => property.name === "Access"))).toBe(true);
    expect(nodes.every((node) => node.actualRows === null && node.loops === null)).toBe(true);
  });

  it("givenAnalysedPlan_whenRead_thenActualRowsAndTimes", () => {
    const [root] = planTree(captured("oracle-analyze.json"), true);
    expect(root?.actualRows).toBe(3);
    expect(root?.loops).toBe(1);
    expect(root?.actualTimeMs).toBeGreaterThan(0);
    expect(root?.properties.some((property) => property.name === "Buffers")).toBe(true);
  });

  it("givenStatement_whenExplained_thenStatementIdSet", () => {
    expect(explainStatement("SELECT 1 FROM DUAL", "tc_1")).toBe(
      "EXPLAIN PLAN SET STATEMENT_ID = 'tc_1' FOR SELECT 1 FROM DUAL",
    );
  });
});

describe("oracle catalog", () => {
  it("givenColumnRows_whenTyped_thenOracleSpelling", () => {
    const base = { length: 0, chars: 0, charUsed: null, precision: null, scale: null };
    expect(columnType({ ...base, type: "NUMBER", precision: 12, scale: 2 })).toBe("NUMBER(12,2)");
    expect(columnType({ ...base, type: "NUMBER", precision: 10, scale: 0 })).toBe("NUMBER(10)");
    expect(columnType({ ...base, type: "VARCHAR2", length: 800, chars: 200, charUsed: "C" })).toBe(
      "VARCHAR2(200 CHAR)",
    );
  });

  it("givenCreateStatement_whenRead_thenCompiledUnit", () => {
    expect(createdUnit("CREATE OR REPLACE PACKAGE BODY billing AS END;")).toEqual({
      owner: null,
      name: "BILLING",
      type: "PACKAGE BODY",
    });
    expect(createdUnit("SELECT 1 FROM DUAL")).toBeNull();
  });
});

describe("oracle sessions", () => {
  it("givenSessionId_whenStopped_thenAlterSystemStatements", () => {
    expect(cancelStatement("42,7", null)).toBe("ALTER SYSTEM CANCEL SQL '42,7'");
    expect(terminateStatement("42,7", "2")).toBe("ALTER SYSTEM KILL SESSION '42,7,@2' IMMEDIATE");
  });

  it("givenBlockedRow_whenRead_thenBlockedState", () => {
    const session = readOracleSession({
      ID: "42,7",
      INST_ID: "1",
      INSTANCES: 1,
      STATUS: "ACTIVE",
      TYPE: "USER",
      USERNAME: "TABLE_CRAFT",
      SCHEMANAME: "TABLE_CRAFT",
      MACHINE: "laptop",
      PORT: 50000,
      APPLICATION: "TableCraft",
      QUERY_MS: "1500",
      TRANSACTION_MS: null,
      WAIT: "Application: enq: TX - row lock contention",
      BLOCKED_BY: "43,9",
      QUERY: "UPDATE orders SET total = 1",
    });
    expect(session).toMatchObject({ id: "42,7", instance: null, state: "blocked", blockedBy: ["43,9"] });
  });
});

describe("oracle routine call", () => {
  const settle: Routine = {
    name: "SETTLE_ORDER",
    kind: "procedure",
    signature: "ORDER_ID NUMBER, TOTAL OUT NUMBER, NOTE IN OUT VARCHAR2",
    parameters: [
      { name: "ORDER_ID", type: "NUMBER", mode: "in", hasDefault: false },
      { name: "TOTAL", type: "NUMBER", mode: "out", hasDefault: false },
      { name: "NOTE", type: "VARCHAR2", mode: "inout", hasDefault: false },
    ],
    returns: null,
  };

  it("givenOutParameters_whenCalled_thenOneBlockReturningThem", () => {
    const call = oracleRoutineCall((name) => name)(settle, "SETTLE_ORDER", [
      { kind: "value", value: "3" },
      { kind: "value", value: null },
      { kind: "value", value: "note" },
    ]);
    expect(call.sql).toMatch(/^DECLARE\b/);
    expect(call.sql).toContain("VARCHAR2(32767)");
    expect(call.sql).toContain("SETTLE_ORDER(ORDER_ID => ");
    expect(call.sql).toContain("DBMS_SQL.RETURN_RESULT");
    expect(call.sql).toMatch(/AS "TOTAL"/);
    expect(call.sql).toMatch(/END;$/);
  });

  it("givenRefCursorFunction_whenCalled_thenCursorReturned", () => {
    const routine: Routine = {
      name: "CUSTOMER_ORDERS",
      kind: "function",
      signature: "CUSTOMER NUMBER",
      parameters: [{ name: "CUSTOMER", type: "NUMBER", mode: "in", hasDefault: false }],
      returns: "SYS_REFCURSOR",
    };
    const call = oracleRoutineCall((name) => name)(routine, "CUSTOMER_ORDERS", [{ kind: "value", value: "1" }]);
    expect(call.sql).toContain("SYS_REFCURSOR");
    expect(call.sql).toContain("DBMS_SQL.RETURN_RESULT(call_result)");
  });
});

describe("oracle bulk insert", () => {
  const columns: Column[] = [
    { name: "PAYLOAD", type: "BLOB" },
    { name: "FLAG", type: "NUMBER(1)" },
    { name: "LABEL", type: "VARCHAR2(40 CHAR)" },
  ];

  it("givenExportedText_whenBound_thenBytesAndFlags", () => {
    expect(boundRow(["0xdeadbeef", "true", "x"], columns)).toEqual([Buffer.from("deadbeef", "hex"), "1", "x"]);
    expect(boundRow([null, "false", null], columns)).toEqual([null, "0", null]);
  });

  it("givenColumns_whenInsertWritten_thenNumberedBinds", () => {
    expect(insertStatement("T", ["A", "B"])).toBe("INSERT INTO T (A, B) VALUES (:1, :2)");
  });

  it("givenWideDecimal_whenTyped_thenCappedAtOracleMaximum", () => {
    expect(oracleDecimal({ kind: "decimal", integerDigits: 48, scale: 2 })).toBe("NUMBER(38, 2)");
    expect(oracleDecimal({ kind: "decimal", integerDigits: 7, scale: 3 })).toBe("NUMBER(10, 3)");
  });
});
