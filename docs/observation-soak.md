# Observation consistency soak check

This check originally gated the v5 removal of the legacy
`connections.source` column. Keep running it after migration to validate the
observation junction's structural integrity and router collection health. The
tracked script contains no credentials or host-specific paths. Runtime
configuration and results must remain outside Git.

## EC2 configuration

Create `~/.config/egressview/soak.env` with mode `0600`:

```dotenv
EGRESSVIEW_DB_PATH=/absolute/path/to/.egressview.db
EGRESSVIEW_SOAK_URL=http://127.0.0.1:3000
EGRESSVIEW_SOAK_TOKEN=replace-with-the-admin-token
EGRESSVIEW_BUILD_COMMIT=replace-with-the-deployed-git-commit
EGRESSVIEW_SOAK_OUTPUT=/absolute/path/to/.egressview-soak.jsonl
EGRESSVIEW_SOAK_REQUIRED_KINDS=yamaha,cisco
EGRESSVIEW_SOAK_API_TIMEOUT_SECONDS=30
```

Do not commit this file. `EGRESSVIEW_SOAK_TOKEN` is sent only to HTTPS URLs or
localhost HTTP URLs. The output contains router IDs and timestamps, but never
router IP addresses, usernames, passwords, or tokens.

Test one run manually:

```sh
node --env-file=$HOME/.config/egressview/soak.env scripts/check-observation-consistency.js
```

Install this crontab entry using absolute paths. `flock` prevents overlapping
runs; choose a minute that does not coincide with backups:

```cron
17 3 * * * flock -n /tmp/egressview-soak.lock /usr/bin/node --env-file=/home/ec2-user/.config/egressview/soak.env /absolute/path/to/scripts/check-observation-consistency.js >> /absolute/path/to/egressview.soak.log 2>&1
```

The process exits with status `1` for a mismatch, stale/missing Yamaha or Cisco
collection, unknown commit, API error, DB error, or output error. Monitor cron
failures separately; a missing daily record must not count as success.
An operational failure such as an API timeout remains in the audit log but does
not reset the consistency streak when a successful check on the same build
recovers within 36 hours. Readiness remains blocked while it is unrecovered.
The router-status API timeout defaults to 30 seconds and may be configured from
1 to 300 seconds. Keep enough headroom for a large, busy database without
hiding a sustained application outage.

Each run also prints a `summary`. Its streak resets after a validation failure,
a version/commit change, or a gap longer than 36 hours between successful
checks. `readyForV5` becomes true only after the check gates below and two
distinct process start times prove that a normal service restart occurred
during the window.

## Historical v5 gate

Proceed only after at least three successful checks on three different UTC
dates. Every successful record must have zero `missing`, `orphans`,
`underMerged`, and `kindMismatches`, with recent successful collection from
both Yamaha and Cisco. Include at least one normal service restart. A validation
failure, version or commit change, or a gap longer than 36 hours between
successful checks restarts the soak window. After v5 migration, retain these
records as deployment evidence and continue monitoring the structural counters.
