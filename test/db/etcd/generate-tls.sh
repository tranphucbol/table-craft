#!/bin/sh
# The shared CA's signing key is deliberately discarded; keep this server's trust anchor separate.
set -eu
cd "$(dirname "$0")"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 36500 \
  -subj '/CN=localhost' -keyout server.key -out server.crt \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'subjectAltName=DNS:localhost,DNS:etcd-tls' \
  -addext 'extendedKeyUsage=serverAuth'
chmod 644 server.crt server.key
