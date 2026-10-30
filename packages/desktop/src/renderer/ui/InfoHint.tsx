import * as Primitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { InfoIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { TOOLTIP_MOTION } from "@table-craft/desktop/renderer/ui/motion.js";

/** Quicker than a toolbar tooltip: the (i) exists only to be read. */
const OPEN_DELAY_MS = 150;
const SIDE_OFFSET_PX = 4;

/**
 * An (i) button that shows `children` while it is hovered or focused: the place for help that would
 * otherwise sit under a field as a paragraph.
 */
export function InfoHint({
  label,
  testId,
  className,
  children,
}: {
  /** The button's accessible name, such as "About Namespace". */
  readonly label: string;
  readonly testId?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <Primitive.Root delayDuration={OPEN_DELAY_MS}>
      <Primitive.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          data-testid={testId}
          className={cn(
            "flex shrink-0 items-center justify-center rounded text-ink-muted hover:bg-raised hover:text-ink focus-visible:text-ink",
            className,
          )}
          // A click would close the tooltip; the hint stays up while the pointer is on it.
          onClick={(event) => event.preventDefault()}
        >
          <InfoIcon aria-hidden className="size-icon" />
        </button>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          side="top"
          align="start"
          sideOffset={SIDE_OFFSET_PX}
          collisionPadding={SIDE_OFFSET_PX}
          className={cn(
            "z-50 max-w-popover rounded border border-line bg-raised px-cell py-1 text-ui whitespace-normal text-ink shadow-lg",
            TOOLTIP_MOTION,
          )}
        >
          {children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
