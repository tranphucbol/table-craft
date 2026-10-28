import { describe, expect, it } from "vitest";
import { BUTTON_CLASS } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { TONE_CLASSES } from "@table-craft/desktop/renderer/shell/UpdateButton.js";
import { FILLED_DANGER_PRESS, FILLED_PRESS, TEXT_PRESS } from "@table-craft/desktop/renderer/ui/pressClasses.js";

function classesOf(className: string): readonly string[] {
  return className.split(/\s+/);
}

function carries(className: string, press: string): boolean {
  const classes = classesOf(className);
  return classesOf(press).every((name) => classes.includes(name));
}

describe("press classes", () => {
  it("givenFilledButtonClasses_whenRead_thenEachCarriesFilledPress", () => {
    expect(carries(BUTTON_CLASS.primary, FILLED_PRESS)).toBe(true);
    expect(carries(BUTTON_CLASS.danger, FILLED_DANGER_PRESS)).toBe(true);
    expect(carries(FILLED_DANGER_PRESS, FILLED_PRESS)).toBe(true);
    expect(carries(TONE_CLASSES.accent, FILLED_PRESS)).toBe(true);
  });

  it("givenBorderedTextButtonClasses_whenRead_thenEachCarriesTextPressAndNoFill", () => {
    for (const className of [
      BUTTON_CLASS.secondary,
      BUTTON_CLASS.dangerOutline,
      TONE_CLASSES.neutral,
      TONE_CLASSES.danger,
    ]) {
      expect(carries(className, TEXT_PRESS)).toBe(true);
      expect(classesOf(className)).not.toContain("press-fill");
    }
  });
});
