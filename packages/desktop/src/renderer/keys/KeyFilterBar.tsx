import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { KEY_ACTION_IDS } from "@table-craft/desktop/renderer/actions/keyActions.js";
import {
  rangeFields,
  useKeyTabs,
  type KeyRangeDraft,
  type KeyTab,
} from "@table-craft/desktop/renderer/state/keyTabs.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

const INPUT_CLASS = "h-row min-w-0 flex-1 rounded border bg-canvas px-cell font-grid text-ink outline-none";

function Field({
  tabId,
  label,
  name,
  value,
  placeholder,
  invalid,
}: {
  readonly tabId: string;
  readonly label: string;
  readonly name: keyof KeyRangeDraft;
  readonly value: string;
  readonly placeholder: string;
  readonly invalid: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-1 items-center gap-cell text-ink-muted">
      <span className="shrink-0">{label}</span>
      <input
        aria-label={label}
        data-testid={`key-range-${name}`}
        spellCheck={false}
        className={cn(INPUT_CLASS, invalid ? "border-danger" : "border-line focus:border-accent")}
        value={value}
        placeholder={placeholder}
        onChange={(event) => useKeyTabs.getState().setDraft(tabId, { [name]: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void invoke(KEY_ACTION_IDS.reload);
          } else if (event.key === "Escape") {
            useKeyTabs.getState().revertDraft(tabId);
          }
        }}
      />
    </label>
  );
}

/** Match for hashes, sets and sorted sets; From and To ids for streams (plan 058 decision 14). */
export function KeyFilterBar({ tabId, tab }: { readonly tabId: string; readonly tab: KeyTab }) {
  const fields = rangeFields(tab.details?.type ?? null);
  if (fields === null) return null;
  const invalid = tab.queryError !== null;
  return (
    <div
      data-testid="key-filter-bar"
      className="flex shrink-0 items-center gap-gap border-b border-line bg-panel p-gap"
    >
      {fields === "match" ? (
        <Field
          tabId={tabId}
          label="Match"
          name="match"
          value={tab.draft.match}
          placeholder="e.g. name*"
          invalid={invalid}
        />
      ) : (
        <>
          <Field tabId={tabId} label="From" name="from" value={tab.draft.from} placeholder="-" invalid={invalid} />
          <Field tabId={tabId} label="To" name="to" value={tab.draft.to} placeholder="+" invalid={invalid} />
        </>
      )}
    </div>
  );
}
