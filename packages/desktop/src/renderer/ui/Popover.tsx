import * as Primitive from "@radix-ui/react-popover";
import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { SURFACE_MOTION } from "@table-craft/desktop/renderer/ui/motion.js";

const SIDE_OFFSET_PX = 4;

/** Where a popover hangs from, in viewport coordinates: a tree row, or the caret. */
export interface PopoverAnchor {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * A themed popover hanging below `anchor` (plan 010 decision 12), at most the popover tokens'
 * size; Escape or a click outside closes it.
 */
export function Popover({
  anchor,
  label,
  testId,
  onClose,
  onOutside,
  focusSelf,
  children,
}: {
  readonly anchor: PopoverAnchor;
  readonly label: string;
  readonly testId?: string;
  readonly onClose: () => void;
  /** A pointer down or focus outside, before `onClose`: what was pressed or focused. */
  readonly onOutside?: (target: EventTarget | null) => void;
  /**
   * Focus the popover itself on open rather than its first control, which a press from outside
   * would otherwise draw with a focus ring; Tab still reaches the controls.
   */
  readonly focusSelf?: boolean;
  readonly children: ReactNode;
}) {
  // The anchor is no trigger Radix could hand focus back to, so focus returns where it was.
  const [returnTo] = useState(() => document.activeElement);
  const virtualRef = useMemo(() => {
    const { left, top, right, bottom } = anchor;
    const rect = { left, top, right, bottom, x: left, y: top, width: right - left, height: bottom - top };
    return { current: { getBoundingClientRect: () => ({ ...rect, toJSON: () => rect }) } };
  }, [anchor]);
  return (
    <Primitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Primitive.Anchor virtualRef={virtualRef} />
      <Primitive.Portal>
        <Primitive.Content
          side="bottom"
          align="start"
          sideOffset={SIDE_OFFSET_PX}
          collisionPadding={SIDE_OFFSET_PX}
          aria-label={label}
          data-testid={testId}
          onInteractOutside={(event) => onOutside?.(event.target)}
          {...(focusSelf === true
            ? {
                onOpenAutoFocus: (event: Event) => {
                  event.preventDefault();
                  if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
                },
              }
            : {})}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnTo instanceof HTMLElement) returnTo.focus();
          }}
          className={cn(
            "z-50 flex max-h-popover-height w-max max-w-popover flex-col overflow-hidden rounded border border-line bg-raised text-ui text-ink shadow-lg outline-none",
            SURFACE_MOTION,
          )}
        >
          {children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
