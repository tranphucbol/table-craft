import { PluginError, type ExecuteResult, type KeySource, type WireValueOptions } from "@table-craft/plugin-api";
import type { IKeyValue, IRangeResponse, ITxnResponse } from "etcd3";
import { runAdmin, type AdminHost } from "./admin.js";
import { argumentsOf, decimalOf } from "./args.js";
import { COMMANDS, commandOf, refusalOf } from "./docs.js";
import { keyBytesOf } from "./keyBytes.js";
import { classify } from "./language.js";
import { kvOpOf, requestOf, type KvOp, type RangeOp } from "./ops.js";
import { bytesCell, kvResult, replyResult } from "./results.js";
import { quoteBytes, tokenize } from "./tokens.js";
import { parseTxn, TXN, txnRequestOf } from "./txn.js";

const KEYSPACE_DATABASE = 0;
const SUCCESS = "SUCCESS";
const FAILURE = "FAILURE";
const NIL = "(nil)";

export interface ConsoleHost extends AdminHost {
  readonly readOnly: boolean;
}

function sourceOf(op: RangeOp, kvs: readonly IKeyValue[]): KeySource | undefined {
  if (op.rangeEnd !== null || op.countOnly || kvs.length !== 1) return undefined;
  return { database: KEYSPACE_DATABASE, key: keyBytesOf(op.key), type: "string", whole: op.printValueOnly };
}

/** The first value alone, as a value read: a single key's is the whole key. */
function valueResult(op: RangeOp, kvs: readonly IKeyValue[], wire: WireValueOptions): ExecuteResult {
  const first = kvs[0];
  const value = first === undefined ? null : bytesCell(first.value, wire);
  const text = first === undefined ? NIL : quoteBytes(first.value);
  const result: ExecuteResult = { ...replyResult(value, text), reply: { value, text, read: true } };
  const source = sourceOf(op, kvs);
  return source === undefined ? result : { ...result, source };
}

function rangeResult(op: RangeOp, response: IRangeResponse, wire: WireValueOptions): ExecuteResult {
  if (op.countOnly) return replyResult(Number(response.count), response.count);
  if (op.printValueOnly) return valueResult(op, response.kvs, wire);
  const result = kvResult(response.kvs, wire, op.keysOnly);
  const source = sourceOf(op, response.kvs);
  return source === undefined ? result : { ...result, source };
}

async function runKv(host: ConsoleHost, op: KvOp, wire: WireValueOptions): Promise<ExecuteResult> {
  const request = requestOf(op);
  switch (op.kind) {
    case "get": {
      const range = request.request_range ?? {};
      return rangeResult(op, await host.call((etcd) => etcd.kv.range(range)), wire);
    }
    case "put": {
      const put = request.request_put ?? {};
      const response = await host.call((etcd) => etcd.kv.put(put));
      return op.prevKv ? kvResult(response.prev_kv === null ? [] : [response.prev_kv], wire) : replyResult("OK", "OK");
    }
    case "del": {
      const deleteRange = request.request_delete_range ?? {};
      const response = await host.call((etcd) => etcd.kv.deleteRange(deleteRange));
      return op.prevKv ? kvResult(response.prev_kvs, wire) : replyResult(Number(response.deleted), response.deleted);
    }
  }
}

function txnResult(response: ITxnResponse, wire: WireValueOptions): ExecuteResult {
  const ranges = response.responses.flatMap((entry) => (entry.response_range ? [entry.response_range] : []));
  if (ranges.length === 0) {
    const verdict = response.succeeded ? SUCCESS : FAILURE;
    return replyResult(verdict, verdict);
  }
  return kvResult(
    ranges.flatMap((range) => range.kvs),
    wire,
  );
}

function unknown(name: string): PluginError {
  const first = [...new Set(COMMANDS.map((doc) => doc.name.split(" ")[0]))].join(", ");
  return new PluginError("statementFailed", `${name} is not a command this console runs. It runs ${first}.`);
}

/**
 * Runs one console command (decision 8 of plan 110): a refused one fails before anything is sent,
 * and a read-only datasource refuses every command `classify` calls a write.
 */
export async function runCommand(host: ConsoleHost, command: string, wire: WireValueOptions): Promise<ExecuteResult> {
  const tokens = tokenize(command.split(/\r?\n/)[0] ?? "");
  if (tokens.length === 0) throw new PluginError("statementFailed", "Nothing to run: the line holds no command.");
  if (tokens.some((token) => !token.closed)) {
    throw new PluginError("statementFailed", "A quote is not closed. Close it and run the command again.");
  }
  const words = tokens.map((token) => token.text);
  const refusal = refusalOf(words);
  if (refusal !== null) throw new PluginError("statementFailed", refusal);
  const isTxn = words.length === 1 && words[0]?.toLowerCase() === TXN;
  const found = commandOf(words);
  if (found === null && !isTxn) throw unknown(words[0] ?? "");
  if (host.readOnly && classify(command).kind === "write") {
    const name = isTxn ? TXN : (found?.doc.name ?? "");
    throw new PluginError(
      "statementFailed",
      `read-only datasource refuses ${name}, which writes. Turn off Read-only on the datasource to run it.`,
    );
  }
  if (isTxn) {
    const request = txnRequestOf(parseTxn(command));
    return txnResult(await host.call((etcd) => etcd.kv.txn(request)), wire);
  }
  if (found === null) throw unknown(words[0] ?? "");
  const { doc } = found;
  switch (doc.name) {
    case "get":
    case "put":
    case "del":
      return runKv(host, kvOpOf(tokens), wire);
    case "compaction": {
      const args = argumentsOf(doc, tokens.slice(found.length));
      const revision = decimalOf(doc, "the revision", args.positional[0]?.text ?? "");
      const physical = args.flags.has("physical");
      await host.call((etcd) => etcd.kv.compact({ revision, physical }));
      return replyResult(Number(revision), `compacted revision ${revision}`);
    }
    default:
      return runAdmin(host, doc, tokens.slice(found.length));
  }
}
