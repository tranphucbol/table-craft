import * as Primitive from "@radix-ui/react-tooltip";
import type { ReactElement } from "react";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { TOOLTIP_MOTION } from "@table-craft/desktop/renderer/ui/motion.js";

const OPEN_DELAY_MS = 500;
const SIDE_OFFSET_PX = 4;

export function TooltipProvider({ children }: { readonly children: ReactElement | readonly ReactElement[] }) {
  return <Primitive.Provider delayDuration={OPEN_DELAY_MS}>{children}</Primitive.Provider>;
}

export interface TooltipProps {
  readonly label: string;
  /** Formatted for the platform, shown muted after the label. */
  readonly shortcut?: string;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly children: ReactElement;
}

export function Tooltip({ label, shortcut, side = "right", children }: TooltipProps) {
  return (
    <Primitive.Root>
      <Primitive.Trigger asChild>{children}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          side={side}
          sideOffset={SIDE_OFFSET_PX}
          className={cn(
            "z-50 rounded border border-line bg-raised px-cell py-1 text-ui text-ink shadow-lg",
            TOOLTIP_MOTION,
          )}
        >
          {label}
          {shortcut === undefined ? null : <span className="ml-gap text-ink-muted">{shortcut}</span>}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
