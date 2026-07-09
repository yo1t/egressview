# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in this repository.

## Language policy

- **Source code comments**: English only (`//`, `/* */`, and SQL `--` comments in `.js` files).
- **Git commit messages**: English only.
- **Conversation with the user**: Japanese (per user preference), unless the user asks otherwise.
- **Exceptions — do not translate these, they are not comments**:
  - `public/js/i18n.js` and `src/i18n-server.js` — these are the actual ja/en UI translation data. Translating the `ja:` entries would break the Japanese UI.
  - User/operator-facing strings: log messages, error responses returned to API callers, Slack notification templates, CLI startup output (`process.stderr.write`, etc.). These are content, not comments.
  - Test `it()` / `describe()` names and `assert()` messages, unless the user asks for those too — they appear in CI output and were kept as Japanese in the existing test suite by explicit decision.

If you add new code with a comment, write it in English from the start. If you touch a file that still has an old Japanese comment nearby, translating it in passing is fine but not required.
