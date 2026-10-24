# The bastion `bun run test:db` and the live test tunnel through (plan 036). User `tunnel` signs in
# with the password `tunnel` or the committed key `id_ed25519` (passphrase `tunnel-key`), and
# forwards to the databases by their compose service names.
FROM alpine:3.20

RUN apk add --no-cache openssh-server \
  && adduser -D -s /bin/sh tunnel \
  && echo "tunnel:tunnel" | chpasswd

COPY sshd_config /etc/ssh/sshd_config
COPY ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key
COPY id_ed25519.pub /home/tunnel/.ssh/authorized_keys

RUN chmod 600 /etc/ssh/ssh_host_ed25519_key \
  && chown -R tunnel:tunnel /home/tunnel/.ssh \
  && chmod 700 /home/tunnel/.ssh \
  && chmod 600 /home/tunnel/.ssh/authorized_keys

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
