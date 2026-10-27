import { describe, expect, it } from "vitest";
import {
  firstDayOfWeek,
  monthGrid,
  monthTitle,
  shiftDay,
  shiftMonth,
  weekdayInitials,
  weekEnd,
  weekStart,
  wrapSegment,
} from "@table-craft/desktop/renderer/model/calendar.js";

describe("calendar", () => {
  it("givenMonthStartingWednesday_whenMondayFirst_thenGridOpensOnPreviousMonday", () => {
    const grid = monthGrid("2025-01", 1, "2025-01-15");
    expect(grid[0]).toEqual({ day: "2024-12-30", inMonth: false, today: false });
    expect(grid[2]).toEqual({ day: "2025-01-01", inMonth: true, today: false });
    expect(grid.find((cell) => cell.today)?.day).toBe("2025-01-15");
  });

  it("givenSundayFirst_whenGrid_thenOpensOnPreviousSunday", () => {
    expect(monthGrid("2025-01", 7, "2025-01-15")[0]?.day).toBe("2024-12-29");
  });

  it("givenAnyMonth_whenGrid_thenFortyTwoDaysWithInMonthFlags", () => {
    const grid = monthGrid("2026-02", 1, "2026-02-25");
    expect(grid).toHaveLength(42);
    expect(grid.filter((cell) => cell.inMonth)).toHaveLength(28);
    expect(grid[0]?.day).toBe("2026-01-26");
    expect(grid.at(-1)?.day).toBe("2026-03-08");
  });

  it("givenSundayLocale_whenFirstDayOfWeek_thenSeven", () => {
    expect(firstDayOfWeek("en-US")).toBe(7);
    expect(firstDayOfWeek("en-GB")).toBe(1);
  });

  it("givenUnknownLocale_whenFirstDayOfWeek_thenMonday", () => {
    expect(firstDayOfWeek("")).toBe(1);
  });

  it("givenJanuary31_whenShiftMonth_thenFebruaryLastDay", () => {
    expect(shiftMonth("2024-01-31", 1)).toBe("2024-02-29");
    expect(shiftMonth("2025-01-31", 1)).toBe("2025-02-28");
    expect(shiftMonth("2025-01-15", -1)).toBe("2024-12-15");
  });

  it("givenLeapYearFeb29_whenShiftYear_thenFeb28", () => {
    expect(shiftMonth("2024-02-29", 12)).toBe("2025-02-28");
  });

  it("givenDecember31_whenShiftDay_thenNextYear", () => {
    expect(shiftDay("2024-12-31", 1)).toBe("2025-01-01");
    expect(shiftDay("2024-03-01", -1)).toBe("2024-02-29");
    expect(shiftDay("2024-03-31", 7)).toBe("2024-04-07");
  });

  it("givenADay_whenWeekBounds_thenFirstAndLastDayOfItsWeek", () => {
    expect(weekStart("2026-02-25", 1)).toBe("2026-02-23");
    expect(weekEnd("2026-02-25", 1)).toBe("2026-03-01");
    expect(weekStart("2026-02-25", 7)).toBe("2026-02-22");
  });

  it("givenLocale_whenHeadings_thenWeekdaysFromFirstDayAndMonthName", () => {
    expect(weekdayInitials("en-GB", 1)).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
    expect(weekdayInitials("en-US", 7)[0]).toBe("S");
    expect(monthTitle("2026-02", "en-US")).toBe("February 2026");
  });

  it("givenMinute59_whenStepUp_thenWrapsToZero", () => {
    expect(wrapSegment(59, 1, 60)).toBe(0);
    expect(wrapSegment(0, -1, 24)).toBe(23);
    expect(wrapSegment(10, 1, 60)).toBe(11);
  });
});
