import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { Button, Select } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { relationshipProblem } from "@table-craft/desktop/renderer/model/diagram.js";
import {
  relationshipAnswer,
  useModal,
  type ModalRequest,
  type RelationshipTable,
} from "@table-craft/desktop/renderer/state/modal.js";
import { ICON_BUTTON } from "@table-craft/desktop/renderer/ui/iconButtonClasses.js";
import { CloseIcon } from "@table-craft/desktop/renderer/ui/icons.js";

type RelationshipRequest = Extract<ModalRequest, { kind: "relationship" }>;

const NONE = "";

interface Pair {
  readonly column: string;
  readonly target: string;
}

function options(names: readonly string[]) {
  return [{ value: NONE, label: "Choose…" }, ...names.map((name) => ({ value: name, label: name }))];
}

/** The target's primary key fills the target columns in, when it has as many columns as there are pairs. */
function targetPairs(pairs: readonly Pair[], target: RelationshipTable | undefined): readonly Pair[] {
  const key = target?.primaryKey ?? [];
  const fill = key.length === pairs.length ? key : [];
  return pairs.map((pair, index) => ({ ...pair, target: fill[index] ?? NONE }));
}

/**
 * Add Relationship (plan 152 decision 7): a source table and a target table in the diagram's
 * namespace, then one row per column pair, so both sides always have as many columns. Answers
 * `relationshipAnswer`; the diagram saves it as a virtual key.
 */
export function RelationshipDialog({ request }: { readonly request: RelationshipRequest }) {
  const answer = useModal((state) => state.answer);
  const byName = new Map(request.tables.map((table) => [table.name, table]));
  const [from, setFrom] = useState(request.from ?? NONE);
  const [to, setTo] = useState(NONE);
  const [pairs, setPairs] = useState<readonly Pair[]>([{ column: NONE, target: NONE }]);
  const draft = {
    from,
    columns: pairs.map((pair) => pair.column),
    to,
    targetColumns: pairs.map((pair) => pair.target),
  };
  const problem = relationshipProblem(draft);
  const tableNames = request.tables.map((table) => table.name);
  const sourceColumns = byName.get(from)?.columns ?? [];
  const targetColumns = byName.get(to)?.columns ?? [];
  const setPair = (index: number, change: Partial<Pair>) =>
    setPairs((current) => current.map((pair, at) => (at === index ? { ...pair, ...change } : pair)));
  return (
    <form
      className="flex flex-col gap-gap p-gap"
      data-testid="relationship-dialog"
      onSubmit={(event) => {
        event.preventDefault();
        if (problem === null) answer(relationshipAnswer(draft));
      }}
    >
      <Dialog.Title className="font-semibold">{request.title}</Dialog.Title>
      <Dialog.Description className="text-ink-muted">
        A virtual key is drawn in the diagram only; the database is not changed.
      </Dialog.Description>
      <div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-x-gap gap-y-1">
        <span className="text-ink-muted">From table</span>
        <span />
        <span className="text-ink-muted">To table</span>
        <span />
        <Select
          label="From table"
          testId="relationship-from"
          value={from}
          options={options(tableNames)}
          onChange={(value) => {
            setFrom(value);
            setPairs((current) => current.map((pair) => ({ ...pair, column: NONE })));
          }}
        />
        <span aria-hidden>→</span>
        <Select
          label="To table"
          testId="relationship-to"
          value={to}
          options={options(tableNames)}
          onChange={(value) => {
            setTo(value);
            setPairs((current) => targetPairs(current, byName.get(value)));
          }}
        />
        <span />
        {pairs.map((pair, index) => (
          <PairRow
            key={index}
            index={index}
            pair={pair}
            sourceColumns={sourceColumns}
            targetColumns={targetColumns}
            removable={pairs.length > 1}
            onChange={(change) => setPair(index, change)}
            onRemove={() => setPairs((current) => current.filter((_pair, at) => at !== index))}
          />
        ))}
      </div>
      <div>
        <Button onClick={() => setPairs((current) => [...current, { column: NONE, target: NONE }])}>
          Add Column Pair
        </Button>
      </div>
      <p role="status" data-testid="relationship-problem" className="min-h-row text-ink-muted">
        {problem ?? ""}
      </p>
      <div className="flex justify-end gap-gap">
        <Button onClick={() => answer(null)}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={problem !== null}>
          Add Relationship
        </Button>
      </div>
    </form>
  );
}

function PairRow({
  index,
  pair,
  sourceColumns,
  targetColumns,
  removable,
  onChange,
  onRemove,
}: {
  readonly index: number;
  readonly pair: Pair;
  readonly sourceColumns: readonly string[];
  readonly targetColumns: readonly string[];
  readonly removable: boolean;
  readonly onChange: (change: Partial<Pair>) => void;
  readonly onRemove: () => void;
}) {
  const ordinal = String(index + 1);
  return (
    <>
      <Select
        label={`From column ${ordinal}`}
        testId={`relationship-column-${ordinal}`}
        value={pair.column}
        options={options(sourceColumns)}
        onChange={(column) => onChange({ column })}
      />
      <span aria-hidden>→</span>
      <Select
        label={`To column ${ordinal}`}
        testId={`relationship-target-${ordinal}`}
        value={pair.target}
        options={options(targetColumns)}
        onChange={(target) => onChange({ target })}
      />
      {removable ? (
        <button
          type="button"
          aria-label={`Remove column pair ${ordinal}`}
          title={`Remove column pair ${ordinal}`}
          className={ICON_BUTTON}
          onClick={onRemove}
        >
          <CloseIcon aria-hidden className="size-icon" />
        </button>
      ) : (
        <span />
      )}
    </>
  );
}
