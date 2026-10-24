/**
 * Runs the smoke suites in the headless box (decision 063): a Linux container with a virtual
 * display, so a live test never takes the screen, the keyboard or the clipboard of the machine it
 * runs on. Positional arguments narrow the run, as they would for `vitest run`; other arguments
 * starting with `-` are passed to Vitest (`runner.ts`). Files run `TABLE_CRAFT_SMOKE_WORKERS` at a
 * time, chosen by the Docker VM's memory when unset (`workers.ts`), then `serialFiles.ts` one by one.
 *
 *   bun run test:smoke:headless
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/031 bun run test:smoke:db:headless test/e2e/namespace.smoke.test.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPOSE_FILE, upDatabases } from "../../db/stack.js";
import { composeProfiles, resolveTidbTarget } from "../../db/tidbTarget.js";
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

function quote(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

const { databases, tests, options } = parseRunArguments(process.argv.slice(2));
const target = databases ? await resolveTidbTarget() : null;
const base = { ...process.env, BUN_VERSION: readFileSync(BUN_VERSION_FILE, "utf8").trim() };
const compose = ["compose", "-f", COMPOSE_FILE, ...(target === null ? [] : composeProfiles(target))];
if (target !== null) console.log(target.description);
const env = target === null ? base : await upDatabases(target, base);

const { workers, reason } = resolveWorkers(process.env[WORKERS_ENV], dockerMemoryBytes());
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
