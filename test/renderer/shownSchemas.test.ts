import { describe, expect, it } from "vitest";
import type { Namespace } from "@table-craft/desktop/engine/protocol.js";
import {
  matchingNamespaces,
  matchPositions,
  namespaceNoun,
  selectedCount,
  withNames,
} from "@table-craft/desktop/renderer/model/shownSchemas.js";

function database(name: string): Namespace {
  return { path: [name], name, kind: "database", system: false, current: false };
}

const DATABASES = [database("Billing"), database("shop"), database("shop_archive")];

describe("manage shown schemas", () => {
  it("givenQuery_whenMatched_thenCaseInsensitiveSubstring", () => {
    expect(matchingNamespaces(DATABASES, " SHOP ").map((namespace) => namespace.name)).toEqual([
      "shop",
      "shop_archive",
    ]);
    expect(matchingNamespaces(DATABASES, "")).toBe(DATABASES);
  });

  it("givenSelection_whenNamesToggled_thenOthersKept", () => {
    const selected = new Set(["Billing", "gone"]);

    expect([...withNames(selected, ["shop", "shop_archive"], true)]).toEqual([
      "Billing",
      "gone",
      "shop",
      "shop_archive",
    ]);
    expect([...withNames(selected, ["Billing"], false)]).toEqual(["gone"]);
  });

  it("givenSelection_whenCounted_thenOnlyListedNamesCountAndNullCountsAll", () => {
    expect(selectedCount(DATABASES, new Set(["shop", "gone"]))).toBe(1);
    expect(selectedCount(DATABASES, null)).toBe(3);
  });

  it("givenQuery_whenMatchMarked_thenItsCharactersIgnoringCase", () => {
    expect(matchPositions("shop_archive", " ARCH ")).toEqual([5, 6, 7, 8]);
    expect(matchPositions("shop", "")).toEqual([]);
    expect(matchPositions("shop", "bill")).toEqual([]);
  });

  it("givenNamespaceKinds_whenNamed_thenDatabasesOnlyWhenEveryOneIs", () => {
    expect(namespaceNoun(DATABASES)).toBe("databases");
    expect(namespaceNoun([...DATABASES, { ...database("public"), kind: "schema" }])).toBe("schemas");
    expect(namespaceNoun([])).toBe("schemas");
  });
});
