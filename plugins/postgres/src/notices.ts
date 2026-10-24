import {
  omittedMessages,
  SERVER_MESSAGE_LIMIT,
  type ServerMessage,
  type ServerMessageLevel,
} from "@table-craft/plugin-api";

/** What `pg` hands a `notice` listener; `severity` is the untranslated one when the server sends it. */
export interface Notice {
  readonly severity?: string | undefined;
  readonly code?: string | undefined;
  readonly message?: string | undefined;
}

const LEVELS: Readonly<Record<string, ServerMessageLevel>> = {
  WARNING: "warning",
  NOTICE: "notice",
};

export function noticeMessage(notice: Notice): ServerMessage {
  return {
    level: LEVELS[(notice.severity ?? "").toUpperCase()] ?? "info",
    code: notice.code ?? null,
    text: notice.message ?? "",
  };
}

/** The notices one statement raised, at most `SERVER_MESSAGE_LIMIT` kept and the rest counted. */
export class NoticeCollector {
  readonly #kept: ServerMessage[] = [];
  #dropped = 0;

  add(notice: Notice): void {
    if (this.#kept.length < SERVER_MESSAGE_LIMIT) this.#kept.push(noticeMessage(notice));
    else this.#dropped += 1;
  }

  messages(): ServerMessage[] {
    return this.#dropped === 0 ? [...this.#kept] : [...this.#kept, omittedMessages(this.#dropped)];
  }
}
