#!/bin/sh
# A test Sentinel setup in one container (compose.yml, plan 133): over SENTINEL_PORTS (`first-last`),
# the first port is the master, the second its replica, the rest Sentinels monitoring `mymaster`
# with quorum 2. Every server announces 127.0.0.1 and the port it listens on, as cluster.sh does, so
# the addresses Sentinel reports are the ones published on the host. The Sentinels ask clients for
# the password `sentinel`; the data servers have the usual ACL users. Seeds databases 1 and 0 on the
# master as standalone.sh does, then marks /tmp/seeded once both Sentinels' peers and the replica
# are known, so a failover in a test can start at once.
set -eu
. /redis/users.sh
. /redis/seed.sh
FIRST=${SENTINEL_PORTS%-*}
LAST=${SENTINEL_PORTS#*-}
REPLICA=$((FIRST + 1))
SENTINELS=$(seq $((FIRST + 2)) "$LAST")
SENTINEL_PASSWORD=sentinel
QUORUM=2
for port in $FIRST $REPLICA; do
  mkdir -p "/tmp/sentinel/$port"
  role=""
  [ "$port" = "$REPLICA" ] && role="--replicaof 127.0.0.1 $FIRST"
  # shellcheck disable=SC2086
  redis-server --port "$port" --dir "/tmp/sentinel/$port" --replica-announce-ip 127.0.0.1 \
    --save "" --appendonly no --daemonize yes $role $USERS
done
for port in $FIRST $REPLICA; do
  until redis-cli -p "$port" ping >/dev/null 2>&1; do sleep 0.1; done
done
redis-cli -p "$FIRST" -n 1 </seed/redis-db1.redis >/dev/null
seed redis-cli -p "$FIRST"
until redis-cli -p "$REPLICA" info replication | grep -q 'master_link_status:up'; do sleep 0.2; done
for port in $SENTINELS; do
  mkdir -p "/tmp/sentinel/$port"
  cat >"/tmp/sentinel/$port/sentinel.conf" <<EOF
port $port
dir /tmp/sentinel/$port
daemonize yes
requirepass $SENTINEL_PASSWORD
sentinel announce-ip 127.0.0.1
sentinel announce-port $port
sentinel monitor mymaster 127.0.0.1 $FIRST $QUORUM
sentinel down-after-milliseconds mymaster 1000
sentinel failover-timeout mymaster 5000
EOF
  redis-server "/tmp/sentinel/$port/sentinel.conf" --sentinel
done
trap 'for port in $SENTINELS $REPLICA $FIRST; do redis-cli -p "$port" -a "$SENTINEL_PASSWORD" --no-auth-warning shutdown nosave >/dev/null 2>&1 || redis-cli -p "$port" shutdown nosave >/dev/null 2>&1 || true; done; exit 0' TERM INT
OTHERS=$(($(echo "$SENTINELS" | wc -w) - 1))
for port in $SENTINELS; do
  until redis-cli -p "$port" -a "$SENTINEL_PASSWORD" --no-auth-warning sentinel master mymaster 2>/dev/null |
    awk -v others="$OTHERS" 'prev == "num-slaves" && $0 >= 1 { slaves = 1 } prev == "num-other-sentinels" && $0 >= others { peers = 1 } { prev = $0 } END { exit !(slaves && peers) }'; do
    sleep 0.2
  done
done
touch /tmp/seeded
while :; do sleep 3600 & wait $!; done
