import {
  omittedMessages,
  SERVER_MESSAGE_LIMIT,
  type ServerMessage,
  type ServerMessageLevel,
} from "@table-craft/plugin-api";

/**
 * Read on the statement's own connection: the server keeps one statement's diagnostics per
 * session. No `LIMIT`, which TiDB 4 rejects; the server's `max_error_count` bounds the rows.
 */
export const SHOW_WARNINGS_SQL = "SHOW WARNINGS";

const LEVELS: Readonly<Record<string, ServerMessageLevel>> = {
  error: "error",
  warning: "warning",
  note: "notice",
};

/** The EOF and OK packets carry the count as an unsigned 16-bit integer. */
const WARNING_COUNT_MASK = 0xffff;

export function warningCount(raw: number): number {
  return raw & WARNING_COUNT_MASK;
}

/**
 * `SHOW WARNINGS` rows (`Level`, `Code`, `Message`) as server messages; `count` is what the
 * statement reported, so what the limit cut is said rather than lost.
 */
export function warningMessages(rows: readonly unknown[], count: number): ServerMessage[] {
  const messages = rows.slice(0, SERVER_MESSAGE_LIMIT).map((row): ServerMessage => {
    const { Level, Code, Message } = row as { Level?: string; Code?: number | string | null; Message?: string };
    const level = LEVELS[(Level ?? "").toLowerCase()] ?? "warning";
    const code = Code === undefined || Code === null ? null : String(Code);
    return { level, code, text: Message ?? "" };
  });
  const total = Math.max(count, rows.length);
  if (total > messages.length) messages.push(omittedMessages(total - messages.length));
  return messages;
}
