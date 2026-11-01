import { describe, expect, it } from "vitest";
import { formatClock, formatElapsed } from "@table-craft/desktop/renderer/model/format.js";

describe("formatElapsed", () => {
  it("givenUnderASecond_whenFormatElapsed_thenMilliseconds", () => {
    expect(formatElapsed(0)).toBe("0 ms");
    expect(formatElapsed(847)).toBe("847 ms");
    expect(formatElapsed(999.9)).toBe("999 ms");
  });

  it("givenSeconds_whenFormatElapsed_thenThreeDecimals", () => {
    expect(formatElapsed(1000)).toBe("1.000 s");
    expect(formatElapsed(2043)).toBe("2.043 s");
    expect(formatElapsed(59_999)).toBe("59.999 s");
  });

  it("givenOverAMinute_whenFormatElapsed_thenMinutesSecondsMillis", () => {
    expect(formatElapsed(60_000)).toBe("1:00.000");
    expect(formatElapsed(62_381)).toBe("1:02.381");
    expect(formatElapsed(3_600_000)).toBe("60:00.000");
  });

  it("givenNegative_whenFormatElapsed_thenZero", () => {
    expect(formatElapsed(-5)).toBe("0 ms");
  });
});

describe("formatClock", () => {
  it("givenSeconds_whenFormatClock_thenMinutesSeconds", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(7_999)).toBe("0:07");
    expect(formatClock(230_000)).toBe("3:50");
    expect(formatClock(-5)).toBe("0:00");
  });

  it("givenOverAnHour_whenFormatClock_thenHoursMinutesSeconds", () => {
    expect(formatClock(3_735_000)).toBe("1:02:15");
    expect(formatClock(36_000_000)).toBe("10:00:00");
  });
});
