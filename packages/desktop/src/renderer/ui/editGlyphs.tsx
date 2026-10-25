import { ArrowFatUp, Eye, IconBase, type Icon, type IconWeight } from "@phosphor-icons/react";
import { forwardRef, useId, type ReactElement } from "react";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

const VIEW_BOX = 256;
const BADGE_SIZE = 136;
const BADGE_X = VIEW_BOX - BADGE_SIZE + 4;
const BADGE_Y = VIEW_BOX - BADGE_SIZE - 4;
/** The halo cut out of the eye around the badge, in the badge's own units, so the two never touch. */
const BADGE_HALO = 56;
const NO_WEIGHTS = new Map<IconWeight, ReactElement>();

/** DataGrip's Submit: a hollow up arrow in the success colour. */
export const SubmitGlyph: Icon = forwardRef(function SubmitGlyph({ className, ...props }, ref) {
  return <ArrowFatUp ref={ref} {...props} className={cn(className, "text-success")} />;
});

/**
 * DataGrip's Preview Pending Changes: an eye in the button's colour with a solid Submit arrow as a
 * badge in its lower right; an outlined one is too thin to read at half size. The eye is masked
 * around the badge, as the badge overlaps its outline.
 */
export const PreviewChangesGlyph: Icon = forwardRef(function PreviewChangesGlyph({ weight, ...props }, ref) {
  const maskId = `preview-changes-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <IconBase ref={ref} {...props} weight={weight} weights={NO_WEIGHTS}>
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={VIEW_BOX} height={VIEW_BOX}>
          <rect width={VIEW_BOX} height={VIEW_BOX} fill="white" />
          <ArrowFatUp
            x={BADGE_X}
            y={BADGE_Y}
            size={BADGE_SIZE}
            weight="fill"
            color="black"
            stroke="black"
            strokeWidth={BADGE_HALO}
            strokeLinejoin="round"
          />
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        <Eye size={VIEW_BOX} weight={weight} />
      </g>
      <g className="text-success">
        <ArrowFatUp x={BADGE_X} y={BADGE_Y} size={BADGE_SIZE} weight="fill" />
      </g>
    </IconBase>
  );
});
