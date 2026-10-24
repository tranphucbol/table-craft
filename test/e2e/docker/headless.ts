/**
 * Runs the smoke suites in the headless box (decision 063): a Linux container with a virtual
 * display, so a live test never takes the screen, the keyboard or the clipboard of the machine it
 * runs on. Arguments after the flags narrow the run, as they would for `vitest run`.
 *
 *   bun run test:smoke:headless
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/031 bun run test:smoke:db:headless test/e2e/namespace.smoke.test.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composeProfiles, resolveTidbTarget } from "../../db/tidbTarget.js";

const DATABASES_FLAG = "--databases";
const CHECKOUT = join(import.meta.dirname, "..", "..", "..");
const COMPOSE_FILE = join(CHECKOUT, "test", "db", "compose.yml");
const BUN_VERSION_FILE = join(CHECKOUT, ".bun-version");
const SERVICE = "e2e";
const PROFILE = "e2e";
const DEFAULT_TESTS = "test/e2e";

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): void {
  const { status, error } = spawnSync(command, args, { stdio: "inherit", env });
  if (error !== undefined) throw error;
  if (status !== 0) process.exit(status ?? 1);
}

function quote(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

const argv = process.argv.slice(2);
const databases = argv.includes(DATABASES_FLAG);
const tests = argv.filter((argument) => argument !== DATABASES_FLAG);
const target = databases ? await resolveTidbTarget() : null;
const env = { ...process.env, ...target?.env, BUN_VERSION: readFileSync(BUN_VERSION_FILE, "utf8").trim() };
const compose = ["compose", "-f", COMPOSE_FILE, ...(target === null ? [] : composeProfiles(target))];

if (target !== null) {
  console.log(target.description);
  run("docker", [...compose, "up", "-d", "--wait"], env);
}

const smokeEnv = ["TABLE_CRAFT_SMOKE=1", ...(databases ? ["TABLE_CRAFT_SMOKE_DATABASES=1"] : [])];
const vitest = ["bunx", "vitest", "run", ...(tests.length > 0 ? tests : [DEFAULT_TESTS]), "--no-file-parallelism"];
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
    ...(databases ? [] : ["--no-deps"]),
    SERVICE,
    "bash",
    "-c",
    inside,
  ],
  env,
);
