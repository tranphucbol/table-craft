# The etcd images are distroless, so the seeder is Alpine with the server's own etcdctl.
FROM gcr.io/etcd-development/etcd:v3.6.5 AS etcd

FROM alpine:3.22
COPY --from=etcd /usr/local/bin/etcdctl /usr/local/bin/etcdctl
