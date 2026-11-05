import { DIAGRAM_ACTION_IDS } from "@table-craft/desktop/renderer/actions/diagramActions.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import type { HiddenKey, MissingKey } from "@table-craft/desktop/renderer/model/diagram.js";
import { Popover, type PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";
import {
  POPOVER_BODY,
  POPOVER_FOOTER,
  POPOVER_HEADER,
  POPOVER_PANEL,
} from "@table-craft/desktop/renderer/ui/popoverParts.js";
import { TEXT_PRESS } from "@table-craft/desktop/renderer/ui/pressClasses.js";

const ROW_BUTTON = `${TEXT_PRESS} h-row shrink-0 rounded border border-line px-gap text-ink hover:bg-hover`;

function missingLabel({ key }: MissingKey): string {
  const ends = (relation: string, columns: readonly string[]) =>
    columns.map((column) => `${relation}.${column}`).join(", ");
  return `${ends(key.relation, key.columns)} → ${ends(key.target.relation, key.target.columns)}`;
}

/**
 * The toolbar's Hidden Keys (plan 152 decision 7): the inferred keys hidden in this namespace, each
 * with Restore, and the virtual keys whose table or columns the schema no longer has, kept until deleted.
 */
export function HiddenKeys({
  hidden,
  missing,
  anchor,
  onClose,
}: {
  readonly hidden: readonly HiddenKey[];
  readonly missing: readonly MissingKey[];
  readonly anchor: PopoverAnchor;
  readonly onClose: () => void;
}) {
  return (
    <Popover anchor={anchor} label="Hidden keys" testId="diagram-hidden-keys" onClose={onClose}>
      <div className={POPOVER_PANEL}>
        <div className={POPOVER_HEADER}>
          <span>Hidden Keys</span>
          <span className="ml-auto font-normal text-ink-muted">{hidden.length}</span>
        </div>
        <div className={POPOVER_BODY}>
          {hidden.length === 0 && missing.length === 0 ? (
            <p className="text-ink-muted">No inferred key is hidden.</p>
          ) : null}
          {hidden.length === 0 ? null : (
            <ul aria-label="Hidden inferred keys" className="flex max-h-picker-list flex-col gap-1 overflow-y-auto">
              {hidden.map((key) => (
                <li key={key.id} data-testid="diagram-hidden-key" className="flex min-w-0 items-center gap-gap">
                  <span className="min-w-0 flex-1 truncate font-grid text-grid" title={key.label}>
                    {key.label}
                  </span>
                  <button
                    type="button"
                    className={ROW_BUTTON}
                    onClick={() => invoke(DIAGRAM_ACTION_IDS.restoreKeys, { keys: [key.id] })}
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
          {missing.length === 0 ? null : (
            <>
              <span className="font-semibold text-ink-muted">Missing virtual keys</span>
              <ul aria-label="Missing virtual keys" className="flex flex-col gap-1">
                {missing.map((entry) => (
                  <li
                    key={entry.key.id}
                    data-testid="diagram-missing-key"
                    className="flex min-w-0 items-center gap-gap"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-grid text-grid" title={missingLabel(entry)}>
                        {missingLabel(entry)}
                      </span>
                      <span className="truncate text-ink-muted">missing: {entry.reason}</span>
                    </span>
                    <button
                      type="button"
                      className={ROW_BUTTON}
                      onClick={() => invoke(DIAGRAM_ACTION_IDS.deleteRelationship, { key: entry.key.id })}
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        {hidden.length < 2 ? null : (
          <div className={POPOVER_FOOTER}>
            <button type="button" className={ROW_BUTTON} onClick={() => invoke(DIAGRAM_ACTION_IDS.restoreKeys)}>
              Restore All
            </button>
          </div>
        )}
      </div>
    </Popover>
  );
}
