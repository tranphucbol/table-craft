import type { ServerMessage, ServerMessageLevel } from "@table-craft/desktop/engine/protocol.js";
import type { OutputTone } from "@table-craft/desktop/renderer/state/consoles.js";

/** The words the server itself uses: MySQL's `Note`, PostgreSQL's `NOTICE` read as `Notice`. */
const LEVEL_LABEL: Readonly<Record<ServerMessageLevel, string>> = {
  error: "Error",
  warning: "Warning",
  notice: "Note",
  info: "Info",
};

const LEVEL_TONE: Readonly<Record<ServerMessageLevel, OutputTone>> = {
  error: "error",
  warning: "warning",
  notice: "info",
  info: "info",
};

/** `Warning 1815: use_index(...) is inapplicable…`, the way the server's own client prints it. */
export function serverMessageText(message: ServerMessage): string {
  const code = message.code === null ? "" : ` ${message.code}`;
  return `${LEVEL_LABEL[message.level]}${code}: ${message.text}`;
}

export function serverMessageTone(message: ServerMessage): OutputTone {
  return LEVEL_TONE[message.level];
}

/** Messages a badge counts: warnings and errors, not the notes a server adds for information. */
export function warningCount(messages: readonly ServerMessage[] | undefined): number {
  return messages?.filter((message) => message.level === "warning" || message.level === "error").length ?? 0;
}

export function warningsText(count: number): string {
  return `${count} ${count === 1 ? "warning" : "warnings"}`;
}

/** One message per line, for a badge's tooltip. */
export function serverMessagesTooltip(messages: readonly ServerMessage[]): string {
  return messages.map(serverMessageText).join("\n");
}
