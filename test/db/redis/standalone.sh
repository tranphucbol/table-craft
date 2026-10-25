#!/bin/sh
# A standalone test server (compose.yml): starts redis-server, seeds databases 1 and 0 from
# /seed, and keeps the server in the foreground. REDIS_TLS=1 serves TLS only, with the test CA.
set -eu
. /redis/users.sh
. /redis/seed.sh
CLI="redis-cli"
LISTEN="--port 6379"
if [ "${REDIS_TLS:-}" = "1" ]; then
  LISTEN="--port 0 --tls-port 6379 --tls-cert-file /tls/server.crt --tls-key-file /tls/server.key --tls-ca-cert-file /tls/ca.crt --tls-auth-clients optional"
  CLI="redis-cli --tls --cacert /tls/ca.crt"
fi
# shellcheck disable=SC2086
redis-server $LISTEN --save "" --appendonly no $USERS &
SERVER=$!
trap '$CLI shutdown nosave >/dev/null 2>&1; wait $SERVER' TERM INT
until $CLI ping >/dev/null 2>&1; do sleep 0.1; done
$CLI -n 1 </seed/redis-db1.redis >/dev/null
# shellcheck disable=SC2086
seed $CLI
wait $SERVER
