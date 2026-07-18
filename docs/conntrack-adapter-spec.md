# Conntrack adapter scope (P2-31)

## Stage 1: parser contract

EgressView accepts Linux IPv4 conntrack output from either of these commands,
in order:

1. `cat /proc/net/nf_conntrack`
2. `conntrack -L`

The parser reads the first (origin) tuple and ignores the second NAT reply
tuple. It supports TCP, UDP, and ICMP sessions whose origin is an RFC 1918
address. The normalized result uses the existing router adapter session shape:
`proto`, `src`, `sport`, `dst`, `dport`, and `ttl`. ICMP uses its identifier as
`sport` and `0` as `dport`.

IPv6, GRE, CGNAT-only source ranges, non-private origins, malformed entries,
accounting counters, and conntrack marks are outside stage 1. Duplicate runtime
keys `(src, dst, dport, proto)` are collapsed, keeping the entry with the
longest remaining timeout.

Fixture addresses are synthetic RFC 5737/RFC 1918 values and contain no output
from a production router.

## Later stages

SSH collection requires root or `CAP_NET_ADMIN` on common OpenWrt, ASUS, and
Ubiquiti systems. A later PR will add the stateful SSH adapter, TOFU host-key
handling, command fallback, reconnect behavior, settings UI, and router-manager
registration. Formal support requires sanitized output from at least one real
device family; the Docker reproduction proves the Linux format but not vendor
authentication or firmware behavior.
