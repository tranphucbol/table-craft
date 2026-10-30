import { describe, expect, it } from "vitest";
import type { CommandTransaction, CommandTransactionOperation, Session } from "@table-craft/plugin-api";
import {
  classify,
  consoleHistoryPolicy,
  detectConsoleIntent,
  inspect,
  split,
  transactionBuilder,
} from "@table-craft/plugin-etcd/language";
import { complete } from "@table-craft/plugin-etcd/complete";
import { parseTxn, txnRequestOf } from "@table-craft/plugin-etcd/txn";
import { kvOpOf, opText, requestOf } from "@table-craft/plugin-etcd/ops";
import { tokenize } from "@table-craft/plugin-etcd/tokens";
import { runCommand, type ConsoleHost } from "@table-craft/plugin-etcd/console";
import { suggestConsoleValues } from "@table-craft/plugin-etcd/consoleCompletion";

const bytes = (text: string) => ({ text, hex: null });
const key = (text: string) => ({ kind: "key" as const, key: bytes(text) });
const put = (name: string): CommandTransactionOperation => ({
  kind: "put",
  key: bytes(name),
  value: { text: "", hex: "00ff" },
  lease: { kind: "preserve" },
});
const block = (success: readonly CommandTransactionOperation[] = []): CommandTransaction => ({
  compare: [],
  success,
  failure: [],
});

