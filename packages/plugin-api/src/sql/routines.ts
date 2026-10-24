import {
  PluginError,
  type ParameterValue,
  type Routine,
  type RoutineArgument,
  type RoutineParameter,
} from "@table-craft/plugin-api";

/** What a dialect's routine call writes for one parameter (decision 090). */
export type RoutineSlot =
  | { readonly kind: "value"; readonly parameter: RoutineParameter; readonly position: number; readonly marker: string }
  | { readonly kind: "default"; readonly parameter: RoutineParameter; readonly position: number }
  | { readonly kind: "out"; readonly parameter: RoutineParameter; readonly position: number };

export interface RoutineSlots {
  readonly slots: readonly RoutineSlot[];
  /** Keyed by marker with its colon, as `RoutineCall.params` is. */
  readonly params: Readonly<Record<string, ParameterValue>>;
}

/** A name every dialect's placeholder scanner reads whole after the colon. */
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const POSITIONAL_PREFIX = "arg";

/**
 * Pairs each parameter with its argument and gives every value a named `:marker` (`:` + the
 * parameter's name when it is a plain identifier, else `:arg<position>`), unique in the call.
 * Throws a `PluginError` coded `statementFailed` when the arguments do not fit the parameters.
 */
export function routineSlots(routine: Routine, args: readonly RoutineArgument[]): RoutineSlots {
  if (args.length !== routine.parameters.length) {
    throw new PluginError(
      "statementFailed",
      `${routine.name} takes ${String(routine.parameters.length)} arguments, one per parameter; ${String(args.length)} were given. Describe the routine again and fill every parameter.`,
    );
  }
  const used = new Set<string>();
  const params: Record<string, ParameterValue> = {};
  const slots = routine.parameters.map((parameter, index): RoutineSlot => {
    const position = index + 1;
    if (parameter.mode === "out") return { kind: "out", parameter, position };
    const argument = args[index] ?? { kind: "default" };
    if (argument.kind === "default") {
      if (!parameter.hasDefault) {
        throw new PluginError(
          "statementFailed",
          `Parameter ${parameter.name ?? String(position)} of ${routine.name} has no default. Give it a value or NULL.`,
        );
      }
      return { kind: "default", parameter, position };
    }
    const marker = uniqueMarker(parameter, position, used);
    used.add(marker);
    params[marker] = argument.value;
    return { kind: "value", parameter, position, marker };
  });
  return { slots, params };
}

function uniqueMarker(parameter: RoutineParameter, position: number, used: ReadonlySet<string>): string {
  const base =
    parameter.name !== null && PLAIN_NAME.test(parameter.name)
      ? `:${parameter.name}`
      : `:${POSITIONAL_PREFIX}${String(position)}`;
  let marker = base;
  for (let suffix = 2; used.has(marker); suffix++) marker = `${base}_${String(suffix)}`;
  return marker;
}
