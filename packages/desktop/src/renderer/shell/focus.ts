import { REGION_ATTRIBUTE, type FocusRegion } from "@table-craft/desktop/renderer/actions/context.js";

/** Marks the control a region focuses first, e.g. the console's editor. */
export const AUTOFOCUS_ATTRIBUTE = "data-region-focus";

const FOCUSABLE = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

export function focusActivatedEditor(
  container: HTMLElement,
  activeId: string | null,
  groupActiveId: string | null,
): void {
  if (activeId === null || activeId !== groupActiveId || container.contains(document.activeElement)) return;
  container.querySelector<HTMLElement>(`[${AUTOFOCUS_ATTRIBUTE}]`)?.focus();
}

/** Moves focus into a region: its marked control, else its first focusable, else the region itself. */
export function focusRegion(region: Exclude<FocusRegion, "other">): void {
  const container =
    region === "editor"
      ? (document.querySelector<HTMLElement>('[data-testid="editor-group"][data-focused="true"]') ??
        document.querySelector<HTMLElement>(`[${REGION_ATTRIBUTE}="${region}"]`))
      : document.querySelector<HTMLElement>(`[${REGION_ATTRIBUTE}="${region}"]`);
  if (container === null) return;
  const target =
    container.querySelector<HTMLElement>(`[${AUTOFOCUS_ATTRIBUTE}]`) ??
    container.querySelector<HTMLElement>(FOCUSABLE) ??
    container;
  target.focus();
}
