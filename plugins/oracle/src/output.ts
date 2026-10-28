import oracledb from "oracledb";
import { omittedMessages, SERVER_MESSAGE_LIMIT, type ServerMessage } from "@table-craft/plugin-api";

/** Unlimited buffer, so a long loop of `PUT_LINE` never fails with ORU-10027. */
export const ENABLE_OUTPUT_SQL = "BEGIN DBMS_OUTPUT.ENABLE(NULL); END;";
const GET_LINES_SQL = "BEGIN DBMS_OUTPUT.GET_LINES(:lines, :count); END;";
/** Lines read per round trip; past the message limit they are only counted. */
const LINES_PER_FETCH = 100;
/** `DBMS_OUTPUT` lines carry no code of their own. */
const OUTPUT_CODE = null;
/** A line may be up to 32767 bytes. */
const MAX_LINE_BYTES = 32_767;

/** The node-oracledb warning a `CREATE` of a PL/SQL unit resolves with when the unit does not compile. */
export const COMPILE_WARNING = "NJS-700";

/** Collects one statement's messages, at most `SERVER_MESSAGE_LIMIT` and a count of the rest. */
export class MessageCollector {
  readonly #kept: ServerMessage[] = [];
  #dropped = 0;

  add(message: ServerMessage): void {
    if (this.#kept.length < SERVER_MESSAGE_LIMIT) this.#kept.push(message);
    else this.#dropped += 1;
  }

  messages(): ServerMessage[] {
    return this.#dropped === 0 ? [...this.#kept] : [...this.#kept, omittedMessages(this.#dropped)];
  }
}

interface LinesOut {
  readonly lines: (string | null)[];
  readonly count: number;
}

/** Reads every line `DBMS_OUTPUT` buffered since the last read, emptying the buffer. */
export async function drainOutput(connection: oracledb.Connection, into: MessageCollector): Promise<void> {
  for (;;) {
    const result = await connection.execute<LinesOut>(GET_LINES_SQL, {
      lines: { type: oracledb.STRING, dir: oracledb.BIND_OUT, maxArraySize: LINES_PER_FETCH, maxSize: MAX_LINE_BYTES },
      count: { type: oracledb.NUMBER, dir: oracledb.BIND_INOUT, val: LINES_PER_FETCH },
    });
    const out = result.outBinds;
    if (out === undefined) return;
    for (const line of out.lines.slice(0, out.count)) into.add({ level: "info", code: OUTPUT_CODE, text: line ?? "" });
    if (out.count < LINES_PER_FETCH) return;
  }
}

const UNIT =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(PROCEDURE|FUNCTION|PACKAGE\s+BODY|PACKAGE|TRIGGER|TYPE\s+BODY|TYPE)\s+((?:"[^"]+"|[A-Za-z][\w$#]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z][\w$#]*))?)/i;
const ERROR_CODE = /^([A-Z]{3}-\d{5}):\s*/;

/** The owner and name a `CREATE` of a PL/SQL unit names, folded as the server stores them; null when it names none. */
export function createdUnit(sql: string): { owner: string | null; name: string; type: string } | null {
  const match = UNIT.exec(sql);
  if (match === null) return null;
  const parts = (match[2] ?? "").split(/\s*\.\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(storedName);
  const name = parts.at(-1) ?? "";
  return {
    owner: parts.length > 1 ? (parts[0] ?? null) : null,
    name,
    type: (match[1] ?? "").toUpperCase().replace(/\s+/, " "),
  };
}

function storedName(written: string): string {
  return written.startsWith('"') ? written.slice(1, -1) : written.toUpperCase();
}

const ERRORS_SQL = `SELECT line, position, text, attribute FROM all_errors
  WHERE owner = NVL(:owner, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')) AND name = :name AND type = :type
  ORDER BY sequence`;

type ErrorRow = [number, number, string, string];

/**
 * What the compiler said about a unit created with errors: one warning naming it, then each
 * `ALL_ERRORS` row with its line and column in the unit's source.
 */
export async function compileMessages(
  connection: oracledb.Connection,
  sql: string,
  warning: string,
  into: MessageCollector,
): Promise<void> {
  const unit = createdUnit(sql);
  into.add({ level: "warning", code: COMPILE_WARNING, text: warning });
  if (unit === null) return;
  const result = await connection.execute<ErrorRow>(
    ERRORS_SQL,
    { owner: unit.owner, name: unit.name, type: unit.type },
    { outFormat: oracledb.OUT_FORMAT_ARRAY },
  );
  for (const [line, position, text, attribute] of result.rows ?? []) {
    const code = ERROR_CODE.exec(text);
    into.add({
      level: attribute === "WARNING" ? "warning" : "error",
      code: code?.[1] ?? null,
      text: `Line ${String(line)}, column ${String(position)}: ${code === null ? text : text.slice(code[0].length)}`,
    });
  }
}
