import { Separator } from "react-resizable-panels";
import { useIslands } from "@table-craft/desktop/renderer/state/settings.js";
import { cn } from "./cn.js";

const AXIS_CLASS = {
  horizontal: "h-px cursor-row-resize",
  vertical: "w-px cursor-col-resize",
} as const;

/** The mark is a 2px bar centred in the gap: the whole gap lit up outshouts the islands it splits. */
const GUTTER_AXIS_CLASS = {
  horizontal:
    "h-island-gap cursor-row-resize after:absolute after:inset-x-0 after:top-1/2 after:h-0.5 after:-translate-y-1/2",
  vertical:
    "w-island-gap cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2",
} as const;

/** `react-resizable-panels` widens the grab area itself and reports it in `data-separator`. */
const PAINT_CLASS =
  "relative z-10 shrink-0 bg-line outline-none focus-visible:bg-accent data-[separator=active]:bg-accent data-[separator=hover]:bg-ink-muted";

/** Between islands the handle is the frame itself, marked only while it is under the pointer or focused (decision 141). */
const GUTTER_PAINT_CLASS =
  "relative z-10 shrink-0 outline-none after:rounded-full data-[separator=hover]:after:bg-ink-muted data-[separator=active]:after:bg-accent focus-visible:after:bg-accent";

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