describe("etcd transaction builder", () => {
  it("givenAllCompareTargetsAndOperators_whenRoundTripped_thenBytesAndDecimalPrecisionPreserved", () => {
    const transaction: CommandTransaction = {
      compare: ["value", "version", "createRevision", "modRevision", "lease"].flatMap((target) =>
        ["=", "!=", "<", ">"].map((operator) => ({
          target,
          operator,
          range: key("a)"),
          operand: target === "value" ? { text: "", hex: "00ff" } : "9007199254740993",
        })),
      ) as CommandTransaction["compare"],
      success: [put("a")],
      failure: [{ kind: "get", range: key("a") }],
    };
    const serialized = transactionBuilder.serialize(transaction);
    expect(serialized.errors).toEqual([]);
    const parsed = transactionBuilder.parse(serialized.text, 0);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    expect(transactionBuilder.serialize(parsed.transaction)).toEqual(serialized);
    expect(parsed.transaction.compare).toHaveLength(20);
    expect(serialized.operationCount).toBe(22);
  });

  it("givenNestedTxnAtCaret_whenParsed_thenExactOuterSpanAndRecursiveRequest", () => {
    const text =
      'get before\r\ntxn\r\nthen: txn\r\nif: version("a") = 0\r\nthen: put a b\r\nelse: get a\r\nend\r\nelse: del a\r\nend\r\nget after';
    const parsed = transactionBuilder.parse(text, text.indexOf("put"));
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    expect(text.slice(parsed.from, parsed.to)).toBe(split(text)[1]?.sql);
    expect(split(text)).toHaveLength(3);
    expect(txnRequestOf(parseTxn(text.slice(parsed.from, parsed.to))).success?.[0]?.request_txn).toBeDefined();
    expect(classify(text.slice(parsed.from, parsed.to)).kind).toBe("write");
  });

  it("givenUnsupportedOrIncompleteManualSyntax_whenParsed_thenNoReplacementSpan", () => {
    for (const text of [
      "txn\nthen: get a --limit=2\nend",
      "txn\nthen: put a b --prev-kv\nend",
      "txn\nthen: put a b",
      "txn\nthen: get a\nthen: get b\nend",
    ]) {
      expect(transactionBuilder.parse(text, 0).kind).toBe("unparsed");
    }
    expect(() => parseTxn("txn\nend\nput unexpected value")).toThrow(/after end/);
  });

  it("givenConflictingWrites_whenSerialized_thenBranchesAreCheckedWithoutRejectingMutuallyExclusiveWrites", () => {
    expect(transactionBuilder.serialize({ ...block([put("a")]), failure: [put("a")] }).errors).toEqual([]);
    expect(transactionBuilder.serialize(block([put("a"), put("a")])).errors.join()).toContain("conflicting");
    expect(
      transactionBuilder
        .serialize(
          block([
            { kind: "delete", range: { kind: "prefix", prefix: bytes("/") } },
            { kind: "txn", transaction: block([put("/a")]) },
          ]),
        )
        .errors.join(),
    ).toContain("conflicting");
  });

  it("givenConfiguredLimits_whenExceeded_thenSerializationErrorsWithoutPartialReplacement", () => {
    let transaction = block();
    for (let i = 0; i < 8; i += 1) transaction = block([{ kind: "txn", transaction }]);
    expect(transactionBuilder.serialize(transaction).errors.join()).toContain("depth");
    expect(
      transactionBuilder.serialize(block(Array.from({ length: 129 }, (_, i) => put(String(i))))).errors.join(),
    ).toContain("Configured operation limit");
    expect(
      transactionBuilder
        .serialize(
          block([{ kind: "put", key: bytes("a"), value: bytes("x".repeat(1_048_577)), lease: { kind: "detach" } }]),
        )
        .errors.join(),
    ).toContain("byte limit");
    expect(transactionBuilder.parse("txn\nend", -1).kind).toBe("unparsed");
  });

  it("givenRangeOperationsAndSignedLease_whenSerialized_thenExecutionGrammarPreservesSemantics", () => {
    const transaction = block([
      { kind: "get", range: { kind: "all" } },
      { kind: "delete", range: { kind: "range", from: bytes("a"), to: bytes("z") } },
      { kind: "put", key: bytes("zz"), value: bytes("v"), lease: { kind: "attach", leaseId: "-1" } },
    ]);
    const serialized = transactionBuilder.serialize(transaction);
    expect(serialized.errors).toEqual([]);
    const parsed = transactionBuilder.parse(serialized.text, 0);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind === "parsed") expect(parsed.transaction).toEqual(transaction);
  });

  it("givenNestedOperationBudget_whenCounted_thenBothBranchesAndCompareAndContainerAreIncluded", () => {
    const nested: CommandTransactionOperation = {
      kind: "txn",
      transaction: {
        compare: [{ range: key("a"), target: "version", operator: "=", operand: "0" }],
        success: [{ kind: "get", range: key("a") }],
        failure: [{ kind: "get", range: key("b") }],
      },
    };
    const serialized = transactionBuilder.serialize(block([nested]));
    expect(serialized.operationCount).toBe(4);
    expect(serialized.errors).toEqual([]);
    expect(
      transactionBuilder.serialize(
        block(Array.from({ length: 129 }, (_, i) => ({ kind: "get", range: key(String(i)) }))),
      ).operationCount,
    ).toBe(129);
  });

  it("givenInt64Bounds_whenParsedOrSerialized_thenOverflowNeverWrapsOrRounds", () => {
    const op = kvOpOf(tokenize("get a --rev=9007199254740993"));
    expect(requestOf(op).request_range?.revision).toBe("9007199254740993");
    expect(opText(op)).toBe("get a --rev=9007199254740993");
    for (const value of ["9223372036854775808", "01", "-1"]) {
      expect(() => kvOpOf(tokenize(`get a --rev=${value}`))).toThrow();
      expect(() => parseTxn(`txn\nif: version("a") = ${value}\nend`)).toThrow();
    }
    expect(() => parseTxn('txn\nif: lease("a") = 1ffffffffffffffff\nend')).toThrow();
    const overflow = block([
      { kind: "put", key: bytes("a"), value: bytes("b"), lease: { kind: "attach", leaseId: "18446744073709551615" } },
    ]);
    expect(transactionBuilder.serialize(overflow).errors.join()).toContain("int64");
  });

  it("givenEightLevelsAndBinaryKeys_whenSerialized_thenLimitAndEscapesAreStable", () => {
    let transaction = block([{ kind: "get", range: key("--literal") }]);
    for (let i = 1; i < 8; i += 1) transaction = block([{ kind: "txn", transaction }]);
    const serialized = transactionBuilder.serialize(transaction);
    expect(serialized.errors).toEqual([]);
    expect(transactionBuilder.parse(serialized.text, serialized.text.length).kind).toBe("parsed");
    const range = parseTxn('txn\nif: value("a" , "z" ) = "\\x00\\xff"\nend').compares[0];
    expect(range?.rangeEnd?.toString()).toBe("z");
    expect(range?.value).toEqual(Buffer.from([0, 255]));
  });
});

