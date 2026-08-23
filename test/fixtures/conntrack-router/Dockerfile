# A Linux router with real conntrack, for CI (P2-91).
#
# The conntrack collection path — SSH in, work out where the table lives, read
# it, parse it — was only ever exercised against hardware, which meant it was
# not exercised at all in CI. This produces the same kind of table a real
# router keeps, in a container, so a regression in that path is caught before
# somebody's router finds it.
#
# It is deliberately not the local development fixture: nothing here reaches
# the internet, and the login is generated per run rather than committed.
FROM ubuntu:24.04

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      openssh-server \
      iptables \
      conntrack \
      iproute2 \
      netcat-openbsd \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd

# Reading conntrack needs root or CAP_NET_ADMIN, which is how the real
# OpenWrt / ASUS / Ubiquiti devices are reached too.
RUN sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# CKV_DOCKER_2 asks for one, and it is genuinely useful here: the test's first
# failure was connecting before sshd was serving. This reports the same thing
# the workflow waits for.
HEALTHCHECK --interval=2s --timeout=3s --start-period=2s --retries=20 \
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/22; head -c 4 <&3 | grep -q SSH-'

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
