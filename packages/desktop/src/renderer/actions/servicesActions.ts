import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { useServicesTree } from "@table-craft/desktop/renderer/state/servicesTree.js";

export const SERVICES_ACTION_IDS = {
  collapseAll: "services.collapseAll",
  expandAll: "services.expandAll",
} as const;

/** Whether some expandable node is folded, or with `false` unfolded. */
function anyNode(folded: boolean): boolean {
  const { collapsed, expandableKeys } = useServicesTree.getState();
  return expandableKeys.some((key) => collapsed.has(key) === folded);
}

/** The Services header's Expand All and Collapse All; `⌘=` and `⌘-` share their chords with the editor zoom and the Database pane (decision 027). */
export const SERVICES_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: SERVICES_ACTION_IDS.collapseAll,
    title: "Collapse All",
    category: "Services",
    icon: "collapseAll",
    shortcut: "Mod+-",
    shortcutRegion: "services",
    when: () => anyNode(false),
    run: () => useServicesTree.getState().collapseAll(),
  }),
  defineAction({
    id: SERVICES_ACTION_IDS.expandAll,
    title: "Expand All",
    category: "Services",
    icon: "expandAll",
    shortcut: "Mod+=",
    shortcutRegion: "services",
    when: () => anyNode(true),
    run: () => useServicesTree.getState().expandAll(),
  }),
];
