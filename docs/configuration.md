# Configuration

**What you get from this page:** the settings you cannot reach from the settings screen — the ones that have to be in place before the process starts, such as which port to listen on and where to keep the database.

**You can skip this** if EgressView is running on its default port with its database beside the program. Everything else — routers, data sources, notifications, authentication — is configured in Settings in the browser, and nothing here is needed to get there.

## Where settings live

Settings are stored in `.egressview.json`, created automatically next to the program and excluded from git. It holds what you set in the browser, so **you do not normally edit it by hand**.

Environment variables exist for the settings that have to be decided before the process starts. Where both exist, the environment variable wins.

| Variable | Default | What it decides |
|----------|---------|-----------------|
| `PORT` | `3000` | The port the web interface listens on. Change it when something else already uses 3000 |
| `SUBPATH` | — | Serve under a path such as `/egressview` instead of the root, so a reverse proxy can host several applications on one hostname |
| `EGRESSVIEW_DB` | `.egressview.db` | Where the history database lives. Point this at a larger or more durable disk before history grows |
| `EGRESSVIEW_HISTORY_HOT_MAX` | `100000` | How many recent connections stay in memory. Lowering it reduces memory use; **history is not lost either way**, because everything retained is in SQLite |
| `POLL_INTERVAL_MS` | `60000` | How often the ASUS access point is polled, in milliseconds |
| `ROUTER_IP` | `192.168.1.1` | The ASUS address used before you set one in Settings |
| `YAMAHA_IP` / `YAMAHA_USER` / `YAMAHA_PASS` | — | Lets a Yamaha router be configured without opening Settings — useful when deploying from a script |
| `YAMAHA_NAT` | `100` | The NAT descriptor to read. Auto-detect fills this in for you, so you rarely set it here |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug`. Raise it to `debug` while diagnosing a router that will not connect |

Agent ingest and API rate limits have their own variables, described in the [authentication guide](authentication.md).

## Checking memory use

`GET /api/connections/memory` reports current RSS, heap usage, hot-cache size, the configured limit, and the number of persisted rows, so you can tell whether `EGRESSVIEW_HISTORY_HOT_MAX` needs to come down before the machine runs short. It requires an administrator credential and **returns counts only — no traffic details**.
