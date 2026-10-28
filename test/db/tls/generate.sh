#!/bin/sh
# Regenerates every test-only certificate and key in this directory (see README.md).
set -eu
cd "$(dirname "$0")"

DAYS=36500
KEY_PASSPHRASE=tls-key
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

ca() {
  openssl req -x509 -new -newkey rsa:2048 -nodes -sha256 -days "$DAYS" \
    -subj "/CN=$2" -keyout "$1.key" -out "$1.crt" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
}

signed() {
  openssl req -new -newkey rsa:2048 -nodes -subj "/CN=$2" -keyout "$1.key" -out "$WORK/$1.csr"
  printf '%s\n' "$3" >"$WORK/$1.ext"
  openssl x509 -req -sha256 -days "$DAYS" -in "$WORK/$1.csr" -CA ca.crt -CAkey ca.key \
    -CAcreateserial -CAserial "$WORK/ca.srl" -extfile "$WORK/$1.ext" -out "$1.crt"
}

ca ca "TableCraft test CA"
ca wrong-ca "TableCraft wrong CA"
rm wrong-ca.key

# No IP address in the names: a test that reaches the server at 127.0.0.1 through a tunnel passes
# verify-full only when the configured host name is what gets checked.
signed server "localhost" "subjectAltName=DNS:localhost,DNS:postgres-tls,DNS:mysql-tls,DNS:redis-tls,DNS:mssql
extendedKeyUsage=serverAuth"
signed client "tc_cert" "extendedKeyUsage=clientAuth"
openssl pkcs8 -topk8 -v2 aes-256-cbc -in client.key -out client-encrypted.key -passout "pass:$KEY_PASSPHRASE"
rm ca.key

chmod 644 ./*.crt ./*.key
