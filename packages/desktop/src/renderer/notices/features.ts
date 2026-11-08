import type { FeatureNotice } from "@table-craft/desktop/renderer/model/notices.js";

/**
 * Features the bell announces once to people updating from a release without them (plan 145
 * ruling 15). The pull request that ships a user-visible feature adds its entry; an entry leaves
 * two releases later (`RELEASING.md`).
 */
export const FEATURE_NOTICES: readonly FeatureNotice[] = [
  {
    id: "result-charts",
    title: "See a result as a chart",
    body: "Press Chart in a result's toolbar to draw it as a bar, line, area, pie, scatter, histogram or stock chart.",
  },
  {
    id: "agent-consoles",
    title: "Let an AI agent draft and edit consoles",
    body: "An agent connected over MCP can now open a console, edit it while you watch, open a table filtered and select it in the Database pane. Its tabs carry a robot icon, and nothing runs until you do.",
  },
];
