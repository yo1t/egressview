# Router Poller Adapters

EgressView reads L3/L4 sessions through a router poller adapter. The current
production adapter is Yamaha RTX, but the server uses a small generic contract
so other router families can be added without changing the UI, database schema,
or connection history pipeline.

## Contract

Adapters are validated by `src/pollers/router-interface.js`.

Required methods:

- `configure(cfg)`
- `connect(onReady)`
- `disconnect()`
- `reconnect()`
- `isEnabled()`
- `isReady()`
- `fetchSessions()`
- `refreshArp()`
- `refreshNdp()`
- `needsArpRefresh()`
- `needsNdpRefresh()`
- `getArpCache()`
- `getArpMac(ip)`
- `getNdpByMac(mac)`
- `getIp()`
- `getUser()`
- `hasPass()`
- `getNat()`
- `getHostFp()`
- `exec(cmd, timeoutMs)`
- `detect(opts)`
- `detectCurrent(opts)`

`fetchSessions()` must return normalized session objects:

```js
{
  proto: 'TCP',
  src: '192.168.1.10',
  sport: 54321,
  dst: '203.0.113.10',
  dport: 443,
  ttl: 300
}
```

## Current Adapter

`src/pollers/yamaha-adapter.js` wraps the existing Yamaha SSH implementation in
`src/pollers/yamaha.js`.

The adapter also keeps the previous Yamaha-specific method names
(`connectYamaha`, `fetchNatSessions`, `refreshYamahaArp`, and related aliases)
so existing routes and helpers can migrate gradually.

## Adding Another Router Family

1. Add a parser with fixture-based unit tests.
2. Add an adapter that implements the contract above.
3. Keep raw command output parsing separate from session normalization.
4. Avoid changing the connection history schema unless the new source truly
   cannot fit the normalized session shape.
5. Document the confirmed hardware / firmware and any unsupported modes.

Cisco and conntrack-based routers should be added as separate follow-up adapters
on top of this contract.
