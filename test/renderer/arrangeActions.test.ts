import { describe, expect, it } from "vitest";
import type { TreeItemRef } from "@table-craft/desktop/datasourceTree/arrange.js";
import { ALL_ACTIONS } from "@table-craft/desktop/renderer/actions/allActions.js";
import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { createActionRegistry } from "@table-craft/desktop/renderer/actions/registry.js";
import { view } from "./datasourceViews.js";
import { IDLE_CONTEXT } from "./support.js";

const DATASOURCES = [
  view({ id: "env", name: "env", ephemeral: true }),
  view({ id: "p1", name: "p1", folder: "Prod" }),
  view({ id: "p2", name: "p2", folder: "Prod" }),
  view({ id: "a", name: "a" }),
  view({ id: "b", name: "b" }),
];

function enabled(actionId: string, items: readonly TreeItemRef[]): boolean {
  const context: ActionContext = {
    ...IDLE_CONTEXT,
    focus: "database",
    inDatabasePane: true,
    datasources: DATASOURCES,
    folders: ["Prod"],
    items,
  };
  const registry = createActionRegistry(() => context);
  registry.register(ALL_ACTIONS);
  return registry.isEnabled(actionId);
}

describe("arrange actions (plan 136)", () => {
  it("givenSelectionWithANonEmptyFolder_whenDeleteChecked_thenItIsDisabled", () => {
    expect(enabled(ACTION_IDS.deleteDatasource, [{ kind: "folder", path: "Prod" }])).toBe(false);
    expect(
      enabled(ACTION_IDS.deleteDatasource, [
        { kind: "folder", path: "Prod" },
        { kind: "datasource", id: "p1" },
        { kind: "datasource", id: "p2" },
      ]),
    ).toBe(true);
  });

  it("givenSelectionInTwoParents_whenMoveUpChecked_thenItIsDisabled", () => {
    expect(
      enabled(ACTION_IDS.moveUp, [
        { kind: "datasource", id: "b" },
        { kind: "datasource", id: "p2" },
      ]),
    ).toBe(false);
    expect(enabled(ACTION_IDS.moveUp, [{ kind: "datasource", id: "b" }])).toBe(true);
  });

  it("givenEphemeralInSelection_whenMoveToFolderChecked_thenItIsDisabled", () => {
    const items: TreeItemRef[] = [
      { kind: "datasource", id: "env" },
      { kind: "datasource", id: "a" },
    ];

    expect(enabled(ACTION_IDS.moveToFolder, items)).toBe(false);
    expect(enabled(ACTION_IDS.deleteDatasource, items)).toBe(false);
  });

  it("givenMultipleSelection_whenEscapeChecked_thenBackToEditorWaits", () => {
    const items: TreeItemRef[] = [
      { kind: "datasource", id: "a" },
      { kind: "datasource", id: "b" },
    ];

    expect(enabled(ACTION_IDS.focusEditor, items)).toBe(false);
    expect(enabled(ACTION_IDS.focusEditor, [{ kind: "datasource", id: "a" }])).toBe(true);
  });
});
