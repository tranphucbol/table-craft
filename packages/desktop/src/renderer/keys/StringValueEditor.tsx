import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { KEY_ACTION_IDS } from "@table-craft/desktop/renderer/actions/keyActions.js";
import { ValuePanel } from "@table-craft/desktop/renderer/grid/ValuePanel.js";
import type { ValueFormat } from "@table-craft/desktop/renderer/model/valueFormats.js";
import type { KeyTab } from "@table-craft/desktop/renderer/state/keyTabs.js";

const VALUE_COLUMN = { name: "value", type: "string" } as const;

/** A string key's value, the whole tab wide, read in the remembered format (plan 058 decision 15). */
export function StringValueEditor({ tab, format }: { readonly tab: KeyTab; readonly format: ValueFormat }) {
  return (
    <div data-testid="string-value" className="flex min-h-0 flex-1 [&>aside]:w-full [&>aside]:border-l-0">
      <ValuePanel
        column={VALUE_COLUMN}
        value={tab.value ?? undefined}
        format={{ format, onChange: (next) => void invoke(KEY_ACTION_IDS.valueFormat, { format: next }) }}
      />
    </div>
  );
}
