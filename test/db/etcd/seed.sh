#!/bin/sh
# Seeds every etcd server in $ETCD_SEED_ENDPOINTS from /seed/etcd.etcd, then on $ETCD_AUTH_ENDPOINT
# makes the users and turns auth on. Safe to run again: it wipes the keys first and makes the users
# only while auth is off. Stays up afterwards so the healthcheck (and `up --wait`) sees it finished.
set -eu

PASSWORD=table_craft
LIMITED_PASSWORD=limited
ROOT="root:$PASSWORD"
# Ten years: the expiring fixture key must outlive any test container.
LEASE_TTL=315360000

# With auth off etcdctl ignores --user; with it on, 3.6 reports an anonymous health check unhealthy.
wait_for() {
  for _ in $(seq 1 60); do
    etcdctl --endpoints="$1" --user="$ROOT" endpoint health >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "etcd at $1 never answered" >&2
  exit 1
}

# Without credentials `auth status` answers only while auth is off.
auth_off() {
  etcdctl --endpoints="$1" auth status 2>/dev/null | grep -q "Authentication Status: false"
}

# etcdctl on $ENDPOINT, as root once auth is on, and quietly.
ctl() {
  if [ "$AS_ROOT" = 1 ]; then
    etcdctl --endpoints="$ENDPOINT" --user="$ROOT" "$@" >/dev/null
  else
    etcdctl --endpoints="$ENDPOINT" "$@" >/dev/null
  fi
}

put() {
  ctl put "$@"
}

seed() {
  ENDPOINT=$1
  wait_for "$ENDPOINT"
  if auth_off "$ENDPOINT"; then AS_ROOT=0; else AS_ROOT=1; fi
  ctl del "" --from-key
  if [ "$AS_ROOT" = 1 ]; then
    LEASE=$(etcdctl --endpoints="$ENDPOINT" --user="$ROOT" lease grant "$LEASE_TTL" | awk '{ print $2 }')
  else
    LEASE=$(etcdctl --endpoints="$ENDPOINT" lease grant "$LEASE_TTL" | awk '{ print $2 }')
  fi
  export LEASE
  . /seed/etcd.etcd
  echo "seeded $ENDPOINT"
}

with_auth() {
  ENDPOINT=$1
  auth_off "$ENDPOINT" || return 0
  AS_ROOT=0
  ctl user add root --new-user-password="$PASSWORD"
  ctl user grant-role root root
  ctl role add readwrite
  ctl role grant-permission readwrite readwrite "" --from-key
  ctl user add table_craft --new-user-password="$PASSWORD"
  ctl user grant-role table_craft readwrite
  ctl role add app-reader
  ctl role grant-permission app-reader read /app/ --prefix
  ctl user add limited --new-user-password="$LIMITED_PASSWORD"
  ctl user grant-role limited app-reader
  ctl auth enable
  echo "auth enabled on $ENDPOINT"
}

for endpoint in $ETCD_SEED_ENDPOINTS; do seed "$endpoint"; done
with_auth "$ETCD_AUTH_ENDPOINT"
touch /tmp/seeded
exec sleep infinity
