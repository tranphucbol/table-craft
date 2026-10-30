#!/bin/sh
set -eu
etcdctl --endpoints=https://etcd-tls:2379 --cacert=/etcd/server.crt \
  --cert=/tls/client.crt --key=/tls/client.key put /seed/probe 1
touch /tmp/seeded
exec sleep infinity
