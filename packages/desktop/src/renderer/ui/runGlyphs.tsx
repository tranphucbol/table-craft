import { IconBase, type Icon, type IconWeight } from "@phosphor-icons/react";
import { forwardRef, type ReactElement } from "react";

/**
 * Corner radius of the run glyphs in the 256-unit view box, about 2 px at icon size. Phosphor's own
 * Play and Stop round by 16 units, which reads sharp at 16 px (plan 127).
 */
const CORNER = 24;
/** The square's radius, a little larger so it reads as round as the triangles' corners. */
const STOP_CORNER = 32;
const NO_WEIGHTS = new Map<IconWeight, ReactElement>();

function RoundedPolygon({ points }: { points: string }) {
  return <polygon points={points} stroke="currentColor" strokeWidth={CORNER * 2} strokeLinejoin="round" />;
}

/** A solid triangle with soft corners; solid at every weight. */
export const RunGlyph: Icon = forwardRef(function RunGlyph(props, ref) {
  return (
    <IconBase ref={ref} {...props} weights={NO_WEIGHTS}>
      <RoundedPolygon points="84,58 84,198 193,128" />
    </IconBase>
  );
});

/** Two soft triangles, Run All. */
export const RunAllGlyph: Icon = forwardRef(function RunAllGlyph(props, ref) {
  return (
    <IconBase ref={ref} {...props} weights={NO_WEIGHTS}>
      <RoundedPolygon points="43,80 43,176 113,128" />
      <RoundedPolygon points="143,80 143,176 213,128" />
    </IconBase>
  );
});

/** A solid square with soft corners, Cancel. */
export const StopGlyph: Icon = forwardRef(function StopGlyph(props, ref) {
  return (
    <IconBase ref={ref} {...props} weights={NO_WEIGHTS}>
      <rect x={40} y={40} width={176} height={176} rx={STOP_CORNER} />
    </IconBase>
  );
});
