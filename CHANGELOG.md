# Changelog

## Unreleased (dev, plan r24 — docs/PLAN_IMPROVEMENTS_R24.md)

### Correctness
- Engine switch checks the binary and systemd unit **before** stopping anything, reports write/restart errors instead of "configured and started", and writes configs 0600.
- Backhaul config is read with a real TOML scanner (IPv6, comments, quoted `=`/`#`, multi-line arrays, sectioned dialect).
- Per-peer `backhaul-server-N` units are recognised.
- Doctor understands Backhaul failures (`E-BH-01..03`); the watchdog judges Backhaul by its control-channel session, not unit state.
- Panel logs mask tokens and passwords.

### Security
- Escalating login lockout, audit of every mutating API call, `GET /api/audit`, log rotation.
- Optional TOTP 2FA with recovery codes; optional idle session timeout.
- Terminal: password/2FA re-auth with a single-use ticket, IP allowlist.
- `install.sh` verifies the script (canonical source, mirror quorum, or pinned sha256).

### Operations
- Webhook/Telegram alerts on state change only; 24 h link history + graph; optional Prometheus `/metrics`.
- Backups cover all configs; safer restore with pre-restore safety copy.
- Carrier advisor (advice only), free-port and SNI suggestions.

### Maintenance
- New `ci.yml` (vet, build, `go test -race`, gofmt on changed files, shell tests); fixed two data races found by `-race`.
- UI script moved from `index.html` to `app.js`; `spoof_test.py` moved to `tools/`.
