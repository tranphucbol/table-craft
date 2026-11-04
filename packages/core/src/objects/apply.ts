import { isPluginError, type DdlScript, type Row, type Session } from "@table-craft/plugin-api";
import { CoreError } from "@table-craft/core/errors.js";

export interface AppliedScript {
  readonly statements: number;
}

const ROLLED_BACK_HINT = "Nothing was changed. Fix the design and apply it again.";
const KEPT_HINT =
  "This database commits each DDL statement on its own, so the statements before it stay applied. Synchronize, then finish the change from a console.";
const VERIFY_HINT = "Nothing was changed. Fix the rows the check names, then apply again.";

async function rowsOf(session: Session, sql: string): Promise<Row[]> {
  const result = await session.execute(sql);
  const rows: Row[] = [];
  for await (const row of result.rows) rows.push(row);
  return rows;
}

function messageOf(error: unknown): string {
  if (isPluginError(error) || error instanceof Error) return error.message;
  return String(error);
}

function failed(index: number, error: unknown, transactional: boolean): CoreError {
  const message = `Statement ${String(index + 1)} failed: ${messageOf(error)}`;
  return new CoreError("statementFailed", message, transactional || index === 0 ? ROLLED_BACK_HINT : KEPT_HINT);
}

async function runAll(session: Session, script: DdlScript, transactional: boolean): Promise<void> {
  let index = 0;
  try {
    for (; index < script.statements.length; index += 1) await rowsOf(session, script.statements[index] ?? "");
  } catch (error) {
    throw failed(index, error, transactional);
  }
  for (const check of script.verify) {
    const rows = await rowsOf(session, check);
    if (rows.length > 0) {
      throw new CoreError(
        "statementFailed",
        `${String(rows.length)} rows break a foreign key after the change, so it was rolled back.`,
        VERIFY_HINT,
      );
    }
  }
}

/**
 * Runs a plugin's DDL script on `session`, which nothing else uses (decision 052): `prepare` first,
 * then `statements` and `verify` in one transaction when the script is transactional, then `finish`
 * whatever happened. A verify statement that returns a row fails the change. The session ends in
 * `auto` mode.
 */
export async function applyDdl(session: Session, script: DdlScript): Promise<AppliedScript> {
  const transactions = script.transactional ? session.services.transactions : undefined;
  if (script.transactional && transactions === undefined) {
    throw new CoreError(
      "invalidRequest",
      "The plugin wrote a transactional script for a session without transactions.",
      "Report this as a bug in the plugin.",
    );
  }
  try {
    for (const statement of script.prepare) await rowsOf(session, statement);
    if (transactions === undefined) {
      await runAll(session, script, false);
    } else {
      await transactions.setMode("manual");
      try {
        await runAll(session, script, true);
        await transactions.commit();
      } catch (error) {
        await transactions.rollback().catch(() => undefined);
        throw error;
      } finally {
        await transactions.setMode("auto").catch(() => undefined);
      }
    }
  } finally {
    for (const statement of script.finish) await rowsOf(session, statement).catch(() => undefined);
  }
  return { statements: script.statements.length };
}
