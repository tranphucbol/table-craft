import { describe, expect, it } from "vitest";
import { complete, signatureAt } from "@table-craft/plugin-etcd/complete";
import { commandOf, refusalOf } from "@table-craft/plugin-etcd/docs";
import { classify, inspect, split } from "@table-craft/plugin-etcd/language";
import { kvOpOf, opText, requestOf } from "@table-craft/plugin-etcd/ops";
import { quoteBytes, tokenize } from "@table-craft/plugin-etcd/tokens";
import { parseCompare, parseTxn, txnRequestOf, txnText, txnWrites } from "@table-craft/plugin-etcd/txn";

function at(text: string, caret = text.length) {
  return { text, offset: caret };
}

describe("etcd tokens", () => {
  it("givenShellQuoting_whenTokenized_thenEscapesDecoded", () => {
    const tokens = tokenize(String.raw`put "a b\x41\n" 'it\s' plain\ word`);
    expect(tokens.map((token) => token.text)).toEqual(["put", "a bA\n", String.raw`it\s`, "plain word"]);
    expect(tokens.every((token) => token.closed)).toBe(true);
  });

  it("givenUnclosedQuote_whenTokenized_thenLastTokenOpen", () => {
    expect(tokenize('get "half').at(-1)?.closed).toBe(false);
  });

  it("givenAnyBytes_whenQuotedAndTokenized_thenSameBytes", () => {
    for (const bytes of [
      Buffer.from("plain"),
      Buffer.from("--prefix"),
      Buffer.from([0, 0xff, 0x0a, 0x22]),
      Buffer.from("a b"),
    ]) {
      expect(tokenize(quoteBytes(bytes))[0]?.bytes).toEqual(bytes);
    }
  });
});

describe("etcd split", () => {
  it("givenLinesAndComments_whenSplit_thenOneSpanPerCommand", () => {
    const text = "# note\nget a\n\nput b 1\n";
    expect(split(text).map((span) => span.sql)).toEqual(["get a", "put b 1"]);
  });

  it("givenTxnBlock_whenSplit_thenBlockThroughEndIsOneSpan", () => {
    const text = 'get a\ntxn\nif: value("a") = "1"\nthen: put a 2\nelse: get a\nend\ndel a';
    expect(split(text).map((span) => span.sql)).toEqual([
      "get a",
      'txn\nif: value("a") = "1"\nthen: put a 2\nelse: get a\nend',
      "del a",
    ]);
  });

  it("givenTxnWithoutEnd_whenSplit_thenRunsToLastCommandLine", () => {
    const spans = split("txn\nthen: put a 1\n\n");
    expect(spans).toHaveLength(1);
    expect(spans[0]?.sql).toBe("txn\nthen: put a 1");
  });
});

describe("etcd classify", () => {
  it("givenReadsAndWrites_whenClassified_thenKindFromCommandTable", () => {
    expect(classify("get a").kind).toBe("read");
    expect(classify("put a 1").kind).toBe("write");
    expect(classify("lease grant 60").kind).toBe("write");
    expect(classify("member list").kind).toBe("read");
    expect(classify("frobnicate").kind).toBe("other");
  });

  it("givenTxnWithWrite_whenClassified_thenWrite", () => {
    expect(classify('txn\nif: mod("a") > 1\nthen: get a\nend').kind).toBe("read");
    expect(classify("txn\nthen: get a\nelse:\n  del a\nend").kind).toBe("write");
  });

  it("givenDelOfEverything_whenClassified_thenDestructiveByName", () => {
    const everything = classify('del "" --prefix');
    expect(everything.destructive).toBe("del deletes every key");
    expect(everything.confirmByName).toBe(true);
    expect(classify("del /app --prefix").destructive).toBe('del deletes every key under "/app"');
    expect(classify("del a").destructive).toBeNull();
  });

  it("givenRangeGetWithoutLimit_whenInspected_thenCostlyWithLimitFix", async () => {
    expect(classify("get /app --prefix").costly).toBe("get of a range without --limit reads every key in it");
    expect(classify("get /app --prefix --limit=5").costly).toBeUndefined();
    const [problem] = await inspect({ text: "get /app --prefix" });
    expect(problem?.fixes[0]?.edits[0]?.insert).toBe("get /app --prefix --limit=1000");
  });
});

