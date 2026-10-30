import { PluginError, type ExecuteResult, type KeySource, type WireValueOptions } from "@table-craft/plugin-api";
import type {
  IKeyValue,
  IRangeRequest,
  IRangeResponse,
  IPutRequest,
  IPutResponse,
  IDeleteRangeRequest,
  IDeleteRangeResponse,
  ITxnRequest,
  ITxnResponse,
} from "etcd3";
import { runAdmin, type AdminHost } from "./admin.js";
import { detectConsoleIntent, type ConsoleIntent } from "./consoleIntent.js";
import { COMMANDS, commandOf, refusalOf } from "./docs.js";
import { keyBytesOf } from "./keyBytes.js";
import { classify } from "./language.js";
import { kvOpOf, requestOf, type KvOp, type RangeOp } from "./ops.js";
import { bytesCell, kvResult, replyResult } from "./results.js";
import { quoteBytes, tokenize } from "./tokens.js";
import { parseTxn, TXN, TXN_MAX_BYTES, txnRequestOf } from "./txn.js";
import { transactionErrors } from "./transactionBuilder.js";

const KEYSPACE_DATABASE = 0;
const SUCCESS = "SUCCESS";
const FAILURE = "FAILURE";
const NIL = "(nil)";

export interface ConsoleHost extends AdminHost {
  readonly readOnly: boolean;
  readonly consoleKv?: ConsoleKvGateway;
  dispatchConsole?(intent: ConsoleIntent): Promise<ExecuteResult>;
}

/** Namespace mapping and no-replay mutation handling belong to the runtime, never the parser. */
export interface ConsoleKvGateway {
  range(request: IRangeRequest): Promise<IRangeResponse>;
  put(request: IPutRequest): Promise<IPutResponse>;
  deleteRange(request: IDeleteRangeRequest): Promise<IDeleteRangeResponse>;
  txn(request: ITxnRequest): Promise<ITxnResponse>;
}

function gateway(host: ConsoleHost): ConsoleKvGateway {
  if (host.consoleKv === undefined)
    throw new PluginError(
      "statementFailed",
      "The namespace-safe console gateway is unavailable. Reconnect after updating the plugin host.",
    );
  return host.consoleKv;
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
      return rangeResult(op, await gateway(host).range(range), wire);
    }
    case "put": {
      const put = request.request_put ?? {};
      const response = await gateway(host).put(put);
      return op.prevKv ? kvResult(response.prev_kv === null ? [] : [response.prev_kv], wire) : replyResult("OK", "OK");
    }
    case "del": {
      const deleteRange = request.request_delete_range ?? {};
      const response = await gateway(host).deleteRange(deleteRange);
      return op.prevKv ? kvResult(response.prev_kvs, wire) : replyResult(Number(response.deleted), response.deleted);
    }
  }
}

function txnResult(response: ITxnResponse, wire: WireValueOptions): ExecuteResult {
  function rangesOf(result: ITxnResponse): IRangeResponse[] {
    return result.responses.flatMap((entry) =>
      entry.response_txn ? rangesOf(entry.response_txn) : entry.response_range ? [entry.response_range] : [],
    );
  }
  const ranges = rangesOf(response);
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
  if (Buffer.byteLength(command) > TXN_MAX_BYTES)
    throw new PluginError("statementFailed", "Command exceeds configured byte limit.");
  const tokens = tokenize(command.split(/\r?\n/)[0] ?? "");
  if (tokens.length === 0) throw new PluginError("statementFailed", "Nothing to run: the line holds no command.");
  if (tokens.some((token) => !token.closed)) {
    throw new PluginError("statementFailed", "A quote is not closed. Close it and run the command again.");
  }
  const words = tokens.map((token) => token.text);
  const refusal = refusalOf(words);
  if (refusal !== null) throw new PluginError("statementFailed", refusal);
  const isTxn = words.length === 1 && words[0]?.toLowerCase() === TXN;
  if (!isTxn && /[\r\n]/.test(command.trim()))
    throw new PluginError("statementFailed", "Run one command or one complete transaction at a time.");
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
    const txn = parseTxn(command);
    const errors = transactionErrors(txn);
    if (errors.length > 0) throw new PluginError("statementFailed", errors.join(" "));
    const request = txnRequestOf(txn);
    return txnResult(await gateway(host).txn(request), wire);
  }
  if (found === null) throw unknown(words[0] ?? "");
  const { doc } = found;
  switch (doc.name) {
    case "get":
    case "put":
    case "del":
      return runKv(host, kvOpOf(tokens), wire);
    default: {
      const intent = detectConsoleIntent(command);
      if (intent !== null && host.dispatchConsole !== undefined) return host.dispatchConsole(intent);
      if (
        intent !== null &&
        (intent.action !== "admin" || doc.kind === "write" || doc.group === "lease" || doc.group === "auth")
      ) {
        throw new PluginError(
          "statementFailed",
          `${doc.name} requires the matching managed service/confirmation dialog. Open the corresponding tool window.`,
        );
      }
      return runAdmin(host, doc, tokens.slice(found.length));
    }
  }
}
