import { useId } from "react";
import { INSPECTION_IDS } from "@table-craft/desktop/engine/protocol.js";
import { currentPlatform, formatChord } from "@table-craft/desktop/renderer/actions/chords.js";
import { ERROR_ACTION_IDS } from "@table-craft/desktop/renderer/actions/errorActions.js";
import { registry } from "@table-craft/desktop/renderer/actions/index.js";
import { FieldRow } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { INSPECTION_NAMES } from "@table-craft/desktop/renderer/model/inspectionNames.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { withInspection, type Settings } from "@table-craft/desktop/settings/settings.js";

function update(patch: (current: Settings) => Settings): void {
  void useSettings.getState().update(patch);
}

function chordText(actionId: string): string {
  const shortcut = registry.get(actionId)?.shortcut;
  return shortcut === undefined ? "" : formatChord(shortcut, currentPlatform());
}

/** Settings → Editor → Inspections (plan 108 decision 6): the master switch, then one box per inspection. */
export function InspectionFields() {
  const inspections = useSettings((state) => state.settings.editor.inspections);
  const id = useId();
  return (
    <>
      <FieldRow label="Inspections" htmlFor={id}>
        <label className="flex items-center gap-cell">
          <input
            id={id}
            type="checkbox"
            checked={inspections.enabled}
            onChange={(event) => {
              const enabled = event.target.checked;
              update((current) => ({
                ...current,
                editor: { ...current.editor, inspections: { ...current.editor.inspections, enabled } },
              }));
            }}
          />
          Check SQL as you type
        </label>
      </FieldRow>
      <fieldset
        aria-label="Inspections to run"
        disabled={!inspections.enabled}
        className={cn("col-start-2 flex flex-col", !inspections.enabled && "opacity-60")}
      >
        {INSPECTION_IDS.map((inspection) => (
          <label key={inspection} className="flex h-row items-center gap-cell">
            <input
              type="checkbox"
              checked={!inspections.disabled.includes(inspection)}
              onChange={(event) => {
                const enabled = event.target.checked;
                update((current) => withInspection(current, inspection, enabled));
              }}
            />
            {INSPECTION_NAMES[inspection]}
            <span className="truncate font-editor text-ink-muted">{inspection}</span>
          </label>
        ))}
      </fieldset>
      <p className="col-start-2 text-ink-muted">
        {chordText(ERROR_ACTION_IDS.showIntentions)} on a marked problem offers its fixes. A{" "}
        <code className="font-editor">-- noinspection Id</code> line above a statement silences that check for it.
      </p>
    </>
  );
}
