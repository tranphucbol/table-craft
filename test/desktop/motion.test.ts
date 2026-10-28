import { describe, expect, it } from "vitest";
import { MOTION, resolveMotion } from "@table-craft/desktop/appearance/motion.js";

describe("motion levels", () => {
  it("givenSystemChoice_whenOsPrefersReducedMotion_thenReduced", () => {
    expect(resolveMotion("system", true)).toBe("reduced");
  });

  it("givenSystemChoice_whenOsHasNoPreference_thenFull", () => {
    expect(resolveMotion("system", false)).toBe("full");
  });

  it("givenFullChoice_whenOsPrefersReducedMotion_thenFull", () => {
    expect(resolveMotion("full", true)).toBe("full");
    expect(resolveMotion("off", false)).toBe("off");
  });

  it("givenOffLevel_whenTokensRead_thenEveryDurationIsZeroAndLoopsPaused", () => {
    expect(MOTION.off).toEqual({
      fastMs: 0,
      baseMs: 0,
      slowMs: 0,
      flashMs: 0,
      shiftPx: 0,
      enterScale: 1,
      pressScale: 1,
      pressScaleText: 1,
      progress: "paused",
      ambient: "paused",
    });
  });

  it("givenReducedLevel_whenTokensRead_thenNoTravelNoScaleAndSpinnersRun", () => {
    expect(MOTION.reduced).toEqual({
      ...MOTION.full,
      shiftPx: 0,
      enterScale: 1,
      pressScale: 1,
      pressScaleText: 1,
      ambient: "paused",
    });
    expect(MOTION.reduced.progress).toBe("running");
    expect(MOTION.full).toMatchObject({ fastMs: 100, baseMs: 150, slowMs: 200, shiftPx: 4, enterScale: 0.98 });
  });

  it("givenFullLevel_whenTokensRead_thenIconButtonsShrinkWhilePressed", () => {
    expect(MOTION.full.pressScale).toBeLessThan(1);
  });

  it("givenFullLevel_whenTokensRead_thenTextPressShrinksLessThanIconPress", () => {
    expect(MOTION.full.pressScaleText).toBeLessThan(1);
    expect(MOTION.full.pressScaleText).toBeGreaterThan(MOTION.full.pressScale);
  });
});
