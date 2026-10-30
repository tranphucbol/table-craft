# 137: Sensitive operations use private host channels, and consoles admit commands before history

Status: Accepted

## Decision

Files, passwords and console text that could carry a secret never travel over the ordinary
renderer↔engine port as data the renderer controls.

- **Files are opaque one-use grants.** For a snapshot, a key export or import, or a Watch export,
  the renderer calls `chooseOperationFile(datasourceId, operation)`; main shows the native dialog
  and returns an opaque grant ID bound to the window, the engine, the port's main-generated
  `ownerId` and the operation. The renderer never sends or sees a path. Grants are one-use and
  expire after five minutes. The engine streams through main over private utilityProcess
  messages (`file.publish`, `file.read.*`, `stream.*`), 64 KiB at a time. Main writes to a private
  temporary file and publishes it with an atomic no-overwrite link only after a clean end and a
  final OK status; a snapshot also has its trailing SHA-256 checksum verified. Imports open with
  no-follow and are refused for read-only data sources.
- **Secrets are write-only.** A user's new password goes through `applyAccessSecret` straight to
  main, which hands the bytes to the owning engine's private `secret.apply` and zeroes them after
  the acknowledgement. Nothing returns the password, and it never enters an engine call, Services,
  history, Output, results or logs; failures carry fixed text with no driver cause. Saved
  connection passwords are never fetched into the renderer.
- **Consoles admit before they record.** A command console asks the engine `commands.admit` for
  the exact frozen text of a run before confirmation, Services, history, Output or results. The
  plugin's `CommandLanguage.admit` answers `execute`, `omitHistory`, `managed` (with trusted,
  plugin-parsed arguments) or `reject`. `user add <name>` and `user passwd <name>` open the secure
  password prompt and leave no trace of the text; `watch`, `lease keep-alive`, lease grant and
  revoke, access, cluster and snapshot commands open their manager instead of running.
  `statement.execute` and `script.run` refuse anything admission would not execute, so a caller
  that skips the step still cannot run it. Any error or off-contract answer rejects the whole run.

## Rationale

The renderer is the least trusted process (decisions 002 and 020): a path it names could
overwrite any file the user can, and a password it relays could land in history or logs. Binding
grants to the authenticated sender and operation keeps file authority in main, which already owns
the dialogs. Rejecting a password while executing is too late, because the renderer records a run
before it executes; only an admission step ahead of every recording path keeps it out.

## Consequences

- Replacing an existing file is unsupported; the user picks a new name.
- Port replacement, navigation, renderer loss, host exit and quit revoke grants and pending
  private requests. Cancelling after the atomic link cannot undo a published file.
- Ordinary queries keep the direct engine port; only these operations pass through main.
- Compaction revisions and member IDs typed in the console are not carried into the manager it
  opens; the user enters them there.
