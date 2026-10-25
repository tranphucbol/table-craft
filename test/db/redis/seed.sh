#!/bin/sh
# Sourced by standalone.sh and cluster.sh: `seed <redis-cli and its options>` applies
# /seed/redis.redis, writes the 5,000 `page:NNNN` keys the key tree pages through, and sets
# `seed:probe` last, which the healthchecks wait for.
PAGE_KEYS=5000
seed() {
  "$@" </seed/redis.redis >/dev/null
  awk -v n="$PAGE_KEYS" 'BEGIN { for (i = 1; i <= n; i++) printf "SET page:%04d %04d\n", i, i }' | "$@" >/dev/null
  "$@" SET seed:probe 1 >/dev/null
}
