import type { Routine, RoutineArgument, RoutineCall, RoutineParameter } from "@table-craft/plugin-api";
import { routineSlots } from "@table-craft/plugin-api/sql";

/** PL/SQL wants a length on a variable of these types; the longest a PL/SQL variable takes. */
const SIZED_TYPES = new Set(["VARCHAR2", "NVARCHAR2", "VARCHAR", "CHAR", "NCHAR", "RAW", "UROWID"]);
const PLSQL_MAX_LENGTH = 32767;
const REF_CURSOR = "SYS_REFCURSOR";
const BOOLEAN = "BOOLEAN";
const RESULT = "call_result";
const OUTPUTS = "call_outputs";

function declaredType(type: string): string {
  const upper = type.trim().toUpperCase();
  return SIZED_TYPES.has(upper) ? `${upper}(${String(PLSQL_MAX_LENGTH)})` : type;
}

function isCursor(type: string | null): boolean {
  return type !== null && type.trim().toUpperCase() === REF_CURSOR;
}

function isBoolean(type: string | null): boolean {
  return type !== null && type.trim().toUpperCase() === BOOLEAN;
}

/** Text arrives for every value; a PL/SQL BOOLEAN has no conversion from it, so it is spelled out. */
function initial(marker: string, parameter: RoutineParameter): string {
  return isBoolean(parameter.type)
    ? `CASE UPPER(${marker}) WHEN 'TRUE' THEN TRUE WHEN '1' THEN TRUE WHEN 'FALSE' THEN FALSE WHEN '0' THEN FALSE END`
    : marker;
}

/** A BOOLEAN reads in SQL only from 23ai on, so it is selected as its text. */
function selected(variable: string, type: string | null): string {
  return isBoolean(type) ? `CASE WHEN ${variable} THEN 'TRUE' WHEN NOT ${variable} THEN 'FALSE' END` : variable;
}

function alias(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function lastPart(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1);
}

/**
 * One anonymous block, so the console runs the call as one statement. Every argument goes
 * through a local of the parameter's declared type, which picks the overload, and by named
 * notation, which lets a skipped default leave its gap. The return value and the OUT and IN OUT
 * values come back as one row through `DBMS_SQL.RETURN_RESULT`, and each ref cursor as its own
 * result after it.
 */
export function oracleRoutineCall(
  name: (identifier: string) => string,
): (routine: Routine, qualifiedName: string, args: readonly RoutineArgument[]) => RoutineCall {
  return (routine, qualifiedName, args) => {
    const { slots, params } = routineSlots(routine, args);
    const declarations: string[] = [];
    const passed: string[] = [];
    const scalars: string[] = [];
    const cursors: string[] = [];
    for (const slot of slots) {
      if (slot.kind === "default") continue;
      const local = `arg${String(slot.position)}`;
      const type = slot.parameter.type;
      const value = slot.kind === "value" ? ` := ${initial(slot.marker, slot.parameter)}` : "";
      declarations.push(`  ${local} ${declaredType(type)}${value};`);
      passed.push(slot.parameter.name === null ? local : `${name(slot.parameter.name)} => ${local}`);
      if (slot.parameter.mode === "in") continue;
      if (isCursor(type)) cursors.push(local);
      else scalars.push(`${selected(local, type)} AS ${alias(slot.parameter.name ?? local)}`);
    }
    const call = `${qualifiedName}(${passed.join(", ")})`;
    const body: string[] = [];
    if (routine.kind === "function") {
      const returns = routine.returns ?? "VARCHAR2";
      declarations.unshift(`  ${RESULT} ${declaredType(returns)};`);
      body.push(`  ${RESULT} := ${passed.length === 0 ? qualifiedName : call};`);
      if (isCursor(returns)) cursors.unshift(RESULT);
      else scalars.unshift(`${selected(RESULT, returns)} AS ${alias(lastPart(routine.name))}`);
    } else {
      body.push(`  ${passed.length === 0 ? qualifiedName : call};`);
    }
    if (scalars.length > 0) {
      declarations.push(`  ${OUTPUTS} SYS_REFCURSOR;`);
      body.push(
        `  OPEN ${OUTPUTS} FOR SELECT ${scalars.join(", ")} FROM DUAL;`,
        `  DBMS_SQL.RETURN_RESULT(${OUTPUTS});`,
      );
    }
    body.push(...cursors.map((cursor) => `  DBMS_SQL.RETURN_RESULT(${cursor});`));
    const declare = declarations.length === 0 ? "" : `DECLARE\n${declarations.join("\n")}\n`;
    return { sql: `${declare}BEGIN\n${body.join("\n")}\nEND;`, params };
  };
}
