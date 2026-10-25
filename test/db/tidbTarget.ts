/**
 * Which TiDB the database suites run against. The emulated amd64 image is heavy, so a shared
 * TiDB named by `TABLE_CRAFT_TIDB_REMOTE_*` (in a git-ignored `.env`, which Bun loads) replaces it
 * whenever it answers; otherwise compose starts the image as before. The suites only ever work in
 * databases they create (`test/support/tidbScratch.ts`), so a shared server keeps its own data.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const CHECKOUT = join(import.meta.dirname, "..", "..");
const DOT_ENV = join(CHECKOUT, ".env");
const GIT_FILE = join(CHECKOUT, ".git");
const WORKTREE_GITDIR = /^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/]/m;
const DOT_ENV_LINE = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/;
const REMOTE_PREFIX = "TABLE_CRAFT_TIDB_REMOTE_";
const REMOTE_HOST = "TABLE_CRAFT_TIDB_REMOTE_HOST";
const REMOTE_PORT = "TABLE_CRAFT_TIDB_REMOTE_PORT";
const REMOTE_USER = "TABLE_CRAFT_TIDB_REMOTE_USER";
const REMOTE_PASSWORD = "TABLE_CRAFT_TIDB_REMOTE_PASSWORD";
const DEFAULT_REMOTE_PORT = "4000";
/** A VPN that is down drops the SYN instead of refusing it; do not hold the run up for long. */
const PROBE_TIMEOUT_MS = 3_000;
/** The compose profile that starts the local TiDB container. */
export const TIDB_PROFILE = "tidb";

export interface TidbTarget {
  readonly remote: boolean;
  /** Variables for every process that runs the suites, on the host and in the headless box. */
  readonly env: Readonly<Record<string, string>>;
  readonly description: string;
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * A linked worktree has no `.env` of its own (it is git-ignored), so it shares the main
 * checkout's: its `.git` file reads `gitdir: <main>/.git/worktrees/<name>`.
 */
function mainCheckoutDotEnv(): string | null {
  if (!existsSync(GIT_FILE) || !statSync(GIT_FILE).isFile()) return null;
  const gitdir = WORKTREE_GITDIR.exec(readFileSync(GIT_FILE, "utf8"))?.[1];
  return gitdir === undefined ? null : join(gitdir, ".env");
}

/**
 * The remote settings from the checkout's `.env`, or the main checkout's. Bun loads it for `bun <file>`, but Vitest runs
 * under Node, so its global setup would not see them otherwise.
 */
function dotEnv(): Record<string, string> {
  const file = [DOT_ENV, mainCheckoutDotEnv()].find((path) => path !== null && existsSync(path));
  if (file === undefined || file === null) return {};
  const entries = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => DOT_ENV_LINE.exec(line))
    .filter((match) => match !== null)
    .map((match) => [match[1] ?? "", match[2] ?? ""] as const);
  return Object.fromEntries(entries.filter(([key]) => key.startsWith(REMOTE_PREFIX)));
}

export async function resolveTidbTarget(processEnv: NodeJS.ProcessEnv = process.env): Promise<TidbTarget> {
  const env = { ...dotEnv(), ...processEnv };
  const host = env[REMOTE_HOST] ?? "";
  if (host === "") return { remote: false, env: {}, description: "TiDB: local container (no remote configured)" };
  const port = env[REMOTE_PORT] || DEFAULT_REMOTE_PORT;
  if (!(await reachable(host, Number(port)))) {
    return { remote: false, env: {}, description: `TiDB: local container (${host}:${port} did not answer)` };
  }
  const credentials = { user: env[REMOTE_USER] ?? "", password: env[REMOTE_PASSWORD] ?? "" };
  return {
    remote: true,
    env: {
      TABLE_CRAFT_TIDB_HOST: host,
      TABLE_CRAFT_TIDB_PORT: port,
      TABLE_CRAFT_TIDB_E2E_HOST: host,
      TABLE_CRAFT_TIDB_E2E_PORT: port,
      TABLE_CRAFT_TIDB_USER: credentials.user,
      TABLE_CRAFT_TIDB_PASSWORD: credentials.password,
    },
    description: `TiDB: remote ${host}:${port} as ${credentials.user}, in scratch databases only`,
  };
}
