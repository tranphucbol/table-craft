import { ICON_BUTTON } from "@table-craft/desktop/renderer/ui/iconButtonClasses.js";
import * as Dialog from "@radix-ui/react-dialog";
import { SEGMENT, SEGMENT_GROUP } from "@table-craft/desktop/renderer/ui/Segmented.js";
import { useState, type ReactNode } from "react";
import type { ForeignKeyDesign } from "@table-craft/desktop/engine/protocol.js";
import { ScriptView, useScriptPreview } from "@table-craft/desktop/renderer/dialogs/ObjectChange.js";
import { Button, FieldRow, Select, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import {
  addColumn,
  designProblem,
  listText,
  moveColumn,
  newForeignKey,
  newIndex,
  parseList,
  removeColumn,
  setColumn,
  setPrimaryKey,
} from "@table-craft/desktop/renderer/model/tableDesign.js";
import {
  OBJECT_CHOICES,
  objectAnswer,
  useModal,
  type ModalRequest,
} from "@table-craft/desktop/renderer/state/modal.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

type TableDesignRequest = Extract<ModalRequest, { kind: "tableDesign" }>;
type Tab = "columns" | "indexes" | "foreignKeys" | "checks";

const PREVIEW_DELAY_MS = 300;
const TYPES_LIST_ID = "table-design-types";
const NAME_FIELD_ID = "table-design-name";
const COMMENT_FIELD_ID = "table-design-comment";
/** The referential actions every built-in dialect writes; the default leaves the clause out. */
const ACTIONS = [
  { label: "No action", value: "" },
  { label: "Cascade", value: "CASCADE" },
  { label: "Set null", value: "SET NULL" },
  { label: "Restrict", value: "RESTRICT" },
];
const HEADER_CLASS = "text-ink-muted";

function TabButton({
  tab,
  current,
  label,
  onSelect,
}: {
  readonly tab: Tab;
  readonly current: Tab;
  readonly label: string;
  readonly onSelect: (tab: Tab) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={tab === current}
      data-testid={`design-tab-${tab}`}
      className={SEGMENT}
      onClick={() => onSelect(tab)}
    >
      {label}
    </button>
  );
}

function RowButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} className={ICON_BUTTON} onClick={onClick}>
      {children}
    </button>
  );
}

