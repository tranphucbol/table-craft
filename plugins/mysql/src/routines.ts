import type { Routine, RoutineArgument, RoutineCall } from "@table-craft/plugin-api";
import { routineSlots } from "@table-craft/plugin-api/sql";

/** OUT and INOUT values travel in session variables, which the console's session keeps between statements. */
const OUT_VARIABLE_PREFIX = "@out";
const UNNAMED_PREFIX = "out";

/**
 * `SELECT f(…) AS f;` for a function. For a procedure, `SET` gives each INOUT variable its value,
 * `CALL p(…);` runs it with a variable in every OUT and INOUT place, and a `SELECT` reads the
 * variables back as one row (decision 090).
 */
export function mysqlRoutineCall(
  name: (identifier: string) => string,
): (routine: Routine, qualifiedName: string, args: readonly RoutineArgument[]) => RoutineCall {
  return (routine, qualifiedName, args) => {
    const { slots, params } = routineSlots(routine, args);
    if (routine.kind === "function") {
      const passed = slots.flatMap((slot) => (slot.kind === "value" ? [slot.marker] : []));
      return { sql: `SELECT ${qualifiedName}(${passed.join(", ")}) AS ${name(routine.name)};`, params };
    }
    const sets: string[] = [];
    const passed: string[] = [];
    const reads: string[] = [];
    for (const slot of slots) {
      if (slot.parameter.mode === "in" && slot.kind === "value") {
        passed.push(slot.marker);
        continue;
      }
      const variable = `${OUT_VARIABLE_PREFIX}${String(slot.position)}`;
      if (slot.kind === "value") sets.push(`SET ${variable} = ${slot.marker};`);
      passed.push(variable);
      reads.push(`${variable} AS ${name(slot.parameter.name ?? `${UNNAMED_PREFIX}${String(slot.position)}`)}`);
    }
    const call = `CALL ${qualifiedName}(${passed.join(", ")});`;
    const read = reads.length === 0 ? [] : [`SELECT ${reads.join(", ")};`];
    return { sql: [...sets, call, ...read].join("\n"), params };
  };
}
