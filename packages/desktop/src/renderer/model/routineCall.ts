import type { Routine, RoutineArgument, RoutineCall } from "@table-craft/desktop/engine/protocol.js";

export const ROUTINE_CHOICES = { run: "run", console: "console" } as const;

/** What Execute Routine answers: Run or Open in Console, and the call previewed when it was chosen. */
export interface RoutineAnswer {
  readonly choice: (typeof ROUTINE_CHOICES)[keyof typeof ROUTINE_CHOICES];
  readonly call: RoutineCall;
}

export function routineAnswer(answer: RoutineAnswer): string {
  return JSON.stringify(answer);
}

export function parseRoutineAnswer(answer: string): RoutineAnswer {
  return JSON.parse(answer) as RoutineAnswer;
}

/** One argument per parameter: DEFAULT where the routine has one, an empty value otherwise. */
export function initialArguments(routine: Routine): readonly RoutineArgument[] {
  return routine.parameters.map((parameter) =>
    parameter.hasDefault ? { kind: "default" } : { kind: "value", value: "" },
  );
}

/** Where the routine is and what comes back, as the dialog says it under its title. */
export function routineNote(routine: Routine, path: readonly string[]): string {
  const where = `${[...path, routine.name].join(".")}(${routine.signature})`;
  if (routine.returns !== null) return `${where} returns ${routine.returns}.`;
  const outs = routine.parameters.flatMap((parameter, index) =>
    parameter.mode === "out" || parameter.mode === "inout"
      ? [`${parameter.name ?? `$${String(index + 1)}`} ${parameter.type}`]
      : [],
  );
  return outs.length === 0 ? `${where}.` : `${where} returns ${outs.join(", ")}.`;
}
