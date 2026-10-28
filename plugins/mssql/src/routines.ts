import type { Routine, RoutineArgument, RoutineCall } from "@table-craft/plugin-api";
import { routineSlots } from "@table-craft/plugin-api/sql";

/** What `Routine.returns` says for a table-valued function. */
export const TABLE_RETURNS = /^TABLE\b/i;
const RETURN_VALUE = "RETURN_VALUE";
const OUTPUT_PREFIX = "@table_craft_out";
const RETURN_VARIABLE = "@table_craft_return";

/**
 * A procedure runs as `EXEC`, every argument by name (`@a = …`), an output parameter into a
 * variable read back with its return status by a final `SELECT`; a skipped default is left out.
 * `EXEC` takes no expression, so values are passed as sent and the server converts them. A scalar
 * function is `SELECT f(…)`, a table-valued one `SELECT * FROM f(…)`, where a skipped default is
 * the `DEFAULT` keyword and each value is cast to the parameter's type. A procedure call is one
 * statement to the splitter, with no `;` inside, since its variables live only as long as one batch.
 */
export function mssqlRoutineCall(
  name: (identifier: string) => string,
): (routine: Routine, qualifiedName: string, args: readonly RoutineArgument[]) => RoutineCall {
  return (routine, qualifiedName, args) => {
    const { slots, params } = routineSlots(routine, args);
    if (routine.kind === "function") {
      const passed = slots
        .filter((slot) => slot.kind !== "out")
        .map((slot) => (slot.kind === "value" ? `CAST(${slot.marker} AS ${slot.parameter.type})` : "DEFAULT"));
      const call = `${qualifiedName}(${passed.join(", ")})`;
      const sql = TABLE_RETURNS.test(routine.returns ?? "")
        ? `SELECT * FROM ${call};`
        : `SELECT ${call} AS ${name(routine.name)};`;
      return { sql, params };
    }
    const declarations: string[] = [`DECLARE ${RETURN_VARIABLE} int`];
    const passed: string[] = [];
    const read: string[] = [`${RETURN_VARIABLE} AS ${RETURN_VALUE}`];
    for (const slot of slots) {
      const parameter = `@${slot.parameter.name ?? ""}`;
      if (slot.kind === "default") continue;
      if (slot.kind === "value" && slot.parameter.mode === "in") {
        passed.push(`${parameter} = ${slot.marker}`);
        continue;
      }
      const variable = `${OUTPUT_PREFIX}${String(slot.position)}`;
      declarations.push(`DECLARE ${variable} ${slot.parameter.type}`);
      if (slot.kind === "value") declarations.push(`SET ${variable} = ${slot.marker}`);
      passed.push(`${parameter} = ${variable} OUTPUT`);
      read.push(`${variable} AS ${name(slot.parameter.name ?? String(slot.position))}`);
    }
    const call = `EXEC ${RETURN_VARIABLE} = ${qualifiedName}${passed.length === 0 ? "" : ` ${passed.join(", ")}`}`;
    return { sql: [...declarations, call, `SELECT ${read.join(", ")};`].join("\n"), params };
  };
}
