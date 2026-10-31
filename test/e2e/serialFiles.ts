/**
 * The smoke files the headless box runs one at a time, after every other file has run in parallel
 * (decision 096). Every parallel file shares the box's databases with the others, so a file lands
 * here when it writes fixture rows another file reads, or asserts an exact object count that the
 * files creating their own tables would change. Each entry says which.
 */
export const SERIAL_SMOKE_FILES: Readonly<Record<string, string>> = {
  "test/e2e/alignedFormat.smoke.test.ts": "creates `order_events_202607` beside the MySQL fixtures",
  "test/e2e/completion.smoke.test.ts": "expects `tables 6`, which a parallel file's own table changes",
  "test/e2e/console.smoke.test.ts": "updates `orders` totals and expects `tables 6`",
  "test/e2e/consoleEdits.smoke.test.ts": "edits and resets `orders`",
  "test/e2e/ddl.smoke.test.ts": "alters `orders` under an exclusive lock and expects `tables 6`",
  "test/e2e/explain.smoke.test.ts": "updates `orders` and expects its exact count",
  "test/e2e/explorer.smoke.test.ts": "creates a table and schemas and expects `tables 6`",
  "test/e2e/history.smoke.test.ts": "updates `orders` and expects `tables 6`",
  "test/e2e/jsonView.smoke.test.ts": "creates `json_view_probe` beside the fixtures, which changes `tables 6`",
  "test/e2e/keyLoadOnDemand.smoke.test.ts":
    "expects the Redis servers' `SCAN` count unchanged, which other files' key trees move",
  "test/e2e/namespace.smoke.test.ts": "expects `tables 6`",
  "test/e2e/oracle.smoke.test.ts": "holds a row lock on Oracle and edits `edit_probe` there",
  "test/e2e/packaged.smoke.test.ts": "shares the SSH bastion, whose sessions `sshTunnel` kills",
  "test/e2e/resultSearch.smoke.test.ts": "expects `tables 6`",
  "test/e2e/sessions.smoke.test.ts": "lists every server session and kills by statement text",
  "test/e2e/settings.smoke.test.ts": "creates `page_probe` and expects `tables 7`",
  "test/e2e/sqlFiles.smoke.test.ts":
    "expects a 100 MB script past 2,000 statements within the launch timeout, a rate the parallel files' CPU load starves",
  "test/e2e/sshTunnel.smoke.test.ts": "kills every session of the bastion's `tunnel` user",
  "test/e2e/tableEditor.smoke.test.ts": "edits and resets `orders` and `edit_probe`",
  "test/e2e/titleBar.smoke.test.ts": "holds a row lock on `orders` in an open transaction",
  "test/e2e/update.live.test.ts": "drives the host's keychain and screen (macOS only)",
  "test/e2e/workflows.smoke.test.ts": "edits and resets `edit_probe` and expects `tables 6`",
};
