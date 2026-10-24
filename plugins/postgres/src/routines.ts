import {
  PluginError,
  type Routine,
  type RoutineArgument,
  type RoutineCall,
  type RoutineParameter,
} from "@table-craft/plugin-api";
import { routineSlots, type RoutineSlot } from "@table-craft/plugin-api/sql";

/**
 * Pseudo-types a value cannot be cast to; the server resolves them from the other arguments.
 * `format_type` prints `"any"` quoted.
 */
const PSEUDO_TYPE = /^(?:"?any|record$|cstring$|internal$)/;

/**
 * `SELECT * FROM f(…);` for a function, so a set or table result comes back as rows, and
 * `CALL p(…);` for a procedure, whose OUT values come back as the CALL's row (decision 090).
 * Every value is cast to its declared type, which picks the overload. A skipped default omits
 * the argument, and the ones after it switch to named notation, the only way past a gap.
 */
export function postgresRoutineCall(
  name: (identifier: string) => string,
): (routine: Routine, qualifiedName: string, args: readonly RoutineArgument[]) => RoutineCall {
  return (routine, qualifiedName, args) => {
    const { slots, params } = routineSlots(routine, args);
    const passed: string[] = [];
    let named = false;
    for (const slot of slots) {
      if (slot.kind === "default") {
        named = true;
        continue;
      }
      if (slot.kind === "out" && routine.kind === "function") continue;
      passed.push(argument(slot, named, routine, name));
    }
    const call = `${qualifiedName}(${passed.join(", ")})`;
    return { sql: routine.kind === "procedure" ? `CALL ${call};` : `SELECT * FROM ${call};`, params };
  };
}

function argument(slot: RoutineSlot, named: boolean, routine: Routine, name: (identifier: string) => string): string {
  const value = cast(slot.kind === "value" ? slot.marker : "NULL", slot.parameter);
  const variadic = slot.parameter.mode === "variadic" ? "VARIADIC " : "";
  if (!named) return `${variadic}${value}`;
  if (slot.parameter.name === null) {
    throw new PluginError(
      "statementFailed",
      `Parameter ${String(slot.position)} of ${routine.name} has no name, so it cannot follow a skipped default. Give the defaults before it a value.`,
    );
  }
  return `${variadic}${name(slot.parameter.name)} => ${value}`;
}

function cast(value: string, parameter: RoutineParameter): string {
  return PSEUDO_TYPE.test(parameter.type) ? value : `CAST(${value} AS ${parameter.type})`;
}
