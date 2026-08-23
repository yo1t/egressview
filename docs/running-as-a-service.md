# Running the Hub as a service

> [Japanese / 日本語](running-as-a-service.ja.md)

The Hub runs an **event-loop watchdog** on a worker thread. `better-sqlite3` is
synchronous, so one pathological query can block the whole process — the kind
of failure that looks like an outage rather than a slow page. When the main
thread stops answering past the stall threshold (default 120s,
`EGRESSVIEW_WATCHDOG_STALL_MS`), the watchdog sends the process an unblockable
SIGKILL.

**That is only a good trade if something restarts it.** Everything on this page
exists to make sure something does. Run the Hub under a supervisor, or do not
rely on the watchdog.

## systemd

[`deploy/egressview.service`](../deploy/egressview.service) is the supported
unit. Paths and the user in it are placeholders.

```bash
sudo install -m 0644 deploy/egressview.service /etc/systemd/system/
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now egressview
```

Two directives are not preferences:

| Directive | Why |
|---|---|
| `Restart=always` | There is no exit code the Hub uses to mean "do not come back", and `on-failure` alone can read a SIGKILL as a clean exit |
| `StartLimitIntervalSec=0` | systemd otherwise gives up after **5 restarts in 10 seconds** and leaves the unit failed. That is exactly what a persistent pathological query produces — **turning a repeating stall into a permanent outage.** Restarting slowly for ever is the better failure: the service answers between restarts, and the log says why |

## Containers

[`Dockerfile`](../Dockerfile) is the production image. `Dockerfile.demo` is not
it: that one ships a synthetic database and runs write-protected.

```bash
docker build -t egressview .
```

```bash
docker run -d --restart=on-failure:10 --init -p 3000:3000 -v egressview-data:/data --env-file .env egressview
```

- **`--restart` is not optional**, for the reason at the top of this page. An
  image cannot restart itself.
- **`--init`** gives the container a real PID 1, so signals and process reaping
  behave.
- **State lives on the volume.** The image carries no database: one that could
  would take one machine's traffic record into every copy of it. `/data` holds
  the database, backups and configuration.
- The `HEALTHCHECK` polls **`/readyz`**, not `/healthz`. The first says the
  process answers; the second says the database and its migrations are usable,
  which is what a supervisor should act on.

CI builds this image on every change, starts a container from it, waits for it
to report ready, and checks the database is on the volume rather than in the
image. **An untested Dockerfile in a repository is the claim of a supported
artifact without the support.**

## Checking the supervision actually works

Do this once, on a machine you can afford to interrupt. Nothing else proves it.

```bash
sudo systemctl show egressview -p Restart -p RestartSec -p StartLimitIntervalSec
```

```bash
sudo kill -9 "$(systemctl show egressview -p MainPID --value)"
```

The service should be answering again within `RestartSec`. If it is not,
the watchdog is not defence in depth on this host — it is a way of stopping
the Hub.
