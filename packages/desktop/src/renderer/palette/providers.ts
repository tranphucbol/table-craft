import type { ActionRegistry } from "@table-craft/desktop/renderer/actions/registry.js";
import { score } from "@table-craft/desktop/renderer/model/fuzzy.js";
import type { SearchItem, SearchProvider } from "@table-craft/desktop/renderer/model/palette.js";

export type { SearchItem, SearchProvider } from "@table-craft/desktop/renderer/model/palette.js";

export const ACTIONS_PROVIDER_ID = "actions";
const ACTION_KEY_PREFIX = "action:";

/**
 * Every registered action that is available, disabled ones included so the user sees why nothing
 * would happen.
 */
export function actionsProvider(registry: ActionRegistry): SearchProvider {
  return {
    id: ACTIONS_PROVIDER_ID,
    title: "Actions",
    search(query) {
      return registry.all().flatMap((action): SearchItem[] => {
        const matched = score(query, action.title);
        if (matched === null || action.inPalette === false || !registry.isAvailable(action.id)) return [];
        return [
          {
            key: `${ACTION_KEY_PREFIX}${action.id}`,
            title: action.title,
            detail: action.category,
            ...(action.shortcut === undefined ? {} : { shortcut: action.shortcut }),
            enabled: registry.isEnabled(action.id),
            score: matched,
            recentId: action.id,
            run: () => void registry.invoke(action.id),
          },
        ];
      });
    },
  };
}
