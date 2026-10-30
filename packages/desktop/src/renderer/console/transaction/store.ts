import { create } from "zustand";
import type {
  CommandTransaction,
  CommandTransactionParsed,
  CommandTransactionSerialized,
} from "@table-craft/desktop/engine/protocol.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { EMPTY_TRANSACTION, transactionCount, transactionProblems, validSpan } from "./model.js";

interface Source {
  readonly text: string;
  readonly from: number;
  readonly to: number;
}

export interface TransactionDraft {
  readonly datasourceId: string;
  readonly open: boolean;
  readonly transaction: CommandTransaction;
  readonly preview: CommandTransactionSerialized | null;
  readonly source: Source | null;
  readonly pending: (Source & { readonly replacement: string; readonly sequence: number }) | null;
  readonly inserting: string | null;
  readonly status: "new" | "syncing" | "linked" | "manual";
  readonly message: string | null;
  readonly revision: number;
}

interface ConsoleSnapshot {
  readonly datasourceId: string;
  readonly sql: string;
  readonly selection: { readonly from: number; readonly to: number };
}

export interface TransactionDependencies {
  readonly snapshot: (id: string) => ConsoleSnapshot | undefined;
  readonly parse: (datasourceId: string, text: string, offset: number) => Promise<CommandTransactionParsed>;
  readonly serialize: (datasourceId: string, transaction: CommandTransaction) => Promise<CommandTransactionSerialized>;
  readonly insert: (id: string, text: string) => void;
}

interface TransactionState {
  readonly supported: Readonly<Record<string, boolean>>;
  readonly drafts: Readonly<Record<string, TransactionDraft>>;
  readonly probe: (datasourceId: string) => Promise<void>;
  readonly toggle: (id: string) => Promise<void>;
  readonly change: (id: string, transaction: CommandTransaction) => Promise<void>;
  readonly insert: (id: string) => void;
  readonly read: (id: string) => Promise<void>;
  readonly startNew: (id: string) => Promise<void>;
  readonly observe: (id: string, text: string) => void;
  readonly inserted: (id: string, text: string, from: number, to: number) => void;
  readonly applied: (id: string, sequence: number, accepted: boolean) => void;
  readonly forget: (id: string) => void;
  /** Drops the probe answer, so a reconnected or replaced plugin is asked again. */
  readonly invalidate: (datasourceId?: string) => void;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The transaction could not be read. Try again.";
}

