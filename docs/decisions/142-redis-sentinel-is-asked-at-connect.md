# 142: Redis Sentinel is asked at connect; a failover is a lost connection

Status: Accepted

## Decision

Redis Sentinel is a third **Mode** of the Redis plugin, beside Standalone and Cluster. Host and
Port name one Sentinel and **Other sentinels** the rest; **Master name** names the monitored
master; **Sentinel username** and **Sentinel password** are the Sentinels' own login, apart from
the data login. Database applies as in Standalone, and Node address map as in Cluster (decision
114): Sentinel hands out the addresses the master and replicas announce.

The plugin discovers the master itself, following the Redis Sentinel client guidelines: ask each
Sentinel in turn `SENTINEL GET-MASTER-ADDR-BY-NAME`, map the answer, connect, and check `ROLE`
says `master`. It does not use node-redis's `createSentinel`, which pools and switches clients
behind the session. The Sentinels are asked only at connect; the session's connection is a plain
standalone one to the master.

A failover reaches the session as a lost connection: Sentinel kills the clients of the demoted
master, the next command sees `connectionLost` before it is sent, and the engine reconnects
(decision 054), which asks the Sentinels again. A command that reaches the old master after its
demotion fails with `READONLY`; the plugin then destroys that client and reports
`statementFailed`, not `connectionLost`, so nothing is re-sent behind the user's back and the next
Run reconnects. The replicas, read from the master's `INFO replication`, are the session's other
nodes, so Run on and the Server tab reach them.

SSH tunnels are refused in Sentinel mode, as in Cluster mode: a tunnel reaches the Sentinel, not
the master it names.

`visibleWhen.equals` in the plugin API accepts a list of select values (API 1.10.0), so one field
can show in two of three modes.

## Rationale

The Sentinels only know where the master is; the data never flows through them. Holding one
plain connection keeps every standalone path (transactions, `SELECT`, sessions, cancel) unchanged,
and the host already knows how to reconnect a lost session. Watching `+switch-master` would move a
session between two commands without the user seeing it, which is wrong inside `MULTI`. Tunnels
stay one per datasource (decision 070).

## Consequences

- A failover costs the user at most one failed command, never a silent rerun.
- The renderer tells a cluster from a primary with replicas by slots, not by node count.
- Not done: `+switch-master` subscription, discovering Sentinels with `SENTINEL SENTINELS`, a
  Sentinel admin view, SSH, a `redis+sentinel://` URL.
- Amends decision 114.
