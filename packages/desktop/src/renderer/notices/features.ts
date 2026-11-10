import type { FeatureNotice } from "@table-craft/desktop/renderer/model/notices.js";

/**
 * Features the bell announces once to people updating from a release without them (plan 145
 * ruling 15). The pull request that ships a user-visible feature adds its entry; an entry leaves
 * two releases later (`RELEASING.md`).
 */
export const FEATURE_NOTICES: readonly FeatureNotice[] = [
  {
    id: "agent-consoles",
    title: "Let an AI agent draft and edit consoles",
    body: "An agent connected over MCP can now open a console, edit it while you watch, open a table filtered and select it in the Database pane. Its tabs carry a robot icon, and nothing runs until you do.",
  },
  {
    id: "row-limit-in-sql",
    title: "A SELECT stops at one page on the server",
    body: "A plain SELECT now asks the database for one page of rows, so a large table no longer keeps it busy. Fetch Next Page and Fetch All run it again with a larger limit. Turn Row limit off under Settings → Data Editor to keep the cursor open instead.",
  },
];
