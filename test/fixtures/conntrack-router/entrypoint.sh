#!/bin/bash
# Builds a NAT table that looks like a router's, without leaving the container.
#
# The development fixture generates traffic to public addresses. This one does
# not: CI should not depend on the internet being reachable, and a test that
# fails because 1.1.1.1 was slow teaches nothing.
set -eu

# The password arrives from the environment, generated per run by the workflow.
# Nothing here is committed, so there is no credential in the repository.
: "${ROUTER_PASSWORD:?ROUTER_PASSWORD must be provided}"
echo "root:${ROUTER_PASSWORD}" | chpasswd

sysctl -w net.ipv4.ip_forward=1 >/dev/null
modprobe nf_conntrack 2>/dev/null || true

UPLINK=$(ip -o -4 route show default | awk '{print $5; exit}')
iptables -t nat -A POSTROUTING -s 10.99.0.0/16 -o "${UPLINK}" -j MASQUERADE

# A sink inside the container, so the "outside" the clients reach is local.
nc -lk -p 9000 >/dev/null 2>&1 &
SINK_IP=$(ip -o -4 addr show "${UPLINK}" | awk '{print $4}' | cut -d/ -f1)

make_client() {
  ns="$1"; addr="$2"; idx="$3"
  ip netns add "$ns"
  ip link add "veth-$idx" type veth peer name "vc-$idx"
  ip link set "vc-$idx" netns "$ns"
  ip addr add "10.99.$idx.1/24" dev "veth-$idx"
  ip link set "veth-$idx" up
  ip netns exec "$ns" ip addr add "$addr/24" dev "vc-$idx"
  ip netns exec "$ns" ip link set "vc-$idx" up
  ip netns exec "$ns" ip link set lo up
  ip netns exec "$ns" ip route add default via "10.99.$idx.1"
}

make_client lan1 10.99.0.100 0
make_client lan2 10.99.1.100 1

# Regular intervals, because that is also what beacon detection is looked at
# against. Short, because CI should not wait five minutes for a second sample.
for ns in lan1 lan2; do
  ( while true; do
      ip netns exec "$ns" bash -c "echo hello > /dev/tcp/${SINK_IP}/9000" 2>/dev/null || true
      sleep 5
    done ) &
done

# Give the first entries time to appear, so a poller that connects immediately
# does not read an empty table and call it a parse failure.
sleep 3
exec /usr/sbin/sshd -D -e
