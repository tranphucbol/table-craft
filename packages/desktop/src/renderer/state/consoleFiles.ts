import type { InvokeResult } from "@table-craft/desktop/preload/bridge.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { DEFAULT_CONSOLE_NAME } from "@table-craft/desktop/renderer/state/consoles.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import {
  assertConsoleTextPersistable,
  ConsolePersistenceFailure,
} from "@table-craft/desktop/renderer/state/consolePersistence.js";

/** How long typing must pause before a console is written (decision 16). */
export const AUTOSAVE_DELAY_MS = 500;
const NAME_SEPARATOR = "_";

/** `console`, then `console_1`, `console_2`…: the first that `used` does not hold. */
export function firstFreeName(used: Iterable<string>): string {
  const taken = new Set(used);
  if (!taken.has(DEFAULT_CONSOLE_NAME)) return DEFAULT_CONSOLE_NAME;
  for (let n = 1; ; n++) {
    const name = `${DEFAULT_CONSOLE_NAME}${NAME_SEPARATOR}${n}`;
    if (!taken.has(name)) return name;
  }
}

/** Saved consoles no tab has open, by name (plan 011 decision 14): what Open Closed Console lists. */
export function closedConsoleNames(saved: readonly string[], open: Iterable<string>): readonly string[] {
  const opened = new Set(open);
  return saved.filter((name) => !opened.has(name)).sort((a, b) => a.localeCompare(b));
}

/** The console files main keeps under `<userData>/consoles/<datasourceId>/`. */
export interface ConsoleFileAccess {
  readonly list: (datasourceId: string) => Promise<readonly string[]>;
  readonly read: (datasourceId: string, name: string) => Promise<string | null>;
  readonly write: (datasourceId: string, name: string, text: string) => Promise<void>;
  readonly remove: (datasourceId: string, name: string) => Promise<void>;
}

export class ConsoleFileFailure extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "ConsoleFileFailure";
  }
}

export async function unwrap<T>(pending: Promise<InvokeResult<T>>): Promise<T> {
  const result = await pending;
  if (!result.ok) throw new ConsoleFileFailure(result.error.message, result.error.hint);
  return result.value;
}

export function bridgeConsoleFiles(): ConsoleFileAccess {
  return {
    list: (datasourceId) => unwrap(bridge().listConsoles(datasourceId)),
    read: (datasourceId, name) => unwrap(bridge().readConsole(datasourceId, name)),
    write: async (datasourceId, name, text) => {
      await assertConsoleTextPersistable(datasourceId, text);
      await unwrap(bridge().writeConsole(datasourceId, name, text));
    },
    remove: async (datasourceId, name) => {
      await unwrap(bridge().deleteConsole(datasourceId, name));
    },
  };
}

export interface Timers {
  readonly set: (run: () => void, ms: number) => unknown;
  readonly clear: (timer: unknown) => void;
}

export interface AutosaveOptions {
  readonly files: ConsoleFileAccess;
  readonly timers: Timers;
  readonly delayMs?: number;
  readonly onError: (cause: unknown) => void;
}

export interface Autosave {
  /** Writes the text once typing pauses for `delayMs`. */
  readonly changed: (datasourceId: string, name: string, text: string) => void;
  /** The console closed: written now, or its file deleted when it holds nothing but whitespace. */
  readonly closed: (datasourceId: string, name: string, text: string) => Promise<void>;
  /** Drops the datasource's pending writes; its directory is gone. */
  readonly discard: (datasourceId: string) => void;
  /** Writes every pending change now, before the window closes. */
  readonly flush: () => Promise<void>;
}

interface PendingWrite {
  readonly datasourceId: string;
  readonly name: string;
  readonly text: string;
  readonly timer: unknown;
}

export function createAutosave(options: AutosaveOptions): Autosave {
  const delayMs = options.delayMs ?? AUTOSAVE_DELAY_MS;
  const pending = new Map<string, PendingWrite>();
  const keyOf = (datasourceId: string, name: string) => `${datasourceId}/${name}`;

  function take(key: string): PendingWrite | undefined {
    const write = pending.get(key);
    if (write === undefined) return undefined;
    options.timers.clear(write.timer);
    pending.delete(key);
    return write;
  }

  async function write(datasourceId: string, name: string, text: string): Promise<void> {
    try {
      await options.files.write(datasourceId, name, text);
    } catch (cause) {
      options.onError(cause);
    }
  }

  return {
    changed(datasourceId, name, text) {
      const key = keyOf(datasourceId, name);
      take(key);
      const timer = options.timers.set(() => {
        if (pending.get(key)?.timer !== timer) return;
        pending.delete(key);
        void write(datasourceId, name, text);
      }, delayMs);
      pending.set(key, { datasourceId, name, text, timer });
    },

    async closed(datasourceId, name, text) {
      take(keyOf(datasourceId, name));
      if (text.trim() !== "") {
        await write(datasourceId, name, text);
        return;
      }
      try {
        await options.files.remove(datasourceId, name);
      } catch (cause) {
        options.onError(cause);
      }
    },

    discard(datasourceId) {
      for (const [key, write] of pending) if (write.datasourceId === datasourceId) take(key);
    },

    async flush() {
      const writes = [...pending.keys()].flatMap((key) => take(key) ?? []);
      await Promise.all(writes.map(({ datasourceId, name, text }) => write(datasourceId, name, text)));
    },
  };
}

export const autosave = createAutosave({
  files: bridgeConsoleFiles(),
  timers: {
    set: (run, ms) => globalThis.setTimeout(run, ms),
    clear: (timer) => globalThis.clearTimeout(timer as number),
  },
  onError: (cause) => {
    const hint =
      cause instanceof ConsoleFileFailure || cause instanceof ConsolePersistenceFailure
        ? cause.hint
        : "Check that the profile directory is writable.";
    void useModal.getState().ask({
      kind: "notice",
      title: "Could not save the console",
      message: cause instanceof Error ? cause.message : String(cause),
      hint,
    });
  },
});