export function createTransactionStore(dependencies: TransactionDependencies) {
  const probes = new Set<string>();
  return create<TransactionState>()((set, get) => {
    const patch = (id: string, changes: Partial<TransactionDraft>) => {
      const draft = get().drafts[id];
      if (draft !== undefined) set({ drafts: { ...get().drafts, [id]: { ...draft, ...changes } } });
    };
    const current = (id: string, draft: TransactionDraft) =>
      get().drafts[id] === draft && dependencies.snapshot(id)?.datasourceId === draft.datasourceId;
    async function serialize(id: string, draft: TransactionDraft, write = false): Promise<void> {
      try {
        const problems = transactionProblems(draft.transaction);
        if (problems.length !== 0) {
          patch(id, {
            status: draft.source === null ? "new" : "linked",
            preview: {
              text: "",
              operationCount: transactionCount(draft.transaction),
              operationLimit: null,
              errors: problems,
            },
          });
          return;
        }
        const preview = await dependencies.serialize(draft.datasourceId, draft.transaction);
        if (!current(id, draft)) return;
        const snapshot = dependencies.snapshot(id);
        if (draft.source !== null && snapshot?.sql !== draft.source.text) {
          patch(id, {
            status: "manual",
            pending: null,
            message: "Edited by hand · read the transaction at the caret to resume.",
          });
          return;
        }
        patch(id, {
          preview,
          status: draft.source === null ? "new" : "linked",
          pending:
            write &&
            draft.source !== null &&
            preview.errors.length === 0 &&
            draft.source.text.slice(draft.source.from, draft.source.to) !== preview.text
              ? { ...draft.source, replacement: preview.text, sequence: draft.revision }
              : null,
          message: null,
        });
      } catch (cause) {
        if (current(id, draft)) patch(id, { status: "manual", message: messageOf(cause) });
      }
    }
    return {
      supported: {},
      drafts: {},
      async probe(datasourceId) {
        if (probes.has(datasourceId)) return;
        probes.add(datasourceId);
        try {
          await dependencies.parse(datasourceId, "", 0);
          await dependencies.serialize(datasourceId, EMPTY_TRANSACTION);
          set({ supported: { ...get().supported, [datasourceId]: true } });
        } catch {
          set({ supported: { ...get().supported, [datasourceId]: false } });
        } finally {
          probes.delete(datasourceId);
        }
      },
      async toggle(id) {
        const snapshot = dependencies.snapshot(id);
        if (snapshot === undefined || !get().supported[snapshot.datasourceId]) return;
        const existing = get().drafts[id];
        if (existing?.datasourceId === snapshot.datasourceId) {
          patch(id, { open: !existing.open });
          return;
        }
        const draft: TransactionDraft = {
          datasourceId: snapshot.datasourceId,
          open: true,
          transaction: EMPTY_TRANSACTION,
          preview: null,
          source: null,
          pending: null,
          inserting: null,
          status: "new",
          message: null,
          revision: 0,
        };
        set({ drafts: { ...get().drafts, [id]: draft } });
        await get().read(id);
      },
      async change(id, transaction) {
        const draft = get().drafts[id];
        if (draft === undefined || draft.status === "manual" || draft.pending !== null || draft.inserting !== null)
          return;
        patch(id, { transaction, status: "syncing", revision: draft.revision + 1, preview: null });
        const next = get().drafts[id];
        if (next !== undefined) await serialize(id, next, true);
      },
      async startNew(id) {
        const draft = get().drafts[id];
        if (draft === undefined) return;
        patch(id, {
          transaction: EMPTY_TRANSACTION,
          source: null,
          pending: null,
          inserting: null,
          status: "new",
          preview: null,
          message: null,
          revision: draft.revision + 1,
        });
        const next = get().drafts[id];
        if (next !== undefined) await serialize(id, next);
      },
      insert(id) {
        const draft = get().drafts[id];
        const snapshot = dependencies.snapshot(id);
        if (
          draft === undefined ||
          snapshot?.datasourceId !== draft.datasourceId ||
          draft.source !== null ||
          draft.status !== "new" ||
          draft.preview === null ||
          draft.preview.errors.length !== 0
        )
          return;
        patch(id, { inserting: draft.preview.text });
        dependencies.insert(id, draft.preview.text);
      },
      async read(id) {
        const draft = get().drafts[id];
        const snapshot = dependencies.snapshot(id);
        if (draft === undefined || snapshot?.datasourceId !== draft.datasourceId) return;
        patch(id, { status: "syncing", pending: null, revision: draft.revision + 1 });
        const reading = get().drafts[id];
        if (reading === undefined) return;
        try {
          const parsed = await dependencies.parse(draft.datasourceId, snapshot.sql, snapshot.selection.from);
          if (!current(id, reading)) return;
          if (dependencies.snapshot(id)?.sql !== snapshot.sql) {
            patch(id, { status: "manual", message: "Edited by hand · read the transaction at the caret to resume." });
            return;
          }
          if (parsed.kind === "unparsed" || !validSpan(snapshot.sql, parsed.from, parsed.to)) {
            if (reading.source === null && snapshot.sql.trim() === "") {
              patch(id, { status: "new" });
            } else {
              patch(id, {
                status: "manual",
                message:
                  parsed.kind === "unparsed"
                    ? `Edited by hand · ${parsed.reason}`
                    : "The plugin returned an invalid text span.",
              });
              return;
            }
          } else {
            patch(id, {
              transaction: parsed.transaction,
              source: { text: snapshot.sql, from: parsed.from, to: parsed.to },
              message: null,
            });
          }
          const next = get().drafts[id];
          if (next !== undefined) await serialize(id, next);
        } catch (cause) {
          if (current(id, reading)) patch(id, { status: "manual", message: messageOf(cause) });
        }
      },
      observe(id, text) {
        const draft = get().drafts[id];
        if (
          draft === undefined ||
          !draft.open ||
          draft.inserting !== null ||
          draft.pending !== null ||
          draft.source === null ||
          draft.source.text === text
        )
          return;
        patch(id, { status: "manual", message: "Edited by hand · reading…" });
        void get().read(id);
      },
      inserted(id, text, from, to) {
        const draft = get().drafts[id];
        const snapshot = dependencies.snapshot(id);
        if (draft?.inserting !== text || snapshot === undefined || snapshot.datasourceId !== draft.datasourceId) return;
        patch(id, { inserting: null, source: { text: snapshot.sql, from, to }, status: "linked" });
      },
      applied(id, sequence, accepted) {
        const draft = get().drafts[id];
        const pending = draft?.pending;
        if (draft === undefined || pending == null || pending.sequence !== sequence) return;
        const text = pending.text.slice(0, pending.from) + pending.replacement + pending.text.slice(pending.to);
        patch(
          id,
          accepted
            ? {
                pending: null,
                source: { text, from: pending.from, to: pending.from + pending.replacement.length },
                status: "linked",
              }
            : { pending: null, status: "manual", message: "Edited by hand · no console text was replaced." },
        );
      },
      forget(id) {
        const drafts = { ...get().drafts };
        delete drafts[id];
        set({ drafts });
      },
      invalidate(datasourceId) {
        if (datasourceId === undefined) {
          if (Object.keys(get().supported).length !== 0) set({ supported: {} });
          return;
        }
        if (!(datasourceId in get().supported)) return;
        const supported = { ...get().supported };
        delete supported[datasourceId];
        set({ supported });
      },
    };
  });
}

export const useCommandTxn = createTransactionStore({
  snapshot: (id) => useConsoles.getState().consoles[id],
  parse: async (id, text, offset) =>
    (await useDatasources.getState().connect(id)).call("commandTxn.parse", { text, offset }),
  serialize: async (id, transaction) =>
    (await useDatasources.getState().connect(id)).call("commandTxn.serialize", { transaction }),
  insert: (id, text) => useConsoles.getState().insert(id, text),
});
