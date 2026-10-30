# Etcd plan 110 completion evidence

Linux headless, 2026-10-30. Additive completion gallery; prior root and History images remain unchanged.

Final integrated tests: root 3711, default DB 401, etcd DB 162, full selected smoke 15. Visual-only polish: 54 focused tests and six scoped headless tests; nine images refreshed. Snapshot backpressure is unit-tested, not demonstrated live. No claim all administrative UI actions, platforms or accessibility paths were live-tested.

Limits: auth enable refused; coordination is a configured-prefix viewer, not lock creation. Private 0600 temporary captures can survive crashes; hard-link publication fails safely on exFAT. Rejected credentials clear the entire editor and undo state.

Prior evidence: [branch root](https://github.com/tranphucbol/table-craft/tree/feature/evidence-110-etcd).

## 1. 01-tree.png

Slash folders, key versions and lease TTL in the database tree.

![01-tree.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/01-tree-06dffa10.png)

## 2. 02-json-details.png

JSON value and revision/lease details with pending-lease controls.

![02-json-details.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/02-json-details-1289d8e7.png)

## 3. 03-preview.png

Guarded transaction preview before submitting a value edit.

![03-preview.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/03-preview-53e3105f.png)

## 4. 04-submitted.png

Confirmed edited value and Saved as v2 notice.

![04-submitted.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/04-submitted-b964f245.png)

## 5. 05-conflict.png

Concurrent change opens an explicit in-place merge conflict.

![05-conflict.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/05-conflict-19a6c0a5.png)

## 6. 06-console-get.png

Actual GET result with KV revision columns.

![06-console-get.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/06-console-get-23f77799.png)

## 7. 07-console-txn.png

Executed transaction reports SUCCESS.

![07-console-txn.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/07-console-txn-b22fe413.png)

## 8. 08-server-auth.png

Permission-limited endpoint status remains an explanatory note.

![08-server-auth.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/08-server-auth-8d9b1fcb.png)

## 9. 08-server.png

Members to Server Details: connection facts and readable Prefix control.

![08-server.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/08-server-3a34f6c5.png)

## 10. 09-etcd35-members.png

etcd 3.5 member-list command result.

![09-etcd35-members.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/09-etcd35-members-70d3935f.png)

## 11. 10-history-real-diff.png

Real PUT/DELETE/recreate history and line diff against current value.

![10-history-real-diff.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/10-history-real-diff-9e3e57c0.png)

## 12. 11-restore-pending-only.png

Historical Restore stages one pending change without writing.

![11-restore-pending-only.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/11-restore-pending-only-f4678e02.png)

## 13. 12-restore-preview.png

Restore preview guards current modified revision and preserves current lease.

![12-restore-preview.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/12-restore-preview-21f7cec8.png)

## 14. 13-restore-confirmed-lease-preserved.png

Confirmed restored value; test verifies current lease preserved.

![13-restore-confirmed-lease-preserved.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/13-restore-confirmed-lease-preserved-a4e4872d.png)

## 15. 14-merge-same-bytes-aba.png

Same-byte concurrent save still triggers revision conflict.

![14-merge-same-bytes-aba.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/14-merge-same-bytes-aba-1011e142.png)

## 16. 15-merge-repeated-conflict-result-retained.png

Repeated conflict retains edited result and requires explicit choices.

![15-merge-repeated-conflict-result-retained.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/15-merge-repeated-conflict-result-retained-ed51449a.png)

## 17. 16-merge-resolved.png

Resolved result ready for guarded merged save.

![16-merge-resolved.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/16-merge-resolved-4b9a2993.png)

## 18. 17-merged-submit-confirmed.png

Confirmed merged value after guarded submission.

![17-merged-submit-confirmed.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/17-merged-submit-confirmed-e112c7a9.png)

## 19. 18-readonly-history-no-restore.png

Read-only source permits history/diff but disables Restore.

![18-readonly-history-no-restore.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/18-readonly-history-no-restore-907c8098.png)

## 20. 19-merge-deleted-by-theirs.png

Concurrent deletion requires explicit whole-value resolution.

![19-merge-deleted-by-theirs.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/19-merge-deleted-by-theirs-f8120f95.png)

## 21. 20-merge-recreated-differently.png

Concurrent recreation produces a fresh conflict, never blind replay.

![20-merge-recreated-differently.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/20-merge-recreated-differently-bcddd14e.png)

## 22. advanced-01-lease-attached-renewing.png

Owned lease granted and attached; TableCraft renewal active.

![advanced-01-lease-attached-renewing.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/advanced-01-lease-attached-renewing-1bdae1ae.png)

## 23. advanced-02-renewal-stopped-after-owned-revoke.png

Owned lease revoked externally: full stopped reason and unpressed Keep Alive.

![advanced-02-renewal-stopped-after-owned-revoke.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/advanced-02-renewal-stopped-after-owned-revoke-966d4611.png)

## 24. advanced-03-watch-put-delete-private-export.png

Actual retained PUT and DELETE with successful private JSONL export.

![advanced-03-watch-put-delete-private-export.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/advanced-03-watch-put-delete-private-export-c2f0a26f.png)

## 25. advanced-04-scoped-private-import-export.png

Native-granted scoped JSON import/export restores visible roundtrip value; task label may lag.

![advanced-04-scoped-private-import-export.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/advanced-04-scoped-private-import-export-43122ab2.png)

## 26. advanced-05-temporary-user-private-credentials.png

Temporary user created through private write-only credential flow; deleted by test.

![advanced-05-temporary-user-private-credentials.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/advanced-05-temporary-user-private-credentials-553d47f0.png)

## 27. advanced-06-visual-txn-roundtrip-not-executed.png

Visual Then value after roundtrips to text; test verifies no execution.

![advanced-06-visual-txn-roundtrip-not-executed.png](https://raw.githubusercontent.com/tranphucbol/table-craft/feature/evidence-110-etcd/completion/advanced-06-visual-txn-roundtrip-not-executed-d0504a4d.png)
