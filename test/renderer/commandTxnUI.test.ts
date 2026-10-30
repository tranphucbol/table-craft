import { describe, expect, it, vi } from "vitest";
import type { CommandTransaction, CommandTransactionParsed } from "@table-craft/desktop/engine/protocol.js";
import { createTransactionStore } from "@table-craft/desktop/renderer/console/transaction/store.js";
import {
  byteEncoding,
  COMPARE_OPERATORS,
  COMPARE_TARGETS,
  EMPTY_TRANSACTION,
  moved,
  newCompare,
  newOperation,
  transactionCount,
  transactionProblems,
  validSpan,
} from "@table-craft/desktop/renderer/console/transaction/model.js";

const TRANSACTION: CommandTransaction = {
  compare: [newCompare()],
  success: [newOperation("put")],
  failure: [newOperation("get")],
};
function fixture(initial = "") {
  let sql = initial;
  let offset = 0;
  const parse = vi.fn((): Promise<CommandTransactionParsed> =>
    Promise.resolve(
      sql.includes("unparsed")
        ? { kind: "unparsed", reason: "Unsupported flag" }
        : sql === ""
          ? { kind: "unparsed", reason: "No transaction" }
          : { kind: "parsed", transaction: TRANSACTION, from: 0, to: sql.length },
    ),
  );
  const serialize = vi.fn((_id: string, transaction: CommandTransaction) =>
    Promise.resolve({
      text: `plugin text ${String(transactionCount(transaction))}`,
      operationCount: transactionCount(transaction),
      operationLimit: null,
      errors: [],
    }),
  );
  const insert = vi.fn();
  const store = createTransactionStore({
    snapshot: () => ({ datasourceId: "source", sql, selection: { from: offset, to: offset } }),
    parse,
    serialize,
    insert,
  });
  return {
    store,
    parse,
    serialize,
    insert,
    edit: (text: string, caret = 0) => {
      sql = text;
      offset = caret;
    },
    open: async () => {
      await store.getState().probe("source");
      await store.getState().toggle("console");
    },
  };
}

describe("visual command transaction", () => {
  it("givenTypedBytes_whenEncodingChanges_thenBytesStayIntactAndInvalidUtf8StaysHex", () => {
    expect(byteEncoding({ text: "é", hex: null }, "hex")).toEqual({ text: "", hex: "c3a9" });
    expect(byteEncoding({ text: "", hex: "c3a9" }, "text")).toEqual({ text: "é", hex: null });
    expect(byteEncoding({ text: "", hex: "ff" }, "text").hex).toBe("ff");
    expect(byteEncoding({ text: "", hex: "a" }, "text").hex).toBe("a");
  });
  it("givenAllTargetsAndBranches_whenCounted_thenNestedChecksAndBothBranchesCount", () => {
    expect(COMPARE_TARGETS).toHaveLength(5);
    expect(COMPARE_OPERATORS).toHaveLength(4);
    const nested = {
      ...TRANSACTION,
      success: [newOperation("delete"), { kind: "txn" as const, transaction: TRANSACTION }],
    };
    expect(transactionCount(nested)).toBe(7);
    expect(moved(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moved(["a"], 0, -1)).toEqual(["a"]);
    expect(validSpan("abc", 0, 4)).toBe(false);
  });

  it("givenInvalidHexAndBudget_whenEdited_thenBlocksBeforeBridge", () => {
    expect(
      transactionProblems({
        compare: [],
        success: [
          {
            kind: "put",
            key: { text: "", hex: "0" },
            value: { text: "", hex: null },
            lease: { kind: "attach", leaseId: "0" },
          },
        ],
        failure: [],
      }),
    ).toHaveLength(2);
    expect(
      transactionProblems({ ...EMPTY_TRANSACTION, compare: Array.from({ length: 129 }, newCompare) }).join(" "),
    ).toContain("128");
  });

  it("givenNewDraft_whenInserted_thenUsesExistingConsoleInsertionAndLinksExactSpan", async () => {
    const { store, insert, open, edit } = fixture();
    await open();
    await store.getState().change("console", TRANSACTION);
    store.getState().insert("console");
    expect(insert).toHaveBeenCalledWith("console", "plugin text 3");
    edit("before plugin text 3 after");
    store.getState().inserted("console", "plugin text 3", 7, 20);
    expect(store.getState().drafts.console).toMatchObject({ status: "linked", source: { from: 7, to: 20 } });
  });

  it("givenLinkedDraft_whenChanged_thenOnlyPluginSpanIsProposedAndRejectedReplacementStopsSync", async () => {
    const { store, open } = fixture("txn original");
    await open();
    await store.getState().change("console", { ...TRANSACTION, compare: [] });
    const pending = store.getState().drafts.console?.pending;
    expect(pending).toMatchObject({ text: "txn original", from: 0, to: 12, replacement: "plugin text 2" });
    if (pending === undefined || pending === null) throw new Error("Expected pending replacement");
    store.getState().applied("console", pending.sequence, false);
    expect(store.getState().drafts.console?.status).toBe("manual");
    await store.getState().change("console", EMPTY_TRANSACTION);
    expect(store.getState().drafts.console?.transaction.success).toHaveLength(1);
  });

  it("givenManualUnsupportedScript_whenRead_thenPreservesTextAndNeverInserts", async () => {
    const { store, open, edit, insert } = fixture("txn original");
    await open();
    edit("unparsed --unsupported");
    await store.getState().read("console");
    expect(store.getState().drafts.console).toMatchObject({ status: "manual", pending: null });
    store.getState().insert("console");
    expect(insert).not.toHaveBeenCalled();
  });
});
