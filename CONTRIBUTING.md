# Contributing to EgressView

Thank you for your interest in contributing! Issues and pull requests are welcome — in English or Japanese (日本語での issue / PR も歓迎です).

## Before you start

- **Bug reports / small fixes**: open an issue or PR directly.
- **Major changes** (new features, new router support, architectural changes): please open an issue first so we can discuss the approach before you invest time.

## Development setup

### Option A — Demo mode (no router required)

If you don't have a Yamaha RTX router, start in demo mode. It pre-seeds 160 realistic sample connections and uses a fixed admin token so every UI feature is immediately accessible:

```bash
git clone https://github.com/yo1t/egressview.git
cd egressview
npm install
DEMO_MODE=true DEMO_ADMIN_TOKEN=my-dev-token npm start
```

Open `http://localhost:3000` and enter `my-dev-token` when the admin token prompt appears. No login password is needed in demo mode — use the token directly. All tabs, filters, graphs, and the connection log work with the seeded data.

> The `DEMO_ADMIN_TOKEN` value can be any string you like; it is only used to authenticate against the local demo instance.

### Option B — With a real router

```bash
git clone https://github.com/yo1t/egressview.git
cd egressview
npm install
npm start
```

Requirements: Node.js 22+. No build step — the frontend is plain HTML/CSS/JS served by Express.

On first startup, both an API/admin token and an initial login password are printed to the console. Open `http://localhost:3000` and log in with the initial login password; the API/admin token is for scripts and automation.

## Tests

```bash
npm test                  # unit tests (no hardware required) — run these before every PR
npm run test:integration  # opt-in tests against a real router (RUN_INTEGRATION=1)
npm run test:smoke        # Playwright browser smoke tests (auto-uses demo mode in CI)
npm run test:fuzz         # short fuzz campaign over the router/syslog parsers
npm run test:fuzz:long    # 50k-iteration campaign; run when touching a parser
npm run security:check    # production dependency audit + secret scan before publishing
```

The fuzz tests feed generated and mutated input to every function that parses
router CLI output, syslog lines or conntrack tables, and assert that it does
not throw, returns within a time budget, and returns its declared shape. Each
run prints its seed; reproduce a failure with `FUZZ_SEED=<value> npm run test:fuzz`.

CI (GitHub Actions) runs unit tests on Node 22, 24 and 26 (Maintenance LTS, Active LTS, and Current), the short fuzz campaign, Playwright smoke tests in demo mode (no hardware needed), and release safety checks (`npm audit --omit=dev` and secret scan). PRs must be green.

### `npm audit` does not cover bundled C libraries

`better-sqlite3` vendors the SQLite amalgamation into its own source, so SQLite
is not an npm package from the auditor's point of view. **A SQLite CVE will
never appear in `npm audit`, `npm run security:check`, or the ASH scan.** The
same applies to any future dependency that bundles C code.

Check it by hand at release time:

