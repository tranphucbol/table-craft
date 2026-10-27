import { MOTION_CHOICES, resolveMotion, type MotionChoice } from "@table-craft/desktop/appearance/motion.js";
import { FieldRow } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { SectionTitle, update } from "@table-craft/desktop/renderer/dialogs/settingsParts.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";

const MOTION_LABELS: Readonly<Record<MotionChoice, string>> = {
  system: "System",
  full: "Full",
  reduced: "Reduced",
  off: "Off",
};

/** Applies at once: the renderer rewrites the motion variables, and main never reads the choice. */
export function MotionFields() {
  const motion = useSettings((state) => state.settings.appearance.motion);
  const prefersReducedMotion = useSettings((state) => state.system.prefersReducedMotion);
  return (
    <>
      <SectionTitle>Motion</SectionTitle>
      <FieldRow label="Animations">
        <div role="radiogroup" aria-label="Motion" className="flex gap-gap">
          {MOTION_CHOICES.map((id) => (
            <label key={id} className="flex items-center gap-1">
              <input
                type="radio"
                name="motion"
                checked={motion === id}
                onChange={() =>
                  update((current) => ({ ...current, appearance: { ...current.appearance, motion: id } }))
                }
              />
              {MOTION_LABELS[id]}
            </label>
          ))}
        </div>
      </FieldRow>
      {motion === "system" ? (
        <p className="col-start-2 text-ink-muted">
          Following the system: {MOTION_LABELS[resolveMotion("system", prefersReducedMotion)].toLowerCase()}
        </p>
      ) : null}
    </>
  );
}
