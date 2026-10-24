# 069: The must-have release amends the v1 scope

Status: Accepted

## Decision

Decision 014 lists what v1 ships and decision 039 added the daily-friction release. The must-have
release adds these features, one plan each (plans 036 to 048):

| Plan | Feature                                                                     |
| ---- | --------------------------------------------------------------------------- |
| 036  | SSH tunnels (moved forward from decision 014's **v1.1**)                    |
| 037  | SSL/TLS certificate files: CA, client certificate and key                   |
| 038  | Per-datasource startup SQL and transaction isolation level                  |
| 039  | Dump and restore through `pg_dump` / `pg_restore` and `mysqldump` / `mysql` |
| 040  | Export and import data source definitions                                   |
| 041  | SQL files on disk: open, save, save as, rename, run a script file           |
| 042  | Error location in the editor, and Run All that can continue past errors     |
| 043  | Grid helpers: selection aggregates, transpose, BLOB files, typed editors    |
| 044  | Custom keyboard shortcuts                                                   |
| 045  | Sessions and processes view                                                 |
| 046  | Run a function or procedure with arguments                                  |
| 047  | Users, roles and grants in the explorer                                     |
| 048  | Triggers and events in the explorer                                         |

Decision 014's **v1.1** list keeps "saved query files" only in the sense plan 041 delivers; SSH
tunnels leave it. Its **Later** list is unchanged.

## Rationale

Decision 014 says features outside its list need the record updated, not just a plan. Thirteen
plans run in three parallel tracks; one amendment that names them all, written by the coordinator
before any session starts, keeps the sessions from editing the same record and conflicting on
merge.

## Consequences

- Each of plans 036 to 048 cites this record for its scope instead of amending decision 014.
- A feature dropped from the release is struck from this table, not from decision 014.
- Signed and notarized macOS builds are not in this release: they need a Developer ID the project
  does not hold yet.