- [SQLite change log](https://www.sqlite.org/changes.html) for the versions between the one shipping and the current release
- [Debian security tracker for sqlite3](https://security-tracker.debian.org/tracker/source-package/sqlite3) for CVEs and which version fixes each

To see the version actually running, ask the built module rather than the
package manifest, since the bundled SQLite moves independently of the npm
version:

```bash
node -p 'require("better-sqlite3")(":memory:").prepare("select sqlite_version() v").get().v'
```

On a server, run that with the **same Node binary the service uses**
(`readlink -f /proc/$(pgrep -f "node .*server.js" | head -1)/exe`). A different
major version fails with `ERR_DLOPEN_FAILED` on the native module, which looks
like a broken install but is only an ABI mismatch in the shell you happen to be
in.

When judging whether a SQLite CVE applies, check whether the affected feature is
even compiled in — several CVEs are in optional extensions:

```bash
node -p 'require("better-sqlite3")(":memory:").prepare("pragma compile_options").all().map(r => r.compile_options).join("\n")'
```

### A prebuilt native module can pass CI and still not run in production

Native modules ship prebuilt binaries per platform, and each binary is linked
against the glibc of whatever image built it. glibc symbol versioning is
backward compatible only: a binary needing `GLIBC_2.38` will not load on a host
that provides 2.35, and the failure is at `require()` time.

CI runners are x64 while the deployment host is aarch64, so the two do not
exercise the same binary. better-sqlite3 13.0.2 shipped an arm64 prebuild
requiring `GLIBC_2.38`; CI was green and the server could not start.

Before accepting a native-module update, compare the prebuild against the host:

```bash
# What the prebuild demands (match the platform/arch the server runs;
# layout varies -- better-sqlite3 flattens it to prebuilds/linux-arm64.node)
find node_modules/<pkg>/prebuilds -path '*linux-arm64*' -name '*.node' \
  -exec sh -c 'strings "$1" | grep -o "GLIBC_[0-9.]*" | sort -uV | tail -1' _ {} \;

# What the host provides
ldd --version | head -1
```

If the first is higher than the second, the update cannot be deployed no matter
what CI reports.

### Install scripts are disabled

`.npmrc` sets `ignore-scripts=true`, so `npm ci` runs no dependency install
scripts. This is needed because better-sqlite3 13.x ships a `binding.gyp`
without an install script, and npm reads a bare `binding.gyp` as an implicit
`node-gyp rebuild` — it would compile SQLite from source on every install even
though the package bundles a prebuilt binary for the platform, and a host
without Python and a C++ toolchain could not install at all. It also stops
every other dependency from running code at install time.

Two dependencies lose an optional native build as a result, both harmless here:
`ssh2` falls back to its pure-JS crypto path (router polling is not
throughput-bound) and `fsevents` is not built, so macOS file watching polls
during development.

The bundle installer sets the same flag through `npm_config_ignore_scripts`
rather than relying on `.npmrc`, because `npm pack` strips `.npmrc` from the
tarball. A unit test pins that.

The consequence to remember: installing now requires a bundled prebuild for the
host. better-sqlite3 covers darwin, linux, linuxmusl, and win32 on arm64 and
x64. On anything else, install a toolchain and run `npm ci --ignore-scripts=false`.

## Guidelines

- **Add tests for new behavior.** Pure logic lives in `src/` modules with matching files in `test/unit/`. Modules take their dependencies via an `init(deps)` / factory pattern so they can be tested with stubs — follow the existing style (see `src/runtime.js` and `test/unit/runtime.test.js`).
- **Use the logger, not `console.*`,** in `src/` modules: `const logger = require('./logger')`.
- **Validate API input** with the helpers in `src/utils.js` (`parseTimestamp`, `parsePositiveInt`, `isAllowedRouterIp`) rather than ad-hoc `parseInt`/`Number` calls.
- **UI strings need both languages.** Any user-visible text goes through `public/js/i18n.js` — add the key to **both** the `ja` and `en` dictionaries (a unit test enforces parity).
- **Never commit real network data.** Use documentation addresses in code comments, tests, and fixtures: `192.0.2.x` / `198.51.100.x` / `203.0.113.x` (RFC 5737), `2001:db8::/32` (RFC 3849), and obviously-fake MAC addresses (`aa:bb:cc:dd:ee:ff`). No real LAN IPs, device MACs, hostnames, or credentials — even in log samples.

## Router support contributions

EgressView currently supports Yamaha RTX (NAT session polling via SSH). Support for conntrack-based routers (ASUS router mode, OpenWrt, Ubiquiti UDM) is planned — see [ROADMAP.md](ROADMAP.md). If you own one of these devices and can test against real hardware, that is one of the most valuable contributions you can make. Please open an issue to coordinate.

## Contributor License Agreement (CLA)

EgressView is **dual-licensed**: it is offered to the public under the AGPL-3.0
and, where appropriate, under a separate commercial license (see the
[License section of the README](README.md#license)). To keep this possible, the
Maintainer must hold the rights to relicense every contribution.

**By submitting a contribution to this project — for example, by opening a pull
request — you agree to the [Contributor License Agreement (`CLA.md`)](CLA.md)**,
under which you assign copyright in your contribution to the Maintainer
(Yoichi Takizawa), with a fallback license grant and a license-back to you so
you can keep using your own work. Please read [`CLA.md`](CLA.md) before you
submit; no separate signature or form is required — submitting the contribution
is your acceptance.

The project itself remains available to the public under the **AGPL-3.0**
(see [LICENSE](LICENSE)).

> 🇯🇵 プルリクエスト等で貢献を提出した時点で、[`CLA.md`](CLA.md)（著作権譲渡型 CLA）に
> 同意したものとみなされます。これによりメンテナは EgressView を AGPL-3.0 と商用ライセンスの
> デュアルライセンスで提供できます。提出前に [`CLA.md`](CLA.md) をご確認ください。
