import { beforeEach, describe, expect, it } from "vitest";
import { createActionRegistry } from "@table-craft/desktop/renderer/actions/registry.js";
import { SERVICES_ACTION_IDS, SERVICES_ACTIONS } from "@table-craft/desktop/renderer/actions/servicesActions.js";
import { useServicesTree } from "@table-craft/desktop/renderer/state/servicesTree.js";
import { IDLE_CONTEXT } from "./support.js";

const KEYS = ["datasource:pg", "session:c1", "agents", "agent:Claude Code"];

function registry() {
  const created = createActionRegistry(() => IDLE_CONTEXT);
  created.register(SERVICES_ACTIONS);
  return created;
}

describe("Services Expand All and Collapse All", () => {
  beforeEach(() => {
    useServicesTree.setState({ collapsed: new Set(), expandableKeys: KEYS });
  });

  it("givenExpandedTree_whenCollapseAll_thenEveryExpandableKeyCollapsed", () => {
    expect(registry().invoke(SERVICES_ACTION_IDS.collapseAll)).toBe("ran");

    expect([...useServicesTree.getState().collapsed]).toEqual(KEYS);
  });

  it("givenCollapsedTree_whenExpandAll_thenNothingCollapsed", () => {
    useServicesTree.setState({ collapsed: new Set(["agents", "session:c1"]) });

    expect(registry().invoke(SERVICES_ACTION_IDS.expandAll)).toBe("ran");

    expect(useServicesTree.getState().collapsed.size).toBe(0);
  });

  it("givenAllCollapsed_whenCollapseAllChecked_thenDisabled", () => {
    const actions = registry();
    expect(actions.isEnabled(SERVICES_ACTION_IDS.collapseAll)).toBe(true);
    expect(actions.isEnabled(SERVICES_ACTION_IDS.expandAll)).toBe(false);

    useServicesTree.getState().collapseAll();

    expect(actions.isEnabled(SERVICES_ACTION_IDS.collapseAll)).toBe(false);
    expect(actions.isEnabled(SERVICES_ACTION_IDS.expandAll)).toBe(true);
    useServicesTree.getState().setExpandableKeys([...KEYS, "agent:Cursor"]);
    expect(actions.isEnabled(SERVICES_ACTION_IDS.collapseAll)).toBe(true);
  });

  it("givenEmptyTree_whenEitherChecked_thenDisabled", () => {
    useServicesTree.setState({ collapsed: new Set(["agents"]), expandableKeys: [] });
    const actions = registry();

    expect(actions.isEnabled(SERVICES_ACTION_IDS.collapseAll)).toBe(false);
    expect(actions.isEnabled(SERVICES_ACTION_IDS.expandAll)).toBe(false);
  });
});
