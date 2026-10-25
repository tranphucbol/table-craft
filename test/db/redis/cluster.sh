#!/bin/sh
# A test cluster in one container (compose.yml): one node per port of CLUSTER_PORTS (`first-last`),
# each announcing 127.0.0.1 and the port it listens on, so the addresses the cluster reports are
# the ones published on the host. Primaries take the first third of the nodes when
# CLUSTER_REPLICAS is 1, all of them when 0. Seeds through `redis-cli -c` (seed.sh), then marks /tmp/seeded.
set -eu
. /redis/users.sh
. /redis/seed.sh
FIRST=${CLUSTER_PORTS%-*}
LAST=${CLUSTER_PORTS#*-}
PORTS=$(seq "$FIRST" "$LAST")
# Not /data: the image declares it a volume, which a recreate keeps, and a stale nodes.conf makes
# `--cluster create` refuse the nodes.
for port in $PORTS; do
  mkdir -p "/tmp/cluster/$port"
  # shellcheck disable=SC2086
  redis-server --port "$port" --dir "/tmp/cluster/$port" --cluster-enabled yes --cluster-config-file nodes.conf \
    --cluster-announce-ip 127.0.0.1 --save "" --appendonly no --daemonize yes $USERS
done
trap 'for port in $PORTS; do redis-cli -p "$port" shutdown nosave >/dev/null 2>&1 || true; done; exit 0' TERM INT
for port in $PORTS; do
  until redis-cli -p "$port" ping >/dev/null 2>&1; do sleep 0.1; done
done
NODES=$(for port in $PORTS; do printf '127.0.0.1:%s ' "$port"; done)
# shellcheck disable=SC2086
redis-cli --cluster create $NODES --cluster-replicas "${CLUSTER_REPLICAS:-0}" --cluster-yes
for port in $PORTS; do
  until redis-cli -p "$port" cluster info | grep -q 'cluster_state:ok'; do sleep 0.2; done
done
seed redis-cli -c -p "$FIRST"
touch /tmp/seeded
while :; do sleep 3600 & wait $!; done
