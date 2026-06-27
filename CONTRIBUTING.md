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
npm run security:check    # production dependency audit + secret scan before publishing
```

CI (GitHub Actions) runs unit tests on Node 22, Playwright smoke tests in demo mode (no hardware needed), and release safety checks (`npm audit --omit=dev` and secret scan). PRs must be green.

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
