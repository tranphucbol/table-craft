import { useMemo } from "react";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { KEY_ACTION_IDS } from "@table-craft/desktop/renderer/actions/keyActions.js";
import { ValuePanel, type ValueTextEdit } from "@table-craft/desktop/renderer/grid/ValuePanel.js";
import {
  encodeValue,
  hexOf,
  keyBytesOf,
  valueBytes,
  type ValueFormat,
} from "@table-craft/desktop/renderer/model/valueFormats.js";
import { useKeyTabs, type KeyTab } from "@table-craft/desktop/renderer/state/keyTabs.js";

const VALUE_COLUMN = { name: "value", type: "string" } as const;

/**
 * A string key's value, the whole tab wide, read in the remembered format (plan 058 decision 15);
 * editable when the tab is and the format turns back into bytes.
 */
export function StringValueEditor({
  tab,
  tabId,
  format,
  editable,
}: {
  readonly tab: KeyTab;
  readonly tabId: string;
  readonly format: ValueFormat;
  readonly editable: boolean;
}) {
  const read = tab.value;
  const shown = useMemo(() => {
    if (tab.stringValue === null) return read ?? undefined;
    return tab.stringValue.hex === null
      ? tab.stringValue.text
      : { kind: "bytes" as const, preview: tab.stringValue.hex, length: tab.stringValue.hex.length / 2 };
  }, [read, tab.stringValue]);
  const edit: ValueTextEdit | undefined = editable
    ? {
        revision: `${String(tab.readAt)}:${String(tab.editorGeneration ?? 0)}`,
        problem: tab.stringProblem ?? null,
        onChange: (text, concrete) => {
          const encoded = encodeValue(text, concrete);
          if (!encoded.ok) {
            useKeyTabs.getState().setStringProblem(tabId, encoded.error);
            return;
          }
          const before = valueBytes(read ?? undefined);
          const same = before !== null && hexOf(before) === hexOf(encoded.bytes);
          useKeyTabs.getState().setStringValue(tabId, same ? null : keyBytesOf(encoded.bytes));
        },
      }
    : undefined;
  return (
    <div data-testid="string-value" className="flex min-h-0 flex-1 [&>aside]:w-full [&>aside]:border-l-0">
      <ValuePanel
        column={VALUE_COLUMN}
        value={shown}
        format={{ format, onChange: (next) => void invoke(KEY_ACTION_IDS.valueFormat, { format: next }) }}
        edit={edit}
      />
    </div>
  );
}
