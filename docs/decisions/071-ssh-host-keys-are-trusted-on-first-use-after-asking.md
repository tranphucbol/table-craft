# 071: SSH host keys are trusted on first use, after asking

Status: Accepted

## Decision

Every SSH connection checks the server's host key before it signs in (plan 036).

- Trusted keys live in `<userData>/ssh_known_hosts.json`
  (`{ "version": 1, "hosts": [{ "host", "algorithm", "key", "addedAt" }] }`, host as OpenSSH writes
  it: `bastion` on port 22, `[bastion]:2222` otherwise). `~/.ssh/known_hosts` is read too, hashed
  entries included, and never written.
- A known key connects. An unknown key asks: the engine posts `engine.host-key` to main, main asks
  the focused window over `ssh.host-key-prompt`, and the "Unknown SSH host key" dialog shows the
  server, the key type and the `SHA256:` fingerprint with Cancel (the default) and Trust. The
  answer comes back over `ssh.answer-host-key` and `engine.host-key-answer`. Trust records the key
  and connects; Cancel fails `sshHostKeyUnknown`. With no window to ask, the key is refused.
- A changed key refuses to connect, `sshHostKeyChanged`, naming the presented and the recorded
  fingerprints and the file that records the old one. The user removes that line to accept the new
  key; the app never offers to replace it.
- Main rules: the engine asks and waits, so the probe's timeout and the SSH handshake's timeout
  stop while the question is open. Two engines offering the same key at once get one question.

## Rationale

Accepting any key would let anyone on the path read the database password and every row. Refusing
unknown keys would make the first connection to a new bastion impossible without editing a file.
Asking once and remembering, as OpenSSH does, is what users already know; reading their own
`known_hosts` means a bastion they already use does not ask again. A changed key is the one case an
attacker produces, so it gets no button.

The file is main's because main owns the user's files and windows; the engine stays a worker that
asks (decision 002), and the renderer only sees the fingerprint, never a secret.

## Consequences

- The question crosses two seams: the parent port (engine and main) and the bridge (main and
  renderer). Actions are blocked while the dialog is open, as for the secret prompt.
- There is no UI to list or forget trusted keys; editing `ssh_known_hosts.json` does it.
- Certificate authorities (`@cert-authority`) and `@revoked` markers in `known_hosts` are skipped.
