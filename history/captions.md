# Plan 110 etcd History / Restore / Merge live evidence

Headless box (Linux, Xvfb), 1200x800 at DPR 1, etcd 3.6.5 (auth) unless noted.
Command: `TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/110 bun run test:smoke:db:headless:etcd test/e2e/etcdHistory.smoke.test.ts test/e2e/etcd.smoke.test.ts` — 11/11 passed.

| File | Caption |
| --- | --- |
| 04-submitted.png | Guarded string edit submitted: footer reads "Changes saved atomically", value re-read as `after`, header v2. |
| 05-conflict.png | Value changed elsewhere before Submit: the key tab opens Merge (Theirs `zed` / Yours `bo` / Result) instead of overwriting; server keeps `zed`. |
| 10-history-real-diff.png | History of one key: v1 PUT, v2 PUT, Deleted DELETE, recreated v1 PUT (Current), ages counted in revisions with "No timestamps are available"; selected v2 · rev N shows the real line diff against Current (`"safe"`/2 removed, `"fast"`/5 added). |
| 11-restore-pending-only.png | Restore Selected Version stages v2's value in the mounted value editor ("1 pending change", "Historical value staged. The current lease is kept; an old lease is not restored."); the server still holds the current value and revision. |
| 12-restore-preview.png | Preview of the staged restore: one `txn` guarded by `mod(key) = <current mod revision>` with `put … --ignore-lease`; nothing written yet. |
| 13-restore-confirmed-lease-preserved.png | After Submit: "Changes saved atomically", editor shows the restored value, server value is v2's, mod revision advanced, the current (non-zero) lease kept. |
| 14-merge-same-bytes-aba.png | ABA: someone re-saved the same bytes (new mod revision) after the restore was staged; Submit is refused by the revision guard and Merge opens with Theirs (`"fast"`), Yours (`"safe"`) and Result. |
| 15-merge-repeated-conflict-result-retained.png | Result edited and marked resolved, then the key changed again (`"external"`): Save Merged is refused, the banner says "Changed again: v3", the edited Result is retained, two new conflicts (/mode, /retries) and Save Merged disabled. |
| 16-merge-resolved.png | Both conflicts resolved with "Use yours"; Result still the reviewed value, Save Merged enabled. |
| 17-merged-submit-confirmed.png | Save Merged written under the revision guard: Merge closes, server holds the reviewed value, revision advanced, lease kept. |
| 18-readonly-history-no-restore.png | etcd 3.5, read-only datasource: History and the diff are available; Restore Selected Version and Submit are disabled; server unchanged. |
| 19-merge-deleted-by-theirs.png | Restore staged, then the key was deleted elsewhere: Submit opens Merge "Someone else deleted this key while you were editing.", Theirs · key absent, Save Merged disabled until an explicit choice. |
| 20-merge-recreated-differently.png | After choosing Yours, the key was recreated elsewhere with a different value: Save Merged is refused ("Changed again:"), Theirs shows `"external"`, conflicts must be resolved explicitly again before saving. |
