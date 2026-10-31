import { describe, expect, it } from "vitest";
import { parseWholeNumber } from "@table-craft/desktop/renderer/model/format.js";

describe("parseWholeNumber", () => {
  it("givenGroupedText_whenParsed_thenNumber", () => {
    expect(parseWholeNumber("100,000")).toBe(100_000);
    expect(parseWholeNumber(" 1,000,000 ")).toBe(1_000_000);
  });

  it("givenPlainDigits_whenParsed_thenNumber", () => {
    expect(parseWholeNumber("42")).toBe(42);
  });

  it("givenNotAWholeNumber_whenParsed_thenNaN", () => {
    for (const text of ["", "1.5", "-3", "1e3", "ten", ","]) expect(parseWholeNumber(text)).toBeNaN();
  });
});
