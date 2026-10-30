import { useState, type KeyboardEvent } from "react";
import { KEY_TYPES, type KeyType } from "@table-craft/desktop/engine/protocol.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { KEY_ACTION_IDS, type KeyFilterArgs } from "@table-craft/desktop/renderer/actions/keyActions.js";
import { Select, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { NO_KEY_FILTER, type KeyFilter, type KeyFilterNode } from "@table-craft/desktop/renderer/model/keyTree.js";
import { capabilitiesOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { KeyFilterIcon } from "@table-craft/desktop/renderer/ui/icons.js";

const ALL_TYPES = "";
const TYPE_OPTIONS = [
  { value: ALL_TYPES, label: "All types" },
  ...KEY_TYPES.filter((type) => type !== "other").map((type) => ({ value: type, label: type })),
];

/**
 * A native select is as wide as its longest option ("Name contains (loaded keys)"); capped, it
 * shrinks with the pane and leaves the text field the room, so the row never outgrows the pane.
 */
const SELECT_SLOT_CLASS = "flex max-w-2/5 min-w-0 shrink [&>select]:w-full [&>select]:min-w-0";

/**
 * A database's filter row (decision 113): a server-side `MATCH` glob, rescanned on Enter, and a
 * type, rescanned on change. Its keys stay its own, so the tree's arrows and speed search do not
 * take them. Keyed by the applied pattern, so a filter set elsewhere resets the field. Focus
 * selects the row: with focus in the tree, actions act on the tree's selection. A keyspace that
 * lists children server-side gets a byte prefix or range instead, a name search over loaded keys
 * only (never a server-wide scan), and Leased only when the plugin declares `leases`.
 */
export function KeyFilterRow({ node, onFocus }: { readonly node: KeyFilterNode; readonly onFocus: () => void }) {
  const shown = node.filter.mode === undefined && node.filter.match === NO_KEY_FILTER.match ? "" : node.filter.match;
  const [match, setMatch] = useState(shown);
  const [end, setEnd] = useState(node.filter.end ?? "");
  const [mode, setMode] = useState<KeyFilter["mode"]>(node.filter.mode ?? "prefix");
  const leases = useDatasources((state) => {
    const datasource = state.datasources.find((candidate) => candidate.id === node.datasourceId);
    return datasource !== undefined && capabilitiesOf(state.plugins, datasource.pluginId).includes("leases");
  });

  function apply(type: KeyType | null, pattern: string, extra: Partial<KeyFilter> = {}): void {
    const args: KeyFilterArgs = {
      datasourceId: node.datasourceId,
      database: node.database,
      filter: {
        ...node.filter,
        match: pattern,
        type,
        ...(node.serverChildren === true ? { mode, end } : {}),
        ...extra,
      },
    };
    void invoke(KEY_ACTION_IDS.filter, args);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    event.stopPropagation();
    if (event.key === "Enter") apply(node.filter.type, match);
    else if (event.key === "Escape") {
      setMatch(shown);
      event.currentTarget.blur();
    }
  }

  return (
    <span
      className="flex min-w-0 flex-1 items-center gap-cell"
      onMouseDown={(event) => event.stopPropagation()}
      onFocus={onFocus}
    >
      <KeyFilterIcon aria-hidden className="size-icon shrink-0 text-ink-muted" />
      {node.serverChildren === true ? (
        <span className="flex w-[9ch] shrink-0 [&>select]:w-full" onKeyDown={(event) => event.stopPropagation()}>
          <Select
            label="Key filter mode"
            value={mode ?? "prefix"}
            options={[
              { value: "prefix", label: "Prefix" },
              { value: "range", label: "Range" },
              { value: "loadedName", label: "Name contains (loaded keys)" },
            ]}
            onChange={(value) => {
              const next = value as NonNullable<KeyFilter["mode"]>;
              setMode(next);
              if (next !== "range" || end !== "") apply(null, match, { mode: next });
            }}
          />
        </span>
      ) : null}
      <TextInput
        aria-label="Filter keys"
        data-testid="key-filter"
        placeholder={
          node.serverChildren === true
            ? mode === "range"
              ? "From (inclusive)"
              : mode === "loadedName"
                ? "Search loaded keys only"
                : "Key prefix"
            : "Filter: MATCH pattern"
        }
        className="min-w-0 flex-1"
        value={match}
        onChange={(event) => setMatch(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {node.serverChildren === true && mode === "range" ? (
        <TextInput
          aria-label="Range end (exclusive)"
          placeholder="To (exclusive)"
          className="min-w-0 flex-1"
          value={end}
          onChange={(event) => setEnd(event.target.value)}
          onKeyDown={onKeyDown}
        />
      ) : null}
      {node.serverChildren === true ? (
        leases ? (
          <label
            className="flex shrink-0 items-center gap-cell text-ink-muted"
            title="Filters loaded key metadata only; folders remain available for browsing"
            onKeyDown={(event) => event.stopPropagation()}
          >
            <input
              type="checkbox"
              aria-label="Leased keys only"
              checked={node.filter.leasedOnly === true}
              onChange={(event) => apply(null, match, { leasedOnly: event.target.checked })}
            />
            Leased only
          </label>
        ) : null
      ) : (
        <span className={SELECT_SLOT_CLASS} onKeyDown={(event) => event.stopPropagation()}>
          <Select
            label="Key type"
            testId="key-type-filter"
            value={node.filter.type ?? ALL_TYPES}
            options={TYPE_OPTIONS}
            onChange={(value) => apply(value === ALL_TYPES ? null : (value as KeyType), match)}
          />
        </span>
      )}
    </span>
  );
}