function Box({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      className="justify-self-center"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

/**
 * New Table and Modify Table (plan 024): the design in tabs, previewed as the plugin scripts it.
 * Apply and Open in Console wait for a preview of the design as it stands.
 */
export function TableDesigner({ request }: { readonly request: TableDesignRequest }) {
  const answer = useModal((state) => state.answer);
  const [design, setDesign] = useState(request.initial);
  const [tab, setTab] = useState<Tab>("columns");
  const { features } = request;
  const problem = designProblem(design);
  const shown = useScriptPreview(problem === null ? design : null, request.preview, PREVIEW_DELAY_MS);
  const current = shown?.key === design ? shown : null;
  const script = current?.script ?? null;
  const ready = script !== null && script.statements.length > 0;
  const choose = (choice: (typeof OBJECT_CHOICES)[keyof typeof OBJECT_CHOICES]) => {
    if (script !== null) answer(objectAnswer({ choice, script, design, cascade: false }));
  };
  const setForeignKey = (index: number, patch: Partial<ForeignKeyDesign>) =>
    setDesign({
      ...design,
      foreignKeys: design.foreignKeys.map((key, at) => (at === index ? { ...key, ...patch } : key)),
    });
  const columnGrid = features.comments
    ? "grid-cols-[1fr_1fr_max-content_1fr_max-content_max-content_1fr_max-content]"
    : "grid-cols-[1fr_1fr_max-content_1fr_max-content_max-content_max-content]";

  return (
    <form
      className="flex h-dialog-height flex-col gap-gap p-gap"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) choose(OBJECT_CHOICES.apply);
      }}
    >
      <Dialog.Title className="font-semibold">{request.title}</Dialog.Title>
      <p className="text-ink-muted">{request.note}</p>
      <div className="grid grid-cols-[max-content_1fr] gap-x-gap gap-y-cell">
        <FieldRow label="Name" htmlFor={NAME_FIELD_ID}>
          <TextInput
            id={NAME_FIELD_ID}
            data-testid="design-name"
            autoFocus
            className="flex-1"
            value={design.name}
            onChange={(event) => setDesign({ ...design, name: event.target.value })}
          />
        </FieldRow>
        {features.comments ? (
          <FieldRow label="Comment" htmlFor={COMMENT_FIELD_ID}>
            <TextInput
              id={COMMENT_FIELD_ID}
              className="flex-1"
              value={design.comment ?? ""}
              onChange={(event) =>
                setDesign({ ...design, comment: event.target.value === "" ? null : event.target.value })
              }
            />
          </FieldRow>
        ) : null}
      </div>
      <div role="tablist" aria-label="Design" className={SEGMENT_GROUP}>
        <TabButton tab="columns" current={tab} label={`Columns (${String(design.columns.length)})`} onSelect={setTab} />
        <TabButton tab="indexes" current={tab} label={`Indexes (${String(design.indexes.length)})`} onSelect={setTab} />
        <TabButton
          tab="foreignKeys"
          current={tab}
          label={`Foreign Keys (${String(design.foreignKeys.length)})`}
          onSelect={setTab}
        />
        {features.checks ? (
          <TabButton tab="checks" current={tab} label={`Checks (${String(design.checks.length)})`} onSelect={setTab} />
        ) : null}
      </div>
      <datalist id={TYPES_LIST_ID}>
        {features.types.map((type) => (
          <option key={type} value={type} />
        ))}
      </datalist>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-auto">
        {tab === "columns" ? (
          <div data-testid="design-columns" className={cn("grid items-center gap-x-gap gap-y-cell", columnGrid)}>
            <span className={HEADER_CLASS}>Name</span>
            <span className={HEADER_CLASS}>Type</span>
            <span className={HEADER_CLASS}>Not null</span>
            <span className={HEADER_CLASS}>Default</span>
            <span className={HEADER_CLASS}>Key</span>
            <span className={HEADER_CLASS}>Auto</span>
            {features.comments ? <span className={HEADER_CLASS}>Comment</span> : null}
            <span />
            {design.columns.map((column, index) => {
              const label = column.name === "" ? `column ${String(index + 1)}` : column.name;
              return (
                <div key={index} className="contents">
                  <TextInput
                    aria-label={`Name of ${label}`}
                    value={column.name}
                    onChange={(event) => setDesign(setColumn(design, index, { name: event.target.value }))}
                  />
                  <TextInput
                    aria-label={`Type of ${label}`}
                    list={TYPES_LIST_ID}
                    value={column.type}
                    onChange={(event) => setDesign(setColumn(design, index, { type: event.target.value }))}
                  />
                  <Box
                    label={`${label} is not null`}
                    checked={!column.nullable}
                    onChange={(checked) => setDesign(setColumn(design, index, { nullable: !checked }))}
                  />
                  <TextInput
                    aria-label={`Default of ${label}`}
                    placeholder="none"
                    value={column.default ?? ""}
                    onChange={(event) =>
                      setDesign(
                        setColumn(design, index, { default: event.target.value === "" ? null : event.target.value }),
                      )
                    }
                  />
                  <Box
                    label={`${label} is in the primary key`}
                    checked={design.primaryKey.includes(column.name)}
                    onChange={(checked) => setDesign(setPrimaryKey(design, column.name, checked))}
                  />
                  <Box
                    label={`${label} is generated`}
                    checked={column.autoIncrement}
                    onChange={(checked) => setDesign(setColumn(design, index, { autoIncrement: checked }))}
                  />
                  {features.comments ? (
                    <TextInput
                      aria-label={`Comment of ${label}`}
                      value={column.comment ?? ""}
                      onChange={(event) =>
                        setDesign(
                          setColumn(design, index, { comment: event.target.value === "" ? null : event.target.value }),
                        )
                      }
                    />
                  ) : null}
                  <div className="flex">
                    <RowButton label={`Move ${label} up`} onClick={() => setDesign(moveColumn(design, index, -1))}>
                      ↑
                    </RowButton>
                    <RowButton label={`Move ${label} down`} onClick={() => setDesign(moveColumn(design, index, 1))}>
                      ↓
                    </RowButton>
                    <RowButton label={`Remove ${label}`} onClick={() => setDesign(removeColumn(design, index))}>
                      ×
                    </RowButton>
                  </div>
                </div>
              );
            })}
            <Button
              className="col-start-1 justify-self-start"
              onClick={() => setDesign(addColumn(design, features.types[0] ?? ""))}
            >
              Add Column
            </Button>
          </div>
        ) : tab === "indexes" ? (
          <div
            data-testid="design-indexes"
            className="grid grid-cols-[1fr_2fr_max-content_max-content] items-center gap-x-gap gap-y-cell"
          >
            <span className={HEADER_CLASS}>Name</span>
            <span className={HEADER_CLASS}>Columns</span>
            <span className={HEADER_CLASS}>Unique</span>
            <span />
            {design.indexes.map((entry, index) => {
              const update = (patch: Partial<typeof entry>) =>
                setDesign({
                  ...design,
                  indexes: design.indexes.map((other, at) => (at === index ? { ...other, ...patch } : other)),
                });
              return (
                <div key={index} className="contents">
                  <TextInput
                    aria-label={`Name of index ${String(index + 1)}`}
                    value={entry.name}
                    onChange={(event) => update({ name: event.target.value })}
                  />
                  <ListInput
                    label={`Columns of index ${String(index + 1)}`}
                    columns={entry.columns}
                    onChange={(columns) => update({ columns })}
                  />
                  <Box
                    label={`Index ${String(index + 1)} is unique`}
                    checked={entry.unique}
                    onChange={(unique) => update({ unique })}
                  />
                  <RowButton
                    label={`Remove index ${String(index + 1)}`}
                    onClick={() =>
                      setDesign({ ...design, indexes: design.indexes.filter((_entry, at) => at !== index) })
                    }
                  >
                    ×
                  </RowButton>
                </div>
              );
            })}
            <Button
              className="col-start-1 justify-self-start"
              onClick={() => setDesign({ ...design, indexes: [...design.indexes, newIndex(design)] })}
            >
              Add Index
            </Button>
          </div>
        ) : tab === "foreignKeys" ? (
          <div
            data-testid="design-foreign-keys"
            className="grid grid-cols-[1fr_1fr_1fr_1fr_max-content_max-content_max-content] items-center gap-x-gap gap-y-cell"
          >
            <span className={HEADER_CLASS}>Name</span>
            <span className={HEADER_CLASS}>Columns</span>
            <span className={HEADER_CLASS}>References</span>
            <span className={HEADER_CLASS}>Target columns</span>
            <span className={HEADER_CLASS}>On delete</span>
            <span className={HEADER_CLASS}>On update</span>
            <span />
            {design.foreignKeys.map((key, index) => {
              const number = String(index + 1);
              const target = request.targets.find((candidate) => candidate.name === key.target.relation);
              return (
                <div key={index} className="contents">
                  <TextInput
                    aria-label={`Name of foreign key ${number}`}
                    value={key.name}
                    onChange={(event) => setForeignKey(index, { name: event.target.value })}
                  />
                  <ListInput
                    label={`Columns of foreign key ${number}`}
                    columns={key.columns}
                    onChange={(columns) => setForeignKey(index, { columns })}
                  />
                  <Select
                    label={`Table foreign key ${number} references`}
                    value={key.target.relation}
                    options={[
                      { label: "Choose a table", value: "" },
                      ...request.targets.map((candidate) => ({ label: candidate.name, value: candidate.name })),
                    ]}
                    onChange={(relation) => {
                      const chosen = request.targets.find((candidate) => candidate.name === relation);
                      setForeignKey(index, {
                        target: {
                          path: request.path,
                          relation,
                          columns: chosen?.columns.slice(0, Math.max(key.columns.length, 1)) ?? [],
                        },
                      });
                    }}
                  />
                  <ListInput
                    label={`Target columns of foreign key ${number}`}
                    columns={key.target.columns}
                    placeholder={target === undefined ? undefined : listText(target.columns)}
                    onChange={(columns) => setForeignKey(index, { target: { ...key.target, columns } })}
                  />
                  <Select
                    label={`On delete of foreign key ${number}`}
                    value={key.onDelete ?? ""}
                    options={ACTIONS}
                    onChange={(value) => setForeignKey(index, { onDelete: value === "" ? null : value })}
                  />
                  <Select
                    label={`On update of foreign key ${number}`}
                    value={key.onUpdate ?? ""}
                    options={ACTIONS}
                    onChange={(value) => setForeignKey(index, { onUpdate: value === "" ? null : value })}
                  />
                  <RowButton
                    label={`Remove foreign key ${number}`}
                    onClick={() =>
                      setDesign({ ...design, foreignKeys: design.foreignKeys.filter((_key, at) => at !== index) })
                    }
                  >
                    ×
                  </RowButton>
                </div>
              );
            })}
            <Button
              className="col-start-1 justify-self-start"
              onClick={() =>
                setDesign({ ...design, foreignKeys: [...design.foreignKeys, newForeignKey(design, request.path)] })
              }
            >
              Add Foreign Key
            </Button>
          </div>
        ) : (
          <div
            data-testid="design-checks"
            className="grid grid-cols-[1fr_3fr_max-content] items-center gap-x-gap gap-y-cell"
          >
            <span className={HEADER_CLASS}>Name</span>
            <span className={HEADER_CLASS}>Expression</span>
            <span />
            {design.checks.map((check, index) => {
              const number = String(index + 1);
              const update = (patch: Partial<typeof check>) =>
                setDesign({
                  ...design,
                  checks: design.checks.map((other, at) => (at === index ? { ...other, ...patch } : other)),
                });
              return (
                <div key={index} className="contents">
                  <TextInput
                    aria-label={`Name of check ${number}`}
                    value={check.name}
                    onChange={(event) => update({ name: event.target.value })}
                  />
                  <TextInput
                    aria-label={`Expression of check ${number}`}
                    className="font-editor"
                    value={check.expression}
                    onChange={(event) => update({ expression: event.target.value })}
                  />
                  <RowButton
                    label={`Remove check ${number}`}
                    onClick={() => setDesign({ ...design, checks: design.checks.filter((_check, at) => at !== index) })}
                  >
                    ×
                  </RowButton>
                </div>
              );
            })}
            <Button
              className="col-start-1 justify-self-start"
              onClick={() =>
                setDesign({
                  ...design,
                  checks: [
                    ...design.checks,
                    { name: `${design.name}_check${String(design.checks.length + 1)}`, expression: "", original: null },
                  ],
                })
              }
            >
              Add Check
            </Button>
          </div>
        )}
      </div>
      {problem === null ? null : (
        <p data-testid="design-problem" className="text-danger">
          {problem}
        </p>
      )}
      <ScriptView
        script={problem === null ? script : null}
        error={problem === null ? (current?.error ?? null) : null}
        highlight={request.highlight}
        className="h-40 shrink-0 rounded border border-line bg-canvas"
      />
      <div className="flex justify-end gap-gap">
        <Button onClick={() => answer(null)}>Cancel</Button>
        <Button disabled={!ready} onClick={() => choose(OBJECT_CHOICES.console)}>
          Open in Console
        </Button>
        <Button type="submit" variant="primary" disabled={!ready}>
          Apply
        </Button>
      </div>
    </form>
  );
}

/**
 * A comma-separated column list. The text is kept as typed while the field has it, so a trailing
 * comma survives until the next name is typed.
 */
function ListInput({
  label,
  columns,
  placeholder,
  onChange,
}: {
  readonly label: string;
  readonly columns: readonly string[];
  readonly placeholder?: string;
  readonly onChange: (columns: readonly string[]) => void;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  return (
    <TextInput
      aria-label={label}
      placeholder={placeholder}
      value={typed ?? listText(columns)}
      onFocus={() => setTyped(listText(columns))}
      onBlur={() => setTyped(null)}
      onChange={(event) => {
        setTyped(event.target.value);
        onChange(parseList(event.target.value));
      }}
    />
  );
}
