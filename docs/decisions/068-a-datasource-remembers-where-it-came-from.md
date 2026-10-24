# 068: A datasource remembers where it came from

Status: Accepted.

## Decision

`datasources.json` gains an optional `origin: { app: "datagrip" | "tablepro", id }` on an imported
datasource: the app it came from and that app's id for it (DataGrip's uuid, TablePro's id or
export reference). The file stays at version 1; an absent key means made in TableCraft. Saving from
the Data Sources dialog keeps it; duplicating does not copy it.

The import preview marks a connection whose origin matches an existing datasource as already in
TableCraft. Without an origin it falls back to the same plugin, host, port, database, user and path.

## Rationale

Re-running an import is how a user picks up connections added in the other app since. Matching by
address alone misses a datasource the user has since renamed or pointed elsewhere, and flags two
genuinely different connections that share a server. The other app's id is stable across both.

An optional key keeps every existing file valid without a migration, so the file stays at
version 1.

## Consequences

- Nothing but the import reads `origin`; it never reaches a plugin or the engine.
- An older build's strict schema rejects the key, so opening a profile with imported datasources
  in an older build sets `datasources.json` aside as corrupt, as it would any newer file.
- Deleting an imported datasource forgets its origin, so the next import offers it again.
