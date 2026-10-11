# Changelog

Format: newest first. Versions are git tags; every tag has a GitHub release with `checksums.txt`.
Builds before `v0.1.0` were numbered `panel-rN` (see the releases page).

## v1.3.1 — rescue card always visible

### Fixed
- **Connectivity Rescue card now always shown** on the Tunnel tab. It was hidden until a one-way block was detected, so the Iran hub (the reachable/entry side) had no way to open **Join with code** and paste an `hrc1_…` rescue code.

## v1.3.0 — panel access control

### Added
- **Panel access settings** (Settings card + `GET/POST /api/access` + CLI `hashem panel-port|panel-user|panel-path`): change the HTTP port (1-65535, tunnel/reserved-port conflict checks), login username, and URL base path. Current password required; response carries the new URL and the UI redirects after `gre-panel` restarts. Tunnels untouched.
- **Custom SSL certificate install** (Settings + `POST /api/tls/custom` + `hashem panel-tls-custom <cert> <key>`): paste PEM, upload both files (multipart), or point at server paths. Pair validated with `tls.X509KeyPair` before anything is written; atomic backup/rollback; HTTPS reloads in-process.
- **Self-signed HTTPS on the server IP** (Settings + `POST /api/tls/ip` + `hashem panel-tls-ip [IP]`): persistent local CA (10 years) signs an 825-day server cert with the IP as SAN. `GET /api/tls/ip/ca` downloads the CA to install once in browser/OS. Regenerate rotates only the server cert so trust survives.

## v1.2.0 — traffic that stays

### Added
- **Per-server traffic ledger kept 7 days on disk** (`traffic_peers.json`): one point per minute for the hub total, the main tunnel and every foreign-server peer, plus per-day totals. It survives panel restarts, updates, crashes and reboots.
- `GET /api/traffic/usage?range=1h|6h|24h|7d` (admin session) and a **Traffic usage** card on the Tunnel tab: hub total, a 7-day bar chart and a per-server received/sent table.

### Fixed
- Traffic no longer disappears when the kernel counters restart. `/proc/net/dev` counters go back to zero when a GRE interface is recreated, a tunnel is removed and re-added, or the host reboots; the ledger stores per-interval deltas, treats a lower reading as a counter reset, and keeps its baseline across a gap so a returning interface does not produce a spike.
- Peers are keyed by id, so renaming a peer keeps its history.
- systemd log spam `Got notification message from PID n, but reception only permitted for main PID`: child processes (ping, ip, ss, systemctl) inherited `NOTIFY_SOCKET`. It is now removed from the panel's environment at start.

### Documentation
- Added `README.fa.md` (the language link in the README was broken), a Requirements section, an engine comparison, Troubleshooting, an Uninstall-and-your-data section and Known limitations.
- New guides: `docs/ENGINES.md`, `docs/TROUBLESHOOTING.md`; generated references `docs/API.md` (every route, its auth) and `docs/ERROR_CODES.md` (every `E-…` code), produced by `tools/gen_docs.py`; CI fails if they drift from the code.
- Added `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue forms and a pull request template.
- README: removed the dashboard screenshots, kept the architecture diagrams; documented installing with a pinned `HASHEM_SHA256`; password storage now described correctly as argon2id (README and SECURITY.md said SHA-256).
- Moved `AUDIT_REPORT.md` and `AUDIT_CHECKLIST.md` to `docs/audit/` and `CLAUDE.md` to `docs/dev/DEVELOPMENT.md`; the repository root now holds only the project files.

## v1.1.0 (2026-10-11) — plan r24 (docs/PLAN_IMPROVEMENTS_R24.md)

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

## v1.0.0 (2026-10-10) — first stable-channel release

### Added
- FRP transports `tcp`, `kcp`, `quic`, `websocket`, `wss` with payload encryption, compression and PROXY Protocol v2; Persian UI with RTL layout; Fleet health and topology map.
- Update channels `stable` / `dev`: pick, upgrade or downgrade to any of the last 20 releases; `hashem update-channel`.
- Auto Pool: frpc `poolCount` / frps `maxPoolCount` sized from pool-full errors, load and RAM (on by default).
- Reverse-path auto-fix engine (dry-run by default, snapshot / apply / re-probe / rollback), per-tunnel health checks (PASS / FAIL / UNREACHABLE), multi-signal link health (session > TCP > ICMP) with debounce.
- Dial over the Iran hub's public IP when GRE is dead (`hashem dial`); hub-and-spoke topology view with the main tunnel as a plain spoke.
- TCP multiplexing toggle in the Performance tab and `hashem perf tcpmux` (off by default); `/api/selfstats`, in-process load lab, RAM-scaled unit limits and sd_notify watchdog.
- Connectivity Rescue: detect one-way TCP blocks and reverse the dial direction.

### Security
- Fail-closed SHA-256 verification of updates; CI publishes `checksums.txt` (M-01).
- WSS carrier rejects browser origins, constant-time token compare (M-02).
- argon2id password hashing with transparent upgrade of legacy hashes; random session ids (M-03).
- Security headers, server timeouts, request body limit, peer TLS pinning (TOFU).

### Fixed
- Removed obsolete `hashem-monitor` / `hashem-webui` units that crash-looped on old installs (H-01).

### Removed
- Chaff, DPI Shield and the FOU carrier.

## v0.71.0 and v0.7.2 (2026-10-07)

- Release builds bundling FRP `0.71.0` and Backhaul `0.7.2` respectively; the only change between them is the release signature text.
- Backhaul integration, live engine switcher, carrier switching made strictly manual, watchdog `auto_restart` default off.

## v0.1.3 (2026-09-30)

- Fixed the traffic chart reset; added a live speed KPI.

## v0.1.2 (2026-09-30)

- Fixed GRE routing instability when foreign servers share an IP; fixed bundle token parsing; peer limit raised to 10.

## v0.1.1 (2026-09-29)

- Performance overhaul: ping reduced from about 200 ms to 100 ms.

## v0.1.0 (2026-09-29)

- Simplified the installation flow; credentials are shown at the end of install.
