import type { ReactNode } from "react";
import { buttonClass } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { FIELD_CLASS } from "@table-craft/desktop/renderer/ui/fieldClasses.js";
import { PRESSED_TOGGLE } from "@table-craft/desktop/renderer/ui/pressClasses.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { ADMIN_ACTION_IDS, type AdminCommand } from "./actions.js";

export const INPUT = FIELD_CLASS;
export const BUTTON = cn(buttonClass(), PRESSED_TOGGLE);
export const CELL = "border-b border-line px-gap py-cell text-left whitespace-nowrap";
export function CommandButton({
  source,
  command,
  children,
  reason,
  pressed,
}: {
  readonly source: string;
  readonly command: AdminCommand;
  readonly children: ReactNode;
  readonly reason?: string | null;
  readonly pressed?: boolean;
}) {
  return (
    <button
      type="button"
      className={BUTTON}
      disabled={reason != null}
      title={reason ?? undefined}
      aria-pressed={pressed}
      onClick={() => invoke(ADMIN_ACTION_IDS.command, { datasourceId: source, command })}
    >
      {children}
    </button>
  );
}
export function Fact({ name, value }: { readonly name: string; readonly value: ReactNode }) {
  return (
    <div className="flex justify-between gap-gap py-cell">
      <span className="text-ink-muted">{name}</span>
      <span className="select-text font-grid tabular-nums">{value ?? "Unknown"}</span>
    </div>
  );
}
