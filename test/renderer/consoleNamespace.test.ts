import { describe, expect, it } from "vitest";
import type { Namespace } from "@table-craft/desktop/engine/protocol.js";
import { consoleNamespaceFor, landedIn } from "@table-craft/desktop/renderer/model/consoleNamespace.js";

function target(path: readonly string[], kind: Namespace["kind"] = "schema"): Namespace {
  return { path, name: path.at(-1) ?? "", kind, system: false, current: false };
}

const DATABASES = [target(["shop"], "database"), target(["crm"], "database")];
const SCHEMAS = [target(["table_craft", "public"]), target(["table_craft", "audit"])];

describe("consoleNamespaceFor", () => {
  it("givenTopLevelTargets_whenTableInDatabase_thenThatDatabase", () => {
    expect(consoleNamespaceFor(["crm"], DATABASES)).toEqual(["crm"]);
  });

  it("givenSchemaTargets_whenTableInSchema_thenThatSchema", () => {
    expect(consoleNamespaceFor(["table_craft", "audit"], SCHEMAS)).toEqual(["table_craft", "audit"]);
  });

  it("givenSchemaTargets_whenDatabaseNode_thenNull", () => {
    expect(consoleNamespaceFor(["table_craft"], SCHEMAS)).toBeNull();
  });

  it("givenTopLevelTargets_whenPathIsDatabaseAndSchema_thenTheDatabase", () => {
    expect(consoleNamespaceFor(["crm", "dbo"], DATABASES)).toEqual(["crm"]);
  });

  it("givenNestedTargets_whenResolved_thenLongestPrefix", () => {
    const nested = [target(["crm"], "database"), target(["crm", "sales"])];

    expect(consoleNamespaceFor(["crm", "sales"], nested)).toEqual(["crm", "sales"]);
  });

  it("givenNoTargetMatches_whenResolved_thenNull", () => {
    expect(consoleNamespaceFor(["shopping"], DATABASES)).toBeNull();
    expect(consoleNamespaceFor(["SHOP"], DATABASES)).toBeNull();
  });

  it("givenEmptyPath_whenResolved_thenNull", () => {
    expect(consoleNamespaceFor([], DATABASES)).toBeNull();
  });
});

describe("landedIn", () => {
  it("givenDatabaseSwitch_whenLandedOnItsDefaultSchema_thenLanded", () => {
    expect(landedIn(["table_craft", "dbo"], ["table_craft"])).toBe(true);
    expect(landedIn(["table_craft"], ["table_craft"])).toBe(true);
  });

  it("givenSwitch_whenLandedElsewhere_thenNotLanded", () => {
    expect(landedIn(["shop"], ["ELSEWHERE"])).toBe(false);
    expect(landedIn(["table_craft"], ["table_craft", "dbo"])).toBe(false);
    expect(landedIn(["shop", "public"], ["shopping"])).toBe(false);
  });
});
