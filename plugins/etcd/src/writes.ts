import {
  PluginError,
  type KeyApplyOptions,
  type KeyBytes,
  type KeyChange,
  type KeyName,
} from "@table-craft/plugin-api";
import type { ITxnRequest } from "etcd3";
import { bytesOf } from "./keyBytes.js";
import type { PutOp, RangeOp } from "./ops.js";
import { txnRequestOf, txnText, type Txn, type TxnCompare } from "./txn.js";

const MS_PER_SECOND = 1000;
const NO_LEASE = "0";
/** Stands for the id `lease grant` returns, which a preview cannot know. */
const NEW_LEASE_PLACEHOLDER = "<new lease>";
const ONE_VALUE =
  "etcd keys hold one value: only the value can change. Edit the value, or delete the key and put a new one.";

/** A key edit as one guarded `Txn` (decision 6 of plan 110), and what the preview shows of it. */
export interface ApplyPlan {
  readonly txn: Txn;
  readonly request: ITxnRequest;
  /** The value the guard expects; null for a key that did not exist. */
  readonly original: KeyBytes | null;
  readonly guarded: boolean;
  /** The seconds of the lease granted first, for a new key with a time to live. */
  readonly leaseSeconds: number | null;
}

export function putOp(key: Buffer, value: Buffer, lease: string, ignoreLease: boolean): PutOp {
  return { kind: "put", key, value, lease, prevKv: false, ignoreLease, ignoreValue: false };
}

function rangeOp(key: Buffer): RangeOp {
  return {
    kind: "get",
    key,
    rangeEnd: null,
    keysOnly: false,
    countOnly: false,
    printValueOnly: false,
    limit: 0,
    revision: 0,
    sortTarget: null,
    sortOrder: null,
  };
}

function valueChange(changes: readonly KeyChange[]): Extract<KeyChange, { kind: "setString" }> {
  let last: Extract<KeyChange, { kind: "setString" }> | null = null;
  for (const change of changes) {
    if (change.kind !== "setString") throw new PluginError("statementFailed", ONE_VALUE);
    last = change;
  }
  if (last === null) throw new PluginError("statementFailed", "Nothing to apply: the key has no pending change.");
  return { ...last, original: changes.find((change) => change.kind === "setString")?.original ?? null };
}

/**
 * The `Txn` that writes the new value. Guarded, it checks the value is still the one read, or for
 * a new key that none was made since, and reads the key back when it is not. Unguarded, it keeps
 * the key's lease when the key exists and writes it plain when it does not. `lease`, the id of a
 * lease granted for `ttlMs`, replaces the key's own; null in a preview.
 */
export function applyPlan(
  key: KeyName,
  changes: readonly KeyChange[],
  options: KeyApplyOptions,
  lease: string | null,
): ApplyPlan {
  const change = valueChange(changes);
  const name = bytesOf(key);
  const value = bytesOf(change.value);
  const withLease = options.ttlMs !== undefined;
  const newLease = lease ?? NEW_LEASE_PLACEHOLDER;
  const put = (existing: boolean) =>
    withLease ? putOp(name, value, newLease, false) : putOp(name, value, NO_LEASE, existing);
  let txn: Txn;
  if (options.guard) {
    const compare: TxnCompare =
      change.original === null
        ? { target: "create", key: name, operator: "=", value: NO_LEASE }
        : { target: "value", key: name, operator: "=", value: bytesOf(change.original) };
    txn = { compares: [compare], success: [put(change.original !== null)], failure: [rangeOp(name)] };
  } else {
    const exists: TxnCompare = { target: "create", key: name, operator: ">", value: NO_LEASE };
    txn = { compares: [exists], success: [put(true)], failure: [put(false)] };
  }
  const leaseSeconds = withLease ? Math.max(1, Math.ceil((options.ttlMs ?? 0) / MS_PER_SECOND)) : null;
  // The placeholder only ever reaches the preview's text; a real apply passes the granted id.
  const request = lease === null && withLease ? { compare: [], success: [], failure: [] } : txnRequestOf(txn);
  return { txn, request, original: change.original, guarded: options.guard, leaseSeconds };
}

/** The plan as the console commands that do the same: `lease grant` first when it grants one. */
export function planText(plan: ApplyPlan): string[] {
  const text = txnText(plan.txn);
  return plan.leaseSeconds === null ? [text] : [`lease grant ${String(plan.leaseSeconds)}`, text];
}
