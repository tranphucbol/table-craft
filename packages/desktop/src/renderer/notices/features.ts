import type { FeatureNotice } from "@table-craft/desktop/renderer/model/notices.js";

/**
 * Features the bell announces once to people updating from a release without them (plan 145
 * ruling 15). The pull request that ships a user-visible feature adds its entry; an entry leaves
 * two releases later (`RELEASING.md`).
 */
export const FEATURE_NOTICES: readonly FeatureNotice[] = [
  {
    id: "row-limit-in-sql",
    title: "A SELECT stops at one page on the server",
    body: "A plain SELECT now asks the database for one page of rows, so a large table no longer keeps it busy. Fetch Next Page and Fetch All run it again with a larger limit. Turn Row limit off under Settings → Data Editor to keep the cursor open instead.",
  },
  {
    id: "agent-rerun-approval",
    title: "An agent asks before it runs a query again",
    body: "When an agent pages past the rows TableCraft holds, the database reads every row again up to the last one asked. That page now waits for your approval, and shows in Services and Query History. Query History's preview also has a Format toggle for long statements.",
  },
];