describe("etcd managed console intents", () => {
  it("givenWatchOrCredentials_whenDetected_thenUiHandoffWithoutSecretSyntax", () => {
    expect(detectConsoleIntent("watch /app --prefix")).toMatchObject({
      action: "watch",
      requiresUi: true,
      global: false,
    });
    expect(detectConsoleIntent("user add alice")).toMatchObject({ action: "credentials", requiresUi: true });
    for (const text of ["user add alice secret", "user add alice:secret", "user passwd alice --password=secret"])
      expect(() => detectConsoleIntent(text)).toThrow();
    expect(classify("auth disable").confirmByName).toBe(true);
    expect(detectConsoleIntent("lease keep-alive ab --once")).toMatchObject({ action: "keepAlive", requiresUi: false });
  });

  it("givenCompletionServices_whenAsked_thenConcreteRevisionLeaseAndUserSuggestions", async () => {
    const session = {
      suggestKeys: () => Promise.resolve(["/app/"]),
      suggestConsoleValues: (kind: string) =>
        Promise.resolve([
          {
            label: kind === "revision" ? "current" : "alice",
            apply: kind === "revision" ? "9007199254740993" : "alice",
          },
        ]),
    } as unknown as Session;
    const revision = await complete({ text: "get a --rev=", offset: "get a --rev=".length }, session);
    expect(revision.items[0]).toMatchObject({ label: "current", apply: "9007199254740993" });
    const user = await complete({ text: "user get ", offset: "user get ".length }, session);
    expect(user.items[0]?.label).toBe("alice");
  });

  it("givenMalformedCredentials_whenInspected_thenHistoryAdmissionIsOmittedWithoutEchoingSecrets", async () => {
    for (const text of [
      "user add alice:secret",
      "user passwd alice secret",
      'user add "alice:secret',
      "user passwd alice --password=secret",
    ]) {
      expect(consoleHistoryPolicy(text)).toBe("omit");
      const problems = await inspect({ text, disabled: ["EtcdCostlyCommand"] });
      expect(problems[0]?.inspection).toBe("EtcdConsoleIntent.credentials");
      expect(JSON.stringify(problems)).not.toContain("secret");
    }
    expect(consoleHistoryPolicy("put user 'not a credential'")).toBe("allow");
  });

  it("givenWatchIntent_whenDetected_thenNamespaceRelativeRangeAndDecimalRevisionAreReadyForBridge", async () => {
    expect(detectConsoleIntent("watch /app --prefix --rev=9007199254740993")?.watchRequest).toEqual({
      database: 0,
      range: { kind: "prefix", prefix: bytes("/app") },
      from: { kind: "revision", revision: "9007199254740993" },
    });
    expect((await inspect({ text: "watch /app --prefix" }))[0]?.inspection).toBe("EtcdConsoleIntent.watch");
    expect(detectConsoleIntent('watch "" --from-key')?.watchRequest?.range).toEqual({ kind: "all" });
    expect(() => detectConsoleIntent("watch /app --prefix --from-key")).toThrow();
  });

  it("givenOpenQuotedCompareOrPath_whenCompleted_thenInsertionUsesExecutionEscaping", async () => {
    const session = { suggestKeys: () => Promise.resolve(['a"b\b']) } as unknown as Session;
    for (const text of ['txn\nif: value("a', 'get "a']) {
      const completion = await complete({ text, offset: text.length }, session);
      expect(completion.items[0]?.apply).toBe('"a\\"b\\x08"');
    }
  });

  it("givenServiceBackedCompletion_whenListed_thenSignedLeasesUseConsoleHexAndPrefixesAreBounded", async () => {
    const services = {
      leases: { list: () => Promise.resolve([{ id: "-1", remainingTtlSeconds: null }]) },
    } as unknown as Pick<Session, "leases" | "access" | "cluster">;
    expect(await suggestConsoleValues(services, "lease", "ff")).toEqual([
      { label: "ffffffffffffffff", apply: "ffffffffffffffff", detail: "global lease; TTL unknown" },
    ]);
    expect(
      await suggestConsoleValues(services, "revision", "", () => Promise.resolve("9007199254740993")),
    ).toMatchObject([{ apply: "9007199254740993" }]);
  });

  it("givenMissingNamespaceGatewayOrManagedWatch_whenExecuted_thenNoRawFallbackOrIndefiniteRequest", async () => {
    const host = {
      readOnly: false,
      call: () => {
        throw new Error("Raw bypass");
      },
    } as unknown as ConsoleHost;
    await expect(runCommand(host, "get a", {})).rejects.toThrow(/namespace-safe/);
    await expect(runCommand(host, "watch a", {})).rejects.toThrow(/managed/);
    await expect(runCommand(host, "get a\nput b c", {})).rejects.toThrow(/one command/);
  });

  it("givenSentMutationFailure_whenConsoleRejects_thenOriginalErrorIsPreservedAndNeverReplayed", async () => {
    const uncertain = new Error("Sent request lost its response");
    let sent = 0;
    const mutation = async () => {
      await Promise.resolve();
      sent += 1;
      throw uncertain;
    };
    const host = { readOnly: false, consoleKv: { put: mutation, txn: mutation } } as unknown as ConsoleHost;
    for (const text of ["put a b", "txn\nthen: txn\nthen: put a b\nend\nend"]) {
      await expect(runCommand(host, text, {})).rejects.toBe(uncertain);
    }
    expect(sent).toBe(2);
  });
});
