# Test-only SSH keys

Every key in this directory is a throwaway for the `ssh` service in `test/db/compose.yml`, which
`bun run test:db` and the plan 036 live test tunnel through. They guard nothing; never trust them
anywhere else.

- `id_ed25519`, `id_ed25519.pub`: the client key of user `tunnel`, passphrase `tunnel-key`.
- `ssh_host_ed25519_key`, `ssh_host_ed25519_key.pub`: the server's host key, fingerprint
  `SHA256:cCEVNeTkTJOv+K7Nfi/QPhn6BJZ7yH06aEJzWF6EiAg`.

User `tunnel` also signs in with the password `tunnel`.
