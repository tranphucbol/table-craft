import { describe, expect, it } from "vitest";
import {
  paletteResults,
  paletteTabs,
  pushRecent,
  RECENT_ACTIONS_LIMIT,
  type SearchItem,
  type SearchProvider,
} from "@table-craft/desktop/renderer/model/palette.js";
import { score } from "@table-craft/desktop/renderer/model/fuzzy.js";

const TITLES = ["Cancel", "Close Tab", "New Console", "Run"];

function item(title: string, query: string): SearchItem | null {
  const matched = score(query, title);
  if (matched === null) return null;
  return { key: `action:${title}`, title, enabled: true, score: matched, recentId: title, run: () => undefined };
}

const ACTIONS: SearchProvider = {
  id: "actions",
  title: "Actions",
  search: (query) => TITLES.map((title) => item(title, query)).filter((entry) => entry !== null),
};

const TABLES: SearchProvider = {
  id: "tables",
  title: "Tables",
  search: (query) => (score(query, "customers") === null ? [] : [{ ...item("customers", query)!, key: "t:c" }]),
};

describe("palette model", () => {
  it("givenRecentlyRunAction_whenPaletteOpensEmpty_thenItIsFirst", () => {
    const results = paletteResults([ACTIONS], "", pushRecent([], "Run"));

    expect(results.map((entry) => entry.title)).toEqual(["Run", "Cancel", "Close Tab", "New Console"]);
  });

  it("givenQuery_whenRanked_thenBestMatchFirst", () => {
    expect(paletteResults([ACTIONS], "nc", []).map((entry) => entry.title)[0]).toBe("New Console");
  });

  it("givenDisabledBetterMatch_whenRanked_thenEnabledResultsFirst", () => {
    const disabledFirst: SearchProvider = {
      id: "actions",
      title: "Actions",
      search: (query) =>
        TITLES.map((title) => item(title, query))
          .filter((entry) => entry !== null)
          .map((entry) => ({ ...entry, enabled: entry.title !== "New Console" })),
    };

    const titles = paletteResults([disabledFirst], "nc", []).map((entry) => entry.title);

    expect(titles.at(-1)).toBe("New Console");
    expect(titles.length).toBeGreaterThan(1);
  });

  it("givenProviderTab_whenRanked_thenOnlyThatProvidersItems", () => {
    expect(paletteResults([ACTIONS, TABLES], "c", [], "tables").map((entry) => entry.title)).toEqual(["customers"]);
    expect(paletteResults([ACTIONS, TABLES], "cu", [], "all").map((entry) => entry.title)).toContain("customers");
  });

  it("givenProviders_whenTabsListed_thenAllComesFirst", () => {
    expect(paletteTabs([ACTIONS, TABLES]).map((tab) => tab.title)).toEqual(["All", "Actions", "Tables"]);
  });

  it("givenFullRecentList_whenPushed_thenOldestDropsAndDuplicatesMove", () => {
    let recent: readonly string[] = [];
    for (let index = 0; index < RECENT_ACTIONS_LIMIT + 2; index += 1) recent = pushRecent(recent, `a${index}`);
    recent = pushRecent(recent, "a5");

    expect(recent).toHaveLength(RECENT_ACTIONS_LIMIT);
    expect(recent[0]).toBe("a5");
    expect(recent.filter((id) => id === "a5")).toHaveLength(1);
  });
});
