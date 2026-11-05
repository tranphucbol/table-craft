import { SETTINGS_ACTION_IDS } from "@table-craft/desktop/renderer/actions/settingsActions.js";
import type { FeatureNotice } from "@table-craft/desktop/renderer/model/notices.js";

/**
 * Features the bell announces once to people updating from a release without them (plan 145
 * ruling 15). The pull request that ships a user-visible feature adds its entry; an entry leaves
 * two releases later (`RELEASING.md`).
 */
export const FEATURE_NOTICES: readonly FeatureNotice[] = [
  {
    id: "er-diagram",
    title: "See a schema as an ER diagram",
    body: "Right-click a schema, then Diagrams › Show Diagram. Keys the database does not declare are guessed.",
  },
  {
    id: "private-registries",
    title: "Install plugins from your company's registry",
    body: "Add a private npm registry, such as GitLab's, and install a plugin by its package name.",
    action: { label: "Plugins", actionId: SETTINGS_ACTION_IDS.show, args: { page: "plugins" } },
  },
];
