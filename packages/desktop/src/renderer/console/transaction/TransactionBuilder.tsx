import type {
  CommandTransaction,
  CommandTransactionCompare,
  CommandTransactionOperation,
  KeyBytes,
  KeyRange,
} from "@table-craft/desktop/engine/protocol.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { COMMAND_TXN_ACTION_IDS } from "@table-craft/desktop/renderer/actions/commandTxnActions.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { useCommandTxn } from "./store.js";
import {
  byteEncoding,
  COMPARE_TARGETS,
  COMPARE_OPERATORS,
  DEFAULT_OPERATION_LIMIT,
  EMPTY_BYTES,
  MAX_TRANSACTION_DEPTH,
  moved,
  newCompare,
  newOperation,
} from "./model.js";

const FIELD =
  "min-w-0 rounded border border-line bg-canvas px-cell py-1 text-ink outline-none focus:border-accent disabled:opacity-50";
const BUTTON = "rounded px-cell py-1 text-ink-muted hover:bg-raised hover:text-ink disabled:opacity-40";

function BytesInput({
  label,
  value,
  change,
}: {
  readonly label: string;
  readonly value: KeyBytes;
  readonly change: (value: KeyBytes) => void;
}) {
  return (
    <label className="flex min-w-0 flex-1 items-center gap-1">
      <span className="sr-only">{label}</span>
      <select
        aria-label={`${label} encoding`}
        title="Text needs valid UTF-8 bytes; other bytes stay in Hex."
        className={FIELD}
        value={value.hex === null ? "text" : "hex"}
        onChange={(event) => change(byteEncoding(value, event.target.value === "hex" ? "hex" : "text"))}
      >
        <option value="text">Text</option>
        <option value="hex">Hex</option>
      </select>
      <input
        aria-label={label}
        className={`${FIELD} w-full font-editor`}
        value={value.hex ?? value.text}
        placeholder={label}
        onChange={(event) =>
          change(value.hex === null ? { text: event.target.value, hex: null } : { text: "", hex: event.target.value })
        }
      />
    </label>
  );
}

function RangeInput({ range, change }: { readonly range: KeyRange; readonly change: (range: KeyRange) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      <select
        aria-label="Key range"
        value={range.kind}
        className={FIELD}
        onChange={(event) => {
          const kind = event.target.value;
          change(
            kind === "all"
              ? { kind }
              : kind === "prefix"
                ? { kind, prefix: EMPTY_BYTES }
                : kind === "range"
                  ? { kind, from: EMPTY_BYTES, to: EMPTY_BYTES }
                  : { kind: "key", key: EMPTY_BYTES },
          );
        }}
      >
        <option value="key">Key</option>
        <option value="prefix">Prefix</option>
        <option value="range">Range</option>
        <option value="all">All keys</option>
      </select>
      {range.kind === "key" ? (
        <BytesInput label="Key" value={range.key} change={(key) => change({ ...range, key })} />
      ) : null}
      {range.kind === "prefix" ? (
        <BytesInput label="Prefix" value={range.prefix} change={(prefix) => change({ ...range, prefix })} />
      ) : null}
      {range.kind === "range" ? (
        <>
          <BytesInput label="From" value={range.from} change={(from) => change({ ...range, from })} />
          <BytesInput label="To (exclusive)" value={range.to} change={(to) => change({ ...range, to })} />
        </>
      ) : null}
    </div>
  );
}

function RowControls({
  index,
  count,
  move,
  remove,
}: {
  readonly index: number;
  readonly count: number;
  readonly move: (delta: number) => void;
  readonly remove: () => void;
}) {
  return (
    <div className="flex justify-end gap-1">
      <button type="button" aria-label="Move row up" className={BUTTON} disabled={index === 0} onClick={() => move(-1)}>
        ↑
      </button>
      <button
        type="button"
        aria-label="Move row down"
        className={BUTTON}
        disabled={index === count - 1}
        onClick={() => move(1)}
      >
        ↓
      </button>
      <button type="button" aria-label="Remove row" className={BUTTON} onClick={remove}>
        Remove
      </button>
    </div>
  );
}

