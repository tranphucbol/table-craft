import {
  isPluginError,
  type Row,
  type SavepointStatements,
  type Session,
  type Transactions,
} from "@table-craft/plugin-api";
import { CoreError, EditRejectedError } from "@table-craft/core/errors.js";

export interface SubmittedEdits {
  readonly statements: readonly string[];
  /** Summed over every statement; each one touched exactly one row. */
  readonly rowsAffected: number;
}

const EXPECTED_ROWS = 1;
const REJECTED_HINT = "Nothing was saved. Reload the table to see its current rows, then edit again.";

async function drain(rows: AsyncIterable<Row>): Promise<void> {
  for await (const row of rows) void row;
}

function messageOf(error: unknown): string {
  if (isPluginError(error) || error instanceof Error) return error.message;
  return String(error);
}

function countMessage(index: number, affected: number | null): string {
  const counted = affected === null ? "an unknown number of rows" : `${String(affected)} rows`;
  return `Statement ${String(index + 1)} affected ${counted} instead of exactly one; the row may have changed or gone.`;
}

function transactionsOf(session: Session): Transactions {
  const transactions = session.services.transactions;
  if (transactions === undefined) {
    throw new CoreError(
      "invalidRequest",
      "This datasource's plugin cannot run a transaction.",
      "Edit the table with statements in a console.",
    );
  }
  return transactions;
}

/** Runs `statements` in order, each of which must touch exactly one row; returns the rows touched. */
async function applyAll(
  session: Session,
  statements: readonly string[],
  hint: string,
  failed: (index: number) => void,
): Promise<number> {
  let rowsAffected = 0;
  for (const [index, statement] of statements.entries()) {
    failed(index);
    const result = await session.execute(statement);
    await drain(result.rows);
    if (result.rowsAffected !== EXPECTED_ROWS) {
      throw new EditRejectedError(countMessage(index, result.rowsAffected), hint, index, statement);
    }
    rowsAffected += result.rowsAffected;
  }
  failed(statements.length);
  return rowsAffected;
}

function rejected(error: unknown, statements: readonly string[], index: number, hint: string): EditRejectedError {
  if (error instanceof EditRejectedError) return error;
  const failed = index < statements.length ? `Statement ${String(index + 1)} failed: ` : "Commit failed: ";
  return new EditRejectedError(failed + messageOf(error), hint, index, statements[index] ?? "");
}

/**
 * Runs `statements` in one transaction on `session` and commits (decision 026). Every statement must
 * affect exactly one row; any other count or any error rolls the whole batch back and rejects with
 * `EditRejectedError` naming the statement. The session ends in `auto` mode either way.
 */
export async function submitEdits(
  session: Session,
  statements: readonly string[],
  hint: string = REJECTED_HINT,
): Promise<SubmittedEdits> {
  const transactions = transactionsOf(session);
  if (transactions.open) {
    throw new CoreError(
      "invalidRequest",
      "The editor's session already holds an open transaction.",
      "Reload the table, then submit again.",
    );
  }
  if (statements.length === 0) return { statements, rowsAffected: 0 };
  await transactions.setMode("manual");
  let index = 0;
  let rowsAffected: number;
  try {
    rowsAffected = await applyAll(session, statements, hint, (at) => (index = at));
    await transactions.commit();
  } catch (error) {
    await transactions.rollback().catch(() => undefined);
    await transactions.setMode("auto").catch(() => undefined);
    throw rejected(error, statements, index, hint);
  }
  await transactions.setMode("auto");
  return { statements, rowsAffected };
}

/** Left for the caller, which knows whether the session's transaction survived them (plan 027). */
const LOST_SESSION_CODES: ReadonlySet<string> = new Set(["sessionBusy", "connectionLost"]);
const SAVEPOINT_NAME = "table_craft_edits";
const CONSOLE_REJECTED_HINT = "Nothing was saved. Re-run the query to see its current rows, then edit again.";
const IN_TRANSACTION_REJECTED_HINT =
  "Only these edits were undone; the transaction is still open. Re-run the query to see its current rows, then edit again.";

/**
 * Applies a console result's edits on the console's own session, in its transaction mode (decision
 * 056). In `auto` mode they commit together, as the table editor's do. In `manual` mode they join the
 * console's transaction and stay uncommitted; a rejected batch rolls back to a savepoint set before
 * it, so the console's earlier work survives. A plugin without savepoints can only apply edits when
 * no transaction is open, since undoing them would undo everything.
 */
export async function submitConsoleEdits(
  session: Session,
  statements: readonly string[],
  savepoint: ((name: string) => SavepointStatements) | undefined,
): Promise<SubmittedEdits> {
  const transactions = transactionsOf(session);
  if (transactions.mode === "auto") return submitEdits(session, statements, CONSOLE_REJECTED_HINT);
  if (statements.length === 0) return { statements, rowsAffected: 0 };

  let index = 0;
  const track = (at: number): void => void (index = at);
  if (savepoint === undefined) {
    if (transactions.open) {
      throw new CoreError(
        "invalidRequest",
        "The console's transaction is open and this plugin cannot undo only the edits.",
        "Commit or roll back the transaction, then submit again.",
      );
    }
    try {
      return { statements, rowsAffected: await applyAll(session, statements, CONSOLE_REJECTED_HINT, track) };
    } catch (error) {
      await transactions.rollback().catch(() => undefined);
      if (isPluginError(error) && LOST_SESSION_CODES.has(error.code)) throw error;
      throw rejected(error, statements, index, CONSOLE_REJECTED_HINT);
    }
  }

  const { set, rollback, release } = savepoint(SAVEPOINT_NAME);
  await drain((await session.execute(set)).rows);
  try {
    const rowsAffected = await applyAll(session, statements, IN_TRANSACTION_REJECTED_HINT, track);
    await drain((await session.execute(release)).rows);
    return { statements, rowsAffected };
  } catch (error) {
    await session
      .execute(rollback)
      .then((result) => drain(result.rows))
      .then(() => session.execute(release))
      .then((result) => drain(result.rows))
      .catch(() => undefined);
    if (isPluginError(error) && LOST_SESSION_CODES.has(error.code)) throw error;
    throw rejected(error, statements, index, IN_TRANSACTION_REJECTED_HINT);
  }
}
