import { omittedMessages, SERVER_MESSAGE_LIMIT, type ServerMessage } from "@table-craft/plugin-api";

/** What tedious hands an `infoMessage` listener: `PRINT`, and `RAISERROR` at severity 10 or less. */
export interface InfoMessage {
  readonly number: number;
  readonly class: number;
  readonly message: string;
}

/** The number `PRINT` sends, which names no message; anything else is a server or `RAISERROR` message number. */
const PRINT_NUMBER = 0;

export function infoMessage(info: InfoMessage): ServerMessage {
  if (info.number === PRINT_NUMBER) return { level: "info", code: null, text: info.message };
  return { level: "notice", code: String(info.number), text: info.message };
}

/** The messages one statement raised, at most `SERVER_MESSAGE_LIMIT` kept and the rest counted. */
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
