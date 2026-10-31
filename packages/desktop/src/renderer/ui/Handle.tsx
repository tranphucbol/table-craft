import { Separator } from "react-resizable-panels";
import { useIslands } from "@table-craft/desktop/renderer/state/settings.js";
import { cn } from "./cn.js";

const AXIS_CLASS = {
  horizontal: "h-px cursor-row-resize",
  vertical: "w-px cursor-col-resize",
} as const;

const GUTTER_AXIS_CLASS = {
  horizontal: "h-island-gap cursor-row-resize",
  vertical: "w-island-gap cursor-col-resize",
} as const;

/** `react-resizable-panels` widens the grab area itself and reports it in `data-separator`. */
const PAINT_CLASS =
  "relative z-10 shrink-0 bg-line data-[separator=active]:bg-accent data-[separator=hover]:bg-ink-muted";

/** Between islands the handle is the frame itself, marked only while it is under the pointer (decision 141). */
const GUTTER_PAINT_CLASS =
  "relative z-10 shrink-0 bg-transparent data-[separator=active]:bg-accent data-[separator=hover]:bg-line";

export interface HandleProps {
  /** `horizontal` for a boundary dragged up and down, `vertical` for one dragged left and right. */
  readonly axis: keyof typeof AXIS_CLASS;
  readonly label?: string;
  /** Between two of the shell's panels, which become the frame's gap in islands. */
  readonly gutter?: boolean;
}

export function Handle({ axis, label, gutter = false }: HandleProps) {
  const islands = useIslands();
  const asGap = gutter && islands;
  return (
    <Separator
      aria-label={label}
      className={asGap ? cn(GUTTER_PAINT_CLASS, GUTTER_AXIS_CLASS[axis]) : cn(PAINT_CLASS, AXIS_CLASS[axis])}
    />
  );
}
