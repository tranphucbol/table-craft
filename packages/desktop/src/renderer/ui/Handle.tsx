import { Separator } from "react-resizable-panels";
import { cn } from "./cn.js";

const AXIS_CLASS = {
  horizontal: "h-px cursor-row-resize",
  vertical: "w-px cursor-col-resize",
} as const;

/** `react-resizable-panels` widens the grab area itself and reports it in `data-separator`. */
const PAINT_CLASS =
  "relative z-10 shrink-0 bg-line data-[separator=active]:bg-accent data-[separator=hover]:bg-ink-muted";

export interface HandleProps {
  /** `horizontal` for a boundary dragged up and down, `vertical` for one dragged left and right. */
  readonly axis: keyof typeof AXIS_CLASS;
  readonly label?: string;
}

export function Handle({ axis, label }: HandleProps) {
  return <Separator aria-label={label} className={cn(PAINT_CLASS, AXIS_CLASS[axis])} />;
}
