import { useState, type KeyboardEvent } from "react";
import { KEY_TYPES, type KeyType } from "@table-craft/desktop/engine/protocol.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { KEY_ACTION_IDS, type KeyFilterArgs } from "@table-craft/desktop/renderer/actions/keyActions.js";
import { Select, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { NO_KEY_FILTER, type KeyFilterNode } from "@table-craft/desktop/renderer/model/keyTree.js";
import { KeyFilterIcon } from "@table-craft/desktop/renderer/ui/icons.js";

const ALL_TYPES = "";
const TYPE_OPTIONS = [
  { value: ALL_TYPES, label: "All types" },
  ...KEY_TYPES.filter((type) => type !== "other").map((type) => ({ value: type, label: type })),
];

/**
 * A database's filter row (decision 113): a server-side `MATCH` glob, rescanned on Enter, and a
 * type, rescanned on change. Its keys stay its own, so the tree's arrows and speed search do not
 * take them. Keyed by the applied pattern, so a filter set elsewhere resets the field.
 */
export function KeyFilterRow({ node }: { readonly node: KeyFilterNode }) {
  const shown = node.filter.match === NO_KEY_FILTER.match ? "" : node.filter.match;
  const [match, setMatch] = useState(shown);

  function apply(type: KeyType | null, pattern: string): void {
    const args: KeyFilterArgs = {
      datasourceId: node.datasourceId,
      database: node.database,
      filter: { match: pattern, type },
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
    <span className="flex min-w-0 flex-1 items-center gap-cell" onMouseDown={(event) => event.stopPropagation()}>
      <KeyFilterIcon aria-hidden className="size-icon shrink-0 text-ink-muted" />
      <TextInput
        aria-label="Filter keys"
        data-testid="key-filter"
        placeholder="Filter: MATCH pattern"
        className="min-w-0 flex-1"
        value={match}
        onChange={(event) => setMatch(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <span onKeyDown={(event) => event.stopPropagation()}>
        <Select
          label="Key type"
          testId="key-type-filter"
          value={node.filter.type ?? ALL_TYPES}
          options={TYPE_OPTIONS}
          onChange={(value) => apply(value === ALL_TYPES ? null : (value as KeyType), match)}
        />
      </span>
    </span>
  );
}
