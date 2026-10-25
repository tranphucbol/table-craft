/**
 * Runs the smoke suites in the headless box (decision 063): a Linux container with a virtual
 * display, so a live test never takes the screen, the keyboard or the clipboard of the machine it
 * runs on. Positional arguments narrow the run, as they would for `vitest run`; other arguments
 * starting with `-` are passed to Vitest (`runner.ts`). Files run `TABLE_CRAFT_SMOKE_WORKERS` at a
 * time, chosen by the Docker VM's memory and the boxes already running when unset (`workers.ts`),
 * then `serialFiles.ts` one by one.
 *
 * With `--databases` it starts the servers `TABLE_CRAFT_DATABASES` selects (decision 099), which
 * every smoke run needs to include MySQL and TiDB, and passes the selection into the box.
 *
 *   bun run test:smoke:headless
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/031 bun run test:smoke:db:headless test/e2e/namespace.smoke.test.ts
 *   bun run test:smoke:db:headless:postgres
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPOSE_FILE, describeSelection, stackFor, upDatabases } from "../../db/stack.js";
import { resolveTidbTarget } from "../../db/tidbTarget.js";
import { selectedDatabases } from "../../support/databases.js";
import { smokeSelectionProblem } from "../../support/smokeFixtures.js";
import { parseRunArguments } from "./runner.js";
import { resolveWorkers, WORKERS_ENV } from "./workers.js";

const BUN_VERSION_FILE = join(import.meta.dirname, "..", "..", "..", ".bun-version");
const SERVICE = "e2e";
const PROFILE = "e2e";

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): void {
  const { status, error } = spawnSync(command, args, { stdio: "inherit", env });
  if (error !== undefined) throw error;
  if (status !== 0) process.exit(status ?? 1);
}

/** The Docker VM's memory, which bounds how many apps the box runs at once; `undefined` if unknown. */
function dockerMemoryBytes(): number | undefined {
  const { stdout, status } = spawnSync("docker", ["info", "--format", "{{.MemTotal}}"], { encoding: "utf8" });
  const bytes = Number(stdout.trim());
  return status === 0 && Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
}

/** Headless boxes already running, from any worktree; read just before this one starts. */
function runningBoxes(): number {
  const { stdout, status } = spawnSync(
    "docker",
    ["ps", "--quiet", "--filter", `label=com.docker.compose.service=${SERVICE}`],
    { encoding: "utf8" },
  );
  return status === 0 ? stdout.split("\n").filter((line) => line !== "").length : 0;
}

function quote(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

const { databases, tests, options } = parseRunArguments(process.argv.slice(2));
const selection = databases ? selectedDatabases() : [];
const problem = smokeSelectionProblem(selection);
if (databases && problem !== null) {
  console.error(problem);
  process.exit(1);
}
const target = databases ? await resolveTidbTarget() : null;
const base = { ...process.env, BUN_VERSION: readFileSync(BUN_VERSION_FILE, "utf8").trim() };
const compose = ["compose", "-f", COMPOSE_FILE, ...(target === null ? [] : stackFor(selection, target).profiles)];
if (target !== null) {
  console.log(describeSelection(selection));
  console.log(target.description);
}
const env = target === null ? base : await upDatabases(target, base, selection);

const { workers, reason } = resolveWorkers(process.env[WORKERS_ENV], dockerMemoryBytes(), runningBoxes());
console.log(reason);

const smokeEnv = ["TABLE_CRAFT_SMOKE=1", ...(databases ? ["TABLE_CRAFT_SMOKE_DATABASES=1"] : [])];
const vitest = ["bunx", "vitest", "run", ...tests, ...options];
const inside = `bun run --filter '@table-craft/desktop' build && ${[...smokeEnv, ...vitest.map(quote)].join(" ")}`;

run(
  "docker",
  [
    ...compose,
    "--profile",
    PROFILE,
    "run",
    "--rm",
    "--build",
    "--env",
    `${WORKERS_ENV}=${String(workers)}`,
    ...(databases ? [] : ["--no-deps"]),
    SERVICE,
    "bash",
    "-c",
    inside,
  ],
  env,
);
