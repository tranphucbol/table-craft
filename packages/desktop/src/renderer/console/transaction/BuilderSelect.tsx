import type { SelectHTMLAttributes } from "react";
import { DropdownIcon } from "@table-craft/desktop/renderer/ui/icons.js";

export const BUILDER_FIELD =
  "h-row min-w-0 rounded border border-line bg-canvas px-cell text-ink outline-none focus:border-accent disabled:opacity-50";

export function BuilderSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative inline-flex max-w-full shrink-0 align-middle">
      <select
        {...props}
        className={`${BUILDER_FIELD} w-full appearance-none pr-[calc(var(--tc-icon)+var(--tc-cell-padding)*2)]`}
      />
      <DropdownIcon
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-cell size-icon -translate-y-1/2 text-ink-muted"
      />
    </span>
  );
}
