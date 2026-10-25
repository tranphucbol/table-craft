import { incompatibility, isCompatible } from "@table-craft/plugin-api";
import { describe, expect, it } from "vitest";

describe("isCompatible", () => {
  it.each([
    ["1.0.0", "1.0.0", true],
    ["1.0.0", "1.4.1", true],
    ["1.4.0", "1.4.1", true],
    ["1.4.5", "1.4.1", true],
    ["1.5.0", "1.4.1", false],
    ["2.0.0", "1.4.1", false],
    ["0.28.0", "1.0.0", false],
    ["1.0.0", "2.0.0", false],
    ["v1.0.0", "1.0.0", false],
  ])("givenPlugin%sAndHost%s_whenChecked_thenCompatibleIs%s", (plugin, host, expected) => {
    expect(isCompatible(plugin, host)).toBe(expected);
  });
});

describe("incompatibility", () => {
  it.each([
    ["1.0.0", "1.3.0", null],
    ["1.3.9", "1.3.0", null],
    ["1.4.0", "1.3.0", "newer"],
    ["2.1.0", "1.3.0", "newer"],
    ["0.28.0", "1.3.0", "olderMajor"],
    ["latest", "1.3.0", "invalid"],
  ])("givenPlugin%sAndHost%s_whenChecked_thenIs%s", (plugin, host, expected) => {
    expect(incompatibility(plugin, host)).toBe(expected);
  });
});
