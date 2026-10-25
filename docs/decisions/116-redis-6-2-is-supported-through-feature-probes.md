# 116: Redis 6.2 is supported through feature probes, not version branches

Status: Accepted

## Decision

The Redis plugin supports servers from 6.2 on, standalone and cluster, with one code path. At
connect it reads `redis_version` from every node (the lowest wins) and keeps a `RedisFeatures`
record (`plugins/redis/src/features.ts`); only that record decides between a command and its
fallback:

| 7.0+ feature                       | On 6.2                                                         |
| ---------------------------------- | -------------------------------------------------------------- |
| `COMMAND DOCS`                     | the committed 7.4 snapshot, limited to commands the server has |
| subcommand entries in `COMMAND`    | a committed table of container subcommand flags                |
| `INFO` with several sections       | one plain `INFO`, split locally                                |
| `CONFIG GET` with several params   | one call per parameter                                         |
| `EXPIRETIME`, `EXPIRE` NX/XX/GT/LT | never used; Set TTL sends `PEXPIRE`, `PEXPIREAT`, `PERSIST`    |
| `HTTL` (7.4)                       | no hash `ttl` column                                           |
| `CLUSTER SHARDS`                   | not used on any version; nodes come from `CLUSTER NODES`       |

Below 6.2 the connect fails with "Redis 6.2 or later is required (server is 6.0.20)."
`plugins/redis/scripts/command-docs.ts` regenerates the snapshot and the subcommand table from
a 7.4 server. The db suites run the contract on 7.4 and 6.2, standalone and cluster, and
`test/db/redisVersions.test.ts` covers each fallback.

## Rationale

6.2 is still common on managed services and long-term distributions, and node-redis 6 speaks
RESP3 to it in both modes. The gaps are all in introspection, not in data commands, so a probe
record keeps the fallbacks in a handful of places instead of version checks across the plugin.
6.2 is the floor because `SCAN … TYPE`, `GETDEL` and RESP3 `HELLO` are needed.

## Consequences

- A 6.2 server completes from 7.4's documentation, so a summary may describe a newer form of a
  command; arguments the server rejects fail at run time as usual.
- A new 7.x-only feature needs a probe in `RedisFeatures` and a version case.
- Dropping 6.2 is a later decision, made when the suites stop running it.
