# 116: Redis 5.0 is supported through feature probes, not version branches

Status: Accepted (amended by plan 060: the floor moved from 6.2 to 5.0)

## Decision

The Redis plugin supports servers from 5.0 on, standalone and cluster, with one code path. At
connect it reads `redis_version` from every node (the lowest wins) and keeps a `RedisFeatures`
record (`plugins/redis/src/features.ts`); only that record, and the protocol the connect
negotiated, decide between a command and its fallback.

The plugin opens with RESP3 (`HELLO 3`). A server that does not know `HELLO` (before 6.0) is
reopened with RESP2, and `plugins/redis/src/resp2.ts` reshapes the replies whose RESP3 form the
plugin relies on (`HGETALL`, `CONFIG GET`, `MEMORY STATS`, `XINFO`, the `WITHSCORES` forms and
scores) into that form, for the console and the plugin's own reads alike. A Username on a server
without ACL users fails the connect with "This server has no ACL users (Redis before 6.0): leave
Username empty and use the password."; it is never dropped silently.

| Feature                            | Without it                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| RESP3 `HELLO` (6.0)                | RESP2, replies reshaped to their RESP3 form                                  |
| ACL users (6.0)                    | password alone; a Username is refused at connect                             |
| `SCAN … TYPE` (6.0)                | `SCAN` alone, then `TYPE` per key to filter                                  |
| `SET … KEEPTTL` (6.0)              | `PTTL` read under `WATCH`, then `SET` and `PEXPIRE` in the `MULTI`           |
| exclusive `XRANGE (id` (6.2)       | not used on any version; the next window starts at the successor id          |
| `COMMAND DOCS` (7.0)               | the committed 7.4 snapshot, limited to commands and arguments the server has |
| subcommand entries in `COMMAND`    | a committed table of container subcommand flags                              |
| `INFO` with several sections (7.0) | one plain `INFO`, split locally                                              |
| `CONFIG GET` several params (7.0)  | one call per parameter                                                       |
| `EXPIRETIME`, `EXPIRE` NX/XX/GT/LT | never used; Set TTL sends `PEXPIRE`, `PEXPIREAT`, `PERSIST`                  |
| `HTTL` (7.4)                       | no hash `ttl` column                                                         |
| `CLUSTER SHARDS` (7.0)             | not used on any version; nodes come from `CLUSTER NODES`                     |

Completion drops commands, subcommands and argument tokens whose `since` is newer than the
server, so a 5.0 server is not offered `KEEPTTL`.

Below 5.0 the connect fails with "Redis 5.0 or later is required (server is 4.0.14)."
`plugins/redis/scripts/command-docs.ts` regenerates the snapshot and the subcommand table from
a 7.4 server. The db suites run the contract on 7.4, 6.2 and 5.0, standalone and cluster, and
`test/db/redisVersions.test.ts` covers each fallback.

## Rationale

6.2, and 5.0 in older estates (a QC cluster runs 5.0.3), are still common on managed services
and long-term distributions; node-redis 6 speaks RESP3 to 6.x and RESP2 to 5.0 in both modes.
The gaps are in introspection, reply shapes and a few options, not in data commands, so a probe
record and one reshaping module keep the fallbacks in a handful of places instead of version
checks across the plugin. 5.0 is the floor because it brings streams, `CLIENT ID` and
`CLIENT UNBLOCK`, which Cancel and the Sessions view need; 4.0 lacks all three.

## Consequences

- An older server completes from 7.4's documentation, so a summary may describe a newer form of
  a command; arguments the server rejects fail at run time as usual.
- A new version-only feature needs a probe in `RedisFeatures` and a version case.
- A RESP2 server's console shows the same rows as a RESP3 one only for the reshaped commands;
  others show RESP2's flat arrays.
- Dropping a version is a later decision, made when the suites stop running it.
