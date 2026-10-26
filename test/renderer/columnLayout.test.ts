import { describe, expect, it } from "vitest";
import {
  allShown,
  carriedLayout,
  columnTemplate,
  fittedTo,
  hiddenColumn,
  initialLayout,
  MIN_COLUMN_WIDTH_PX,
  resizedTo,
  visibleColumns,
} from "@table-craft/desktop/renderer/model/columnLayout.js";
import { cycledSort, sortedBy, sortMarkOf } from "@table-craft/desktop/renderer/model/sortKeys.js";

describe("column layout", () => {
  it("givenTransposedLayout_whenColumnsChangeOnRerun_thenStaysTransposed", () => {
    const layout = { ...hiddenColumn(initialLayout(2), 0), transposed: true };

    expect(carriedLayout(layout, ["a", "b"], ["a", "b", "c"])).toEqual({ ...initialLayout(3), transposed: true });
    expect(carriedLayout(initialLayout(2), ["a", "b"], ["c"])).not.toHaveProperty("transposed");
  });

  it("givenDragNarrowerThanMinimum_whenResized_thenClampedToMinimum", () => {
    const layout = resizedTo(initialLayout(2), 1, 12);

    expect(layout.widths[1]).toEqual({ kind: "px", px: MIN_COLUMN_WIDTH_PX });
    expect(layout.widths[0]).toEqual({ kind: "auto" });
  });

  it("givenAutoDraggedAndFitted_whenTemplated_thenEachTrackFollowsItsWidth", () => {
    const layout = fittedTo(resizedTo(initialLayout(3), 1, 150.4), 2, 60);

    expect(columnTemplate(layout, [4, 9, 12])).toBe(
      "min(var(--spacing-column-max), calc(4ch + 2 * var(--spacing-cell) + 1px)) 150px calc(60ch + 2 * var(--spacing-cell) + 1px)",
    );
  });

  it("givenHiddenColumn_whenTemplated_thenItsTrackIsGoneAndVisibleSkipsIt", () => {
    const layout = hiddenColumn(initialLayout(3), 1);

    expect(visibleColumns(layout)).toEqual([0, 2]);
    expect(columnTemplate(layout, [4, 9, 12]).split(") min").length).toBe(2);
    expect(visibleColumns(allShown(layout))).toEqual([0, 1, 2]);
  });

  it("givenLastVisibleColumn_whenHidden_thenStaysShown", () => {
    const layout = hiddenColumn(hiddenColumn(initialLayout(2), 0), 1);

    expect(visibleColumns(layout)).toEqual([1]);
  });

  it("givenRerunWithSameColumns_whenCarried_thenLayoutKeptElseReset", () => {
    const layout = hiddenColumn(resizedTo(initialLayout(2), 0, 90), 1);

    expect(carriedLayout(layout, ["a", "b"], ["a", "b"])).toBe(layout);
    expect(carriedLayout(layout, ["a", "b"], ["a", "c"])).toEqual(initialLayout(2));
  });
});

describe("sort keys", () => {
  it("givenPlainHeaderClicks_whenCycled_thenAscendingDescendingNone", () => {
    const once = cycledSort([], 2, false);
    const twice = cycledSort(once, 2, false);

    expect(once).toEqual([{ column: 2, direction: "asc" }]);
    expect(twice).toEqual([{ column: 2, direction: "desc" }]);
    expect(cycledSort(twice, 2, false)).toEqual([]);
  });

  it("givenOptionClick_whenCycled_thenSecondKeyAppendedAndCycledInPlace", () => {
    const first = cycledSort([], 1, false);
    const second = cycledSort(first, 0, true);

    expect(second).toEqual([
      { column: 1, direction: "asc" },
      { column: 0, direction: "asc" },
    ]);
    expect(cycledSort(second, 1, true)).toEqual([
      { column: 1, direction: "desc" },
      { column: 0, direction: "asc" },
    ]);
    expect(cycledSort(cycledSort(second, 0, true), 0, true)).toEqual([{ column: 1, direction: "asc" }]);
    expect(sortMarkOf(second, 0)).toEqual({ direction: "asc", position: 2 });
    expect(sortMarkOf(second, 5)).toBeNull();
  });

  it("givenPlainClickOnOneOfSeveralKeys_whenCycled_thenSortsByItAlone", () => {
    const keys = [
      { column: 1, direction: "asc" },
      { column: 0, direction: "asc" },
    ] as const;

    expect(cycledSort(keys, 0, false)).toEqual([{ column: 0, direction: "desc" }]);
    expect(sortedBy(3, "desc")).toEqual([{ column: 3, direction: "desc" }]);
  });
});
