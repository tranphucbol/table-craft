# 153: Data sources export to a sealed JSON file

Status: Proposed

## Decision

TableCraft writes data source definitions to its own JSON document,
`{ "format": "table-craft-datasources", "version": 1, "exportedAt", "folders", "datasources", "secrets"? }`,
and reads it back through the Import Data Sources preview as a fourth source, `tablecraft`.

- A record is the `datasources.json` record (decision 010) without `lastServer` (decision 131).
  The datasource from `TABLE_CRAFT_DATASOURCE` (decision 018) is never exported.
- Passwords go in only when the user asks and types a passphrase of at least 8 characters twice.
  Main reads them from the secret store, derives a key with scrypt (N = 2^17, r = 8, p = 1, 16-byte
  salt) and seals them with AES-256-GCM (12-byte IV). The file records the scrypt cost it was
  sealed with, so a later build can raise it and still read older files. The renderer never sees a
  secret (decision 020); the passphrase crosses IPC once and is never stored or logged.
- An encrypted file can be read without its passphrase, leaving its passwords out: only the
  passwords are sealed, so the rest of the file is no secret.
- Reading is field by field: a field this build does not know or cannot read is dropped with a
  warning instead of costing the data source; a higher `version` is refused with an update hint.
- An imported record keeps its `origin` (decision 068), or takes `{ app: "tablecraft", id }` with
  its id in the file, so importing the same file twice finds the duplicates the way the other
  importers do.
- Agent access (`agentAccess`, `agentSchemas`, `agentRowCap`, `agentTimeoutSeconds`) is never
  imported; the row warns that it is off.
- Copy and paste in the Database tool window carry the same document without `secrets` through the
  clipboard; the renderer reads the clipboard and sends the text to the same preview.

## Rationale

Users moving to a new computer, or sharing a team's servers, had to retype every data source.
Copying `datasources.json` by hand loses the passwords, which live in the OS keychain through
`safeStorage` and cannot leave the machine, and carries machine-local state.

A passphrase is the only key two machines share without an account or a server. scrypt is in
Node's `crypto`, so no dependency comes with it, and its memory cost makes guessing a short
passphrase expensive; AES-256-GCM's tag doubles as the wrong-passphrase check. Encrypting the whole
file was rejected: names, hosts and folders are what a teammate needs to see before choosing what
to import, and a file without passwords should stay readable in any editor.

Agent access is a decision about this machine's agents and this user's trust; importing it would
let a file widen what an agent can reach without anyone choosing it here.

Reusing the import preview, rather than a separate restore flow, keeps one place that decides
duplicates, unknown plugins, folders and the top folder, and paste gets it for free.

## Consequences

- `IMPORT_APPS` gains `tablecraft`; the scanners keep their own `SCANNED_APPS`, since a TableCraft
  file is only ever picked or pasted.
- The file format is versioned on its own; a change that older builds cannot read bumps `version`.
  New optional record fields need no bump, since older builds drop them with a warning.
- Two new invoke channels, `datasources.export` and `datasources.copy`, and a `text` source and a
  `skipSecrets` flag on `import.preview`.
- An imported password keeps its mode from the file unless the mode is Forever and this machine
  cannot encrypt; then it falls back to the default mode, as a new data source does.
