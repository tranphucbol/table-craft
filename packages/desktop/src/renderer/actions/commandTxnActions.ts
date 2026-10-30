import type { CommandTransaction } from "@table-craft/desktop/engine/protocol.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { useCommandTxn } from "@table-craft/desktop/renderer/console/transaction/store.js";

export const COMMAND_TXN_ACTION_IDS = {
  toggle: "console.transactionBuilder",
  change: "console.transactionBuilder.change",
  insert: "console.transactionBuilder.insert",
  read: "console.transactionBuilder.read",
  startNew: "console.transactionBuilder.new",
} as const;

function available(context: ActionContext): boolean {
  return (
    context.capabilities.includes("commands") &&
    context.console !== null &&
    useCommandTxn.getState().supported[context.console.datasourceId] === true
  );
}

export const COMMAND_TXN_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: COMMAND_TXN_ACTION_IDS.toggle,
    title: "Txn Builder",
    category: "Console",
    icon: "generate",
    tabKind: "console",
    available,
    run: async (context) => {
      if (context.activeTab !== null) await useCommandTxn.getState().toggle(context.activeTab.id);
    },
  }),
  defineAction<{ readonly consoleId: string; readonly transaction: CommandTransaction }>({
    id: COMMAND_TXN_ACTION_IDS.change,
    title: "Edit Transaction",
    category: "Console",
    tabKind: "console",
    available,
    run: async (_context, args) => {
      await useCommandTxn.getState().change(args.consoleId, args.transaction);
    },
  }),
  defineAction<{ readonly consoleId: string } | undefined>({
    id: COMMAND_TXN_ACTION_IDS.insert,
    title: "Insert Transaction at Caret",
    category: "Console",
    tabKind: "console",
    available,
    when: (context) => {
      const draft = context.activeTab === null ? undefined : useCommandTxn.getState().drafts[context.activeTab.id];
      return draft?.status === "new" && draft.preview !== null && draft.preview.errors.length === 0;
    },
    run: (context, args) => {
      const id = args?.consoleId ?? context.activeTab?.id;
      if (id !== undefined) useCommandTxn.getState().insert(id);
    },
  }),
  defineAction<{ readonly consoleId: string } | undefined>({
    id: COMMAND_TXN_ACTION_IDS.read,
    title: "Read Transaction at Caret",
    category: "Console",
    tabKind: "console",
    available,
    run: async (context, args) => {
      const id = args?.consoleId ?? context.activeTab?.id;
      if (id !== undefined) await useCommandTxn.getState().read(id);
    },
  }),
  defineAction<{ readonly consoleId: string } | undefined>({
    id: COMMAND_TXN_ACTION_IDS.startNew,
    title: "New Transaction Draft",
    category: "Console",
    tabKind: "console",
    available,
    run: async (context, args) => {
      const id = args?.consoleId ?? context.activeTab?.id;
      if (id !== undefined) await useCommandTxn.getState().startNew(id);
    },
  }),
];