function CompareRow({
  value,
  change,
}: {
  readonly value: CommandTransactionCompare;
  readonly change: (value: CommandTransactionCompare) => void;
}) {
  return (
    <div className="space-y-1">
      <RangeInput range={value.range} change={(range) => change({ ...value, range })} />
      <div className="flex flex-wrap gap-1">
        <select
          aria-label="Compare target"
          className={FIELD}
          value={value.target}
          onChange={(event) => {
            const target = COMPARE_TARGETS.find((item) => item.value === event.target.value)?.value;
            if (target !== undefined) change({ ...value, target, operand: target === "value" ? EMPTY_BYTES : "0" });
          }}
        >
          {COMPARE_TARGETS.map((target) => (
            <option key={target.value} value={target.value}>
              {target.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Compare operator"
          className={FIELD}
          value={value.operator}
          onChange={(event) => {
            const operator = COMPARE_OPERATORS.find((item) => item === event.target.value);
            if (operator !== undefined) change({ ...value, operator });
          }}
        >
          {COMPARE_OPERATORS.map((operator) => (
            <option key={operator}>{operator}</option>
          ))}
        </select>
        {typeof value.operand === "string" ? (
          <input
            aria-label="Decimal comparison value"
            className={`${FIELD} flex-1 font-editor`}
            value={value.operand}
            onChange={(event) => change({ ...value, operand: event.target.value })}
          />
        ) : (
          <BytesInput
            label="Comparison value"
            value={value.operand}
            change={(operand) => change({ ...value, operand })}
          />
        )}
      </div>
    </div>
  );
}

function OperationRow({
  operation,
  change,
  depth,
}: {
  readonly operation: CommandTransactionOperation;
  readonly change: (operation: CommandTransactionOperation) => void;
  readonly depth: number;
}) {
  return (
    <div className="space-y-1">
      <select
        aria-label="Operation"
        className={FIELD}
        value={operation.kind}
        onChange={(event) => {
          const kind = event.target.value;
          if (kind === "get" || kind === "put" || kind === "delete" || kind === "txn") change(newOperation(kind));
        }}
      >
        <option value="get">Get</option>
        <option value="put">Put</option>
        <option value="delete">Delete</option>
        <option value="txn" disabled={depth >= MAX_TRANSACTION_DEPTH}>
          Nested Txn
        </option>
      </select>
      {operation.kind === "txn" ? (
        <TransactionRows
          value={operation.transaction}
          change={(transaction) => change({ ...operation, transaction })}
          depth={depth + 1}
        />
      ) : operation.kind === "put" ? (
        <>
          <BytesInput label="Key" value={operation.key} change={(key) => change({ ...operation, key })} />
          <BytesInput label="Value" value={operation.value} change={(value) => change({ ...operation, value })} />
          <label className="flex flex-wrap items-center gap-1">
            Lease
            <select
              aria-label="Put lease"
              className={FIELD}
              value={operation.lease.kind}
              onChange={(event) =>
                change({
                  ...operation,
                  lease:
                    event.target.value === "attach"
                      ? { kind: "attach", leaseId: "" }
                      : event.target.value === "preserve"
                        ? { kind: "preserve" }
                        : { kind: "detach" },
                })
              }
            >
              <option value="detach">No lease</option>
              <option value="preserve">Keep current</option>
              <option value="attach">Attach ID</option>
            </select>
            {operation.lease.kind === "attach" ? (
              <input
                aria-label="Lease ID (decimal)"
                className={`${FIELD} w-full font-editor`}
                value={operation.lease.leaseId}
                onChange={(event) => change({ ...operation, lease: { kind: "attach", leaseId: event.target.value } })}
              />
            ) : null}
          </label>
        </>
      ) : (
        <RangeInput range={operation.range} change={(range) => change({ ...operation, range })} />
      )}
    </div>
  );
}

function TransactionRows({
  value,
  change,
  depth = 1,
}: {
  readonly value: CommandTransaction;
  readonly change: (transaction: CommandTransaction) => void;
  readonly depth?: number;
}) {
  return (
    <div
      className={depth === 1 ? "grid grid-cols-1 gap-gap lg:grid-cols-3" : "space-y-gap border-l border-line pl-gap"}
    >
      <section aria-label="If all are true" className="min-w-0 space-y-1">
        <h3 className="font-semibold text-ink-muted">If all are true</h3>
        {value.compare.map((compare, index) => (
          <div key={index} className="rounded border border-line bg-panel p-cell">
            <CompareRow
              value={compare}
              change={(next) =>
                change({ ...value, compare: value.compare.map((row, at) => (at === index ? next : row)) })
              }
            />
            <RowControls
              index={index}
              count={value.compare.length}
              move={(delta) => change({ ...value, compare: moved(value.compare, index, delta) })}
              remove={() => change({ ...value, compare: value.compare.filter((_, at) => at !== index) })}
            />
          </div>
        ))}
        <button
          type="button"
          className={BUTTON}
          onClick={() => change({ ...value, compare: [...value.compare, newCompare()] })}
        >
          + Add check
        </button>
      </section>
      {(["success", "failure"] as const).map((branch) => (
        <section key={branch} aria-label={branch === "success" ? "Then" : "Else"} className="min-w-0 space-y-1">
          <h3 className="font-semibold text-ink-muted">{branch === "success" ? "Then" : "Else"}</h3>
          {value[branch].map((operation, index) => (
            <div key={index} className="rounded border border-line bg-panel p-cell">
              <OperationRow
                operation={operation}
                depth={depth}
                change={(next) =>
                  change({ ...value, [branch]: value[branch].map((row, at) => (at === index ? next : row)) })
                }
              />
              <RowControls
                index={index}
                count={value[branch].length}
                move={(delta) => change({ ...value, [branch]: moved(value[branch], index, delta) })}
                remove={() => change({ ...value, [branch]: value[branch].filter((_, at) => at !== index) })}
              />
            </div>
          ))}
          <button
            type="button"
            className={BUTTON}
            onClick={() => change({ ...value, [branch]: [...value[branch], newOperation("get")] })}
          >
            + Add operation
          </button>
        </section>
      ))}
    </div>
  );
}

export function TransactionBuilder({ consoleId }: { readonly consoleId: string }) {
  const draft = useCommandTxn((state) => state.drafts[consoleId]);
  if (draft?.open !== true) return null;
  const preview = draft.preview;
  return (
    <section
      aria-label="Transaction builder"
      className="max-h-dialog-height shrink-0 space-y-gap overflow-auto border-b border-line bg-canvas p-gap text-ui"
    >
      <header className="flex flex-wrap items-center gap-gap">
        <h2 className="font-semibold">Txn Builder</h2>
        <span
          className="mr-auto text-ink-muted"
          title="Counts checks and operations across both branches and nested transactions. This is not a measured server setting."
        >
          {preview === null
            ? "Checking…"
            : `${String(preview.operationCount)} operations · ${preview.operationLimit === null ? `server limit unknown (default ${String(DEFAULT_OPERATION_LIMIT)})` : `configured/default limit ${String(preview.operationLimit)}`}`}
        </span>
        <ActionButton actionId={COMMAND_TXN_ACTION_IDS.read} />
        <ActionButton actionId={COMMAND_TXN_ACTION_IDS.startNew} />
        <ActionButton actionId={COMMAND_TXN_ACTION_IDS.toggle} compact />
      </header>
      {draft.message === null ? null : (
        <p role="status" className="text-warning">
          {draft.message}
        </p>
      )}
      <fieldset
        disabled={draft.status === "manual" || draft.pending !== null || draft.inserting !== null}
        className="min-w-0 disabled:opacity-50"
      >
        <legend className="sr-only">Transaction checks and operations</legend>
        <TransactionRows
          value={draft.transaction}
          change={(transaction) => void invoke(COMMAND_TXN_ACTION_IDS.change, { consoleId, transaction })}
        />
      </fieldset>
      {preview?.errors.map((error) => (
        <p key={error} role="alert" className="text-danger">
          {error}
        </p>
      ))}
      <details>
        <summary className="cursor-pointer text-ink-muted">Command preview</summary>
        <pre className="overflow-auto whitespace-pre-wrap font-editor select-text">{preview?.text ?? ""}</pre>
      </details>
      <div className="flex flex-wrap items-center gap-gap">
        {draft.source === null ? (
          <ActionButton actionId={COMMAND_TXN_ACTION_IDS.insert} />
        ) : (
          <span className="text-ink-muted">
            {draft.status === "manual" ? "Console text is unchanged." : "Linked to the transaction in the console."}
          </span>
        )}
        <span className="text-ink-muted">Nothing runs here. Review the script, then use Run.</span>
      </div>
    </section>
  );
}
