# Changelog

## v1.1.0 (plan r24 — docs/PLAN_IMPROVEMENTS_R24.md)

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

### Added after the first r24 pass
- Host alerts for disk, RAM and panel TLS-certificate expiry, through the same state-change alert path (baseline tick, hysteresis, per-link gap).
- Link history now survives a panel restart (`history.json`, flushed on SIGTERM; a link must be missing 10 min before its history is dropped).
- Graceful shutdown on SIGTERM/SIGINT.

### Fixed
- **systemd watchdog kill loop**: units carried `WatchdogSec=30` while the installed panel binary predated the heartbeat, so systemd killed it every 30 s. `hashem.sh` now enables the watchdog only for a binary that implements sd_notify, and removes it otherwise.
- `setup.go` split into `setup.go`, `setup_bundle.go`, `setup_ports.go`, `setup_conf.go`, `peers_edit.go` (no code changes; all 51 declarations verified identical).
- Whole tree is gofmt-clean and CI enforces it; Backhaul e2e and GRE reverse-path labs run in CI on every push and weekly.

### Maintenance
- New `ci.yml` (vet, build, `go test -race`, gofmt on changed files, shell tests); fixed two data races found by `-race`.
- UI script moved from `index.html` to `app.js`; `spoof_test.py` moved to `tools/`.
