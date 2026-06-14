# Contributing to Widemap

Thank you for your interest in contributing! Issues and pull requests are welcome — in English or Japanese (日本語での issue / PR も歓迎です).

## Before you start

- **Bug reports / small fixes**: open an issue or PR directly.
- **Major changes** (new features, new router support, architectural changes): please open an issue first so we can discuss the approach before you invest time.

## Development setup

```bash
git clone https://github.com/yo1t/widemap.git
cd widemap
npm install
npm start
```

Requirements: Node.js 18+. No build step — the frontend is plain HTML/CSS/JS served by Express.

On first startup an admin token is printed to the console; enter it in the browser at `http://localhost:3000`. Most features need a Yamaha RTX router to poll, but the server, UI, and tests all run without one.

## Tests

```bash
npm test                  # unit tests (no hardware required) — run these before every PR
npm run test:integration  # opt-in tests against a real router (RUN_INTEGRATION=1)
npm run test:smoke        # Playwright browser smoke tests
npm run security:check    # production dependency audit + secret scan before publishing
```

CI (GitHub Actions) runs the unit tests on Node 18 and 20, plus the release safety checks (`npm audit --omit=dev` and secret scan). PRs must be green.

## Guidelines

- **Add tests for new behavior.** Pure logic lives in `src/` modules with matching files in `test/unit/`. Modules take their dependencies via an `init(deps)` / factory pattern so they can be tested with stubs — follow the existing style (see `src/runtime.js` and `test/unit/runtime.test.js`).
- **Use the logger, not `console.*`,** in `src/` modules: `const logger = require('./logger')`.
- **Validate API input** with the helpers in `src/utils.js` (`parseTimestamp`, `parsePositiveInt`, `isAllowedRouterIp`) rather than ad-hoc `parseInt`/`Number` calls.
- **UI strings need both languages.** Any user-visible text goes through `public/js/i18n.js` — add the key to **both** the `ja` and `en` dictionaries (a unit test enforces parity).
- **Never commit real network data.** Use documentation addresses in code comments, tests, and fixtures: `192.0.2.x` / `198.51.100.x` / `203.0.113.x` (RFC 5737), `2001:db8::/32` (RFC 3849), and obviously-fake MAC addresses (`aa:bb:cc:dd:ee:ff`). No real LAN IPs, device MACs, hostnames, or credentials — even in log samples.

## Router support contributions

Widemap currently supports Yamaha RTX (NAT session polling via SSH). Support for conntrack-based routers (ASUS router mode, OpenWrt, Ubiquiti UDM) is planned — see [ROADMAP.md](ROADMAP.md). If you own one of these devices and can test against real hardware, that is one of the most valuable contributions you can make. Please open an issue to coordinate.

## License

By contributing, you agree that your contributions are licensed under the AGPL-3.0, the same license as the project (see [LICENSE](LICENSE)).
