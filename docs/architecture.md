# EgressView Architecture

> [Japanese / 日本語](architecture.ja.md)

This document describes the production architecture and the boundaries that preserve router isolation, observation attribution, database safety, and API security.

## System view

```mermaid
flowchart LR
  subgraph Network[Home / SOHO network]
    Y[Yamaha RTX routers]
    C[Cisco IOS routers]
    A[Optional ASUS AP]
    L[Optional dnsmasq / syslog]
  end

  subgraph Server[EgressView Node.js process]
    RM[Router manager and registry]
    PS[Independent poll scheduler]
    N[Normalized sessions and runtime deduplication]
    EN[DNS / RDAP / GeoIP / threat enrichment]
    DB[(SQLite WAL\nconnections + observations + devices)]
    HTTP[Express REST API]
    WS[Socket.IO updates]
    MCP[MCP stdio / HTTP]
  end

  Y -->|SSH NAT / ARP| RM
  C -->|SSH NAT / ARP| RM
  RM --> PS --> N
  A -->|HTTP client data| N
  L -->|log events| N
  N --> DB
  N --> EN --> DB
  DB --> HTTP --> UI[Browser UI]
  N --> WS --> UI
  DB --> MCP --> AI[AI assistant]
```

## Collection and router isolation

Each configured router has an immutable `routerId`, a Yamaha or Cisco adapter that implements the common poller contract, and an independent scheduler state. EgressView supports up to 10 routers in any Yamaha/Cisco mix.

The generic scheduler staggers initial polls, enforces a per-cycle timeout, backs off repeated failures, and lets healthy routers continue when another router is unavailable. Adapters translate vendor-specific SSH commands and NAT/ARP output into the same normalized session shape before shared processing begins.

The runtime natural key is `(src, dst, dport, proto)`. When multiple routers see the same communication, EgressView deduplicates the connection while preserving every observer in `connection_observations` and exposing those stable IDs as `observedBy`. Deleted router IDs remain as tombstones so history never changes ownership.

## Data flow

1. Router adapters collect NAT sessions and address-neighbor information over SSH, normally every 60 seconds.
2. Optional INSPECT, DHCPD, dnsmasq, and ASUS sources add short-lived sessions, IP/MAC identity, hostnames, and Wi-Fi metadata.
3. The runtime merges repeated observations and queues reverse DNS, RDAP, GeoIP, OUI/device discovery, and threat-intelligence enrichment.
4. Connection history and its router observations are written atomically in one SQLite transaction. The browser receives deltas through Socket.IO and can query durable history through REST.
5. Detection, beacon, device, and notification modules derive higher-level findings from the same durable data.

## Persistence and startup

EgressView uses one SQLite database in WAL mode with separate module connections for history, sessions, devices, enrichment, and beacons. `db-bootstrap.js` is the explicit startup boundary: history owns schema migration and opens first; all other consumers open only after migration succeeds.

Migrations are append-only and fail-closed. Before a data-changing migration, EgressView checks free space, creates and validates a consistent backup, runs the migration transaction, and verifies the resulting database. Backup restore follows the same principle: validate source, require a safety backup, replace, reopen all consumers, validate the result, and roll back if any stage fails.

Backup cleanup preview and execution run in a dedicated worker thread because SQLite integrity checks are synchronous and may scan several gigabytes. The main process permits one cleanup job at a time and exposes bounded progress, cancellation, and timeout states. The worker retains the same verified-generation floors and revalidates candidates immediately before deletion; moving work off the event loop does not weaken fail-closed behavior.

Schema v5 stores router ownership only in `connection_observations`; the legacy `connections.source` column has been removed. API responses still expose a compatibility `source` value derived from the observer router kinds. The observation-consistency diagnostic checks for missing or orphaned observations and missing router metadata. Schema v6 stores append-only AI conversations; v7 stores provider-reported token usage and the USD estimate calculated at request time; v8 stores append-only scheduled, threat-triggered, manual, and delivery-test AI notification events. The validated `src/data/ai-pricing.json` catalog supplies versioned rates and source metadata, while each usage row preserves its invocation-time rates. EgressView does not infer costs for older conversations, unknown models, or responses without usage.

## Interfaces

- **Browser UI:** static single-page application with AI Insights as the start page plus authenticated Socket.IO updates.
- **REST:** 71 administration and query endpoints rooted at `/api`, plus minimal `/healthz` and `/readyz`; see the [REST API reference](api-reference.md).
- **AI providers:** explicit-action, read-only analysis through Ollama, Anthropic, OpenAI, or Amazon Bedrock; see the [AI Insights setup guide](setup-ai-insights.md) for configuration and privacy boundaries.
- **MCP:** 11 read/write tools over stdio or authenticated HTTP. Public OAuth
  staging is protected by a fail-closed publication gate that does not modify
  DNS or infrastructure; see the [MCP setup guide](setup-mcp.md).
- **Exports:** bounded streaming CSV/JSON output to avoid loading an unbounded history into memory.
- **Notifications:** optional Slack delivery; detections remain in the local notification log even when Slack is disabled.

## Security boundaries

- Router SSH targets must be RFC 1918 private IPv4 addresses. SSH host keys use trust-on-first-use and saved fingerprints detect unexpected changes.
- Router credentials and tokens stay in the local mode-`0600` configuration file; API responses expose only `passSet`/`enablePassSet` flags.
- All REST endpoints except login, token verification, and the detail-free health/readiness checks require `X-Admin-Token`. Socket.IO applies the same authentication policy.
- The server sets CSP, clickjacking, MIME-sniffing, and referrer protections; HSTS is enabled when TLS is configured.
- EgressView is not an inline network device. Polling failure does not interrupt routed traffic, and one router's failure does not stop other collectors.
- Administrators should expose EgressView only through HTTPS or a trusted VPN and should keep the application, router management interfaces, and backup files off the public Internet.

## Code map

| Responsibility | Main implementation |
|---|---|
| Process wiring, readiness, and lifecycle | `server.js`, `src/health-state.js` |
| HTTP composition and protections | `src/http-app.js`, `src/routes/` |
| Multi-router lifecycle | `src/router-manager.js`, `src/router-registry.js` |
| Poll scheduling | `src/router-poll-scheduler.js` |
| Vendor adapters | `src/pollers/yamaha-adapter.js`, `src/pollers/cisco-adapter.js` |
| Runtime normalization/deduplication | `src/runtime.js` |
| History and observation reads/writes | `src/history.js` |
| DB bootstrap and migrations | `src/db-bootstrap.js`, `src/db-migrate.js` |
| Backup inventory, worker jobs, prune, and restore | `src/backup-inventory.js`, `src/backup-prune-runner.js`, `src/backup-prune-worker.js`, `src/backup.js`, `src/routes/backup.js` |
| Browser modules | `public/js/` |
