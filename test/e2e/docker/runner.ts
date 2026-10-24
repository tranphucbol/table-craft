/** What the headless runner (`headless.ts`) decides before it starts anything; pure, so it is unit tested. */

export const DATABASES_FLAG = "--databases";
export const DEFAULT_TESTS = "test/e2e";

export interface RunArguments {
  /** Whether the run starts the databases and sets `TABLE_CRAFT_SMOKE_DATABASES`. */
  readonly databases: boolean;
  /** Test filters; `test/e2e` when none is given, so a flag alone never widens the run. */
  readonly tests: readonly string[];
  /** Everything starting with `-`, passed to Vitest as is. */
  readonly options: readonly string[];
}

/**
 * Splits the runner's arguments: `--databases` is the runner's own, other arguments starting with
 * `-` are Vitest options and positional ones are filters. A value an option takes must be joined
 * to it (`--reporter=verbose`), since a separate word reads as a filter.
 */
export function parseRunArguments(argv: readonly string[]): RunArguments {
  const own = argv.filter((argument) => argument !== DATABASES_FLAG);
  const tests = own.filter((argument) => !argument.startsWith("-"));
  return {
    databases: own.length !== argv.length,
    tests: tests.length > 0 ? tests : [DEFAULT_TESTS],
    options: own.filter((argument) => argument.startsWith("-")),
  };
}
