/**
 * Reports what OpenCode sessions spent their model calls on (plan 049):
 * `bun scripts/agent-cost/report.ts [--db <path>] <session id or title fragment…>`.
 * It opens the OpenCode session store read-only.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { formatReport, summarise, type ChildSession, type MessageRow, type SessionRecord } from "./summary.js";

export const DEFAULT_DATABASE = join(homedir(), ".local", "share", "opencode", "opencode.db");
const DATABASE_FLAG = "--db";
const SESSION_ID_PREFIX = "ses_";
const USAGE = `usage: bun scripts/agent-cost/report.ts [${DATABASE_FLAG} <opencode.db>] <session id or title fragment…>`;

export class ReportError extends Error {
  override name = "ReportError";
}

interface SessionRow {
  id: string;
  title: string | null;
  directory: string;
}

export function openStore(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

/** A session by id, or the one top-level session whose title contains `reference`. */
export function loadSession(store: DatabaseSync, reference: string): SessionRecord {
  const session = reference.startsWith(SESSION_ID_PREFIX)
    ? (store.prepare("select id, title, directory from session_v2 where id = ?").get(reference) as
        SessionRow | undefined)
    : sessionByTitle(store, reference);
  if (session === undefined) {
    throw new ReportError(`No session ${reference} in the store; pass an id from session_v2 or a title fragment.`);
  }
  const rows = store
    .prepare("select type, data from session_message where session_id = ? order by seq")
    .all(session.id) as unknown as MessageRow[];
  const children = store
    .prepare("select agent, cost from session_v2 where parent_id = ? order by time_created")
    .all(session.id) as unknown as ChildSession[];
  return { id: session.id, title: session.title ?? session.id, directory: session.directory, rows, children };
}

function sessionByTitle(store: DatabaseSync, fragment: string): SessionRow | undefined {
  const matches = store
    .prepare(
      "select id, title, directory from session_v2 where parent_id is null and instr(title, ?) > 0 order by time_created",
    )
    .all(fragment) as unknown as SessionRow[];
  if (matches.length > 1) {
    const listed = matches.map((match) => `  ${match.id} ${match.title ?? ""}`).join("\n");
    throw new ReportError(`Title fragment "${fragment}" matches ${matches.length} sessions; pass one id:\n${listed}`);
  }
  return matches[0];
}

export function report(store: DatabaseSync, references: string[]): string {
  return formatReport(references.map((reference) => summarise(loadSession(store, reference))));
}

function main(args: string[]): void {
  const flag = args.indexOf(DATABASE_FLAG);
  const database = flag < 0 ? DEFAULT_DATABASE : args[flag + 1];
  const references = flag < 0 ? args : args.filter((_, i) => i !== flag && i !== flag + 1);
  if (database === undefined || references.length === 0) throw new ReportError(USAGE);
  const store = openStore(database);
  try {
    process.stdout.write(report(store, references));
  } finally {
    store.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