describe("etcd commands", () => {
  it("givenRefusedCommand_whenAsked_thenReasonNamesIt", () => {
    expect(refusalOf(["watch", "a"])).toBeNull();
    expect(refusalOf(["member", "add", "x"])).toBe("member add is not in the console yet; use etcdctl for it.");
    expect(refusalOf(["get", "a"])).toBeNull();
  });

  it("givenSubcommand_whenLookedUp_thenTwoWordName", () => {
    expect(commandOf(["LEASE", "grant", "5"])?.doc.name).toBe("lease grant");
    expect(commandOf(["get", "a"])?.length).toBe(1);
  });

  it("givenGetFlags_whenParsed_thenRangeRequest", () => {
    const op = kvOpOf(tokenize("get /app --prefix --limit=2 --sort-by=modify --order descend"));
    expect(requestOf(op).request_range).toMatchObject({
      key: Buffer.from("/app"),
      range_end: Buffer.from("/apq"),
      limit: 2,
      sort_target: "Mod",
      sort_order: "Descend",
    });
  });

  it("givenPutWithHexLease_whenParsedAndPrinted_thenRoundTrips", () => {
    const op = kvOpOf(tokenize('put "a b" v --lease=694d77aa9e38260f'));
    expect(op).toMatchObject({ kind: "put", lease: BigInt("0x694d77aa9e38260f").toString() });
    expect(opText(op)).toBe('put "a b" v --lease=694d77aa9e38260f');
  });

  it("givenEmptyKeyRange_whenParsed_thenStartsAtFirstKeyEtcdAccepts", () => {
    const everything = { key: Buffer.from([0]), range_end: Buffer.from([0]) };
    expect(requestOf(kvOpOf(tokenize('get "" --prefix'))).request_range).toMatchObject(everything);
    expect(requestOf(kvOpOf(tokenize('get "" --from-key'))).request_range).toMatchObject(everything);
    expect(requestOf(kvOpOf(tokenize('del "" --from-key'))).request_delete_range).toMatchObject(everything);
    expect(requestOf(kvOpOf(tokenize('get "" /b'))).request_range).toMatchObject({ key: Buffer.from([0]) });
    expect(requestOf(kvOpOf(tokenize("get /a --prefix"))).request_range?.key).toEqual(Buffer.from("/a"));
  });

  it("givenUnknownFlag_whenParsed_thenErrorListsFlags", () => {
    expect(() => kvOpOf(tokenize("del a --keys-only"))).toThrow(/unknown flag --keys-only/);
  });
});

describe("etcd txn", () => {
  it("givenBlock_whenParsed_thenComparesAndBranches", () => {
    const txn = parseTxn('txn\nif: value("a") = "1"\n    mod("b") > 5\nthen: put a 2\nelse:\n  get a\nend');
    expect(txn.compares).toHaveLength(2);
    expect(txn.success.map((op) => op.kind)).toEqual(["put"]);
    expect(txn.failure.map((op) => op.kind)).toEqual(["get"]);
    expect(txnWrites(txn)).toBe(true);
    const request = txnRequestOf(txn);
    expect(request.compare?.[0]).toMatchObject({ target: "Value", result: "Equal", value: Buffer.from("1") });
    expect(request.compare?.[1]).toMatchObject({ target: "Mod", result: "Greater", mod_revision: "5" });
  });

  it("givenParsedBlock_whenPrinted_thenParsesBack", () => {
    const txn = parseTxn('txn\nif: create("k)") = 0\nthen: put "k)" "\\x00"\nend');
    expect(parseTxn(txnText(txn))).toEqual(txn);
  });

  it("givenBadCompare_whenParsed_thenSaysWhatToWrite", () => {
    expect(() => parseCompare('size("a") = 1')).toThrow(/is not a compare/);
    expect(() => parseTxn("txn\nput a 1\nend")).toThrow(/comes before if:/);
    expect(() => parseTxn("txn\nthen: put a 1")).toThrow(/no end line/);
  });
});

describe("etcd completion", () => {
  it("givenEmptyLine_whenCompleted_thenFirstWords", async () => {
    const result = await complete(at("le"), null);
    expect(result.items.map((item) => item.label)).toContain("lease");
    expect(result.from).toBe(0);
  });

  it("givenContainer_whenCompleted_thenSubcommands", async () => {
    const result = await complete(at("lease "), null);
    expect(result.items.map((item) => item.label)).toEqual([
      "grant",
      "revoke",
      "timetolive",
      "list",
      "ttl",
      "keep-alive",
    ]);
  });

  it("givenFlagPrefix_whenCompleted_thenUnusedFlags", async () => {
    const result = await complete(at("get a --prefix --"), null);
    const labels = result.items.map((item) => item.label);
    expect(labels).toContain("--limit");
    expect(labels).not.toContain("--prefix");
  });

  it("givenChoiceFlag_whenCompleted_thenChoices", async () => {
    const text = "get a --sort-by=";
    const result = await complete(at(text), null);
    expect(result.from).toBe(text.length);
    expect(result.items.map((item) => item.label)).toContain("MODIFY");
  });

  it("givenKeyArgument_whenCompletedWithSession_thenKeysQuoted", async () => {
    const session = { suggestKeys: () => Promise.resolve(["/app/a b"]) };
    const result = await complete(at("get /ap"), session as never);
    expect(result.items[0]).toMatchObject({ label: "/app/a b", apply: '"/app/a b"' });
  });

  it("givenInsideTxn_whenCompleted_thenOpsAndHeadings", async () => {
    const result = await complete(at('txn\nif: mod("a") > 1\nthen: '), null);
    expect(result.items.map((item) => item.label)).toEqual([
      "get",
      "put",
      "del",
      "txn",
      "if:",
      "then:",
      "else:",
      "end",
      "value",
      "version",
      "create",
      "mod",
      "lease",
    ]);
  });

  it("givenCaretInPut_whenSignature_thenArgumentIndex", async () => {
    const help = await signatureAt(at("put a "), null);
    expect(help?.name).toBe("put");
    expect(help?.argument).toBe(1);
  });
});
