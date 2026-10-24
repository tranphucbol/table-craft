/**
 * Starts the `compose.yml` databases, leaving the TiDB container out when a remote TiDB answers
 * (`tidbTarget.ts`). The suites make the same choice again in their global setup
 * (`test/support/tidbScratch.ts`).
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { composeProfiles, resolveTidbTarget } from "./tidbTarget.js";

const COMPOSE_FILE = join(import.meta.dirname, "compose.yml");

const target = await resolveTidbTarget();
console.log(target.description);
const { status, error } = spawnSync(
  "docker",
  ["compose", "-f", COMPOSE_FILE, ...composeProfiles(target), "up", "-d", "--wait"],
  { stdio: "inherit" },
);
if (error !== undefined) throw error;
process.exit(status ?? 1);
