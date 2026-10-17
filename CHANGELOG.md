# Changelog

Format: newest first. Versions are git tags; every tag has a GitHub release with `checksums.txt`.
Builds before `v0.1.0` were numbered `panel-rN` (see the releases page).

## Unreleased — audit fixes (docs/audit/BUG_REPORT_2026-10-17.md)

Fixes for the 61 findings of the 2026-10-17 code audit, plus the Sentinel addon. IDs (C1, H4, …) refer to the report.

### Upgrade notes (behaviour changes)
- **Reverse proxy on the same server (nginx/Caddy):** loopback is no longer trusted for `X-Forwarded-For` by default. Add `Environment=TRUSTED_PROXY_IPS=127.0.0.1` to `gre-panel` (`systemctl edit gre-panel`), or every visitor is seen as 127.0.0.1. The generated proxy configs say so.
- **Peer Link** works best with both servers updated: the peer API is now also served at the fixed prefix `/_hp` (peer secret only; bare 404 otherwise). An old peer is still reached when its full panel URL (with its base path) is entered as Peer URL.
- **Updates and installs fail closed** when `checksums.txt` cannot be fetched from github.com itself; set `GRE_PANEL_ALLOW_UNVERIFIED_UPDATE=1` to accept the risk.
- **Connectivity Rescue** no longer activates on its own; it shows the banner, and auto-activation is a separate opt-in toggle.
- **`hashem watchdog off`** turns off alerts only; the `hashem-watchdog` timer keeps running scheduled backups, scheduled restarts and Auto-Pool.
- Editing an FRP peer's ports on the Iran server no longer touches `frps-N.toml`; apply the ports on the foreign server too.
- The benchmark reports KCP/QUIC as "Not measured" and never recommends them; Apply refuses Backhaul/Bagher (use Switch Engine / the Bagher page).
- The peer limit is 10 everywhere (`GRE_MAX_PEERS` overrides it in the panel and in `hashem.sh`).

### Security
- 2FA, terminal and TLS settings were wiped from `panel.json` on every restart of a licensed panel (C1).
- The stored password hash was accepted as the password (C2).
- Peer-supplied SSH keys could add an unrestricted root key or delete all root keys (C4, L18).
- License deactivation did not stick (H10); `X-Forwarded-For` via loopback bypassed the login lockout and terminal allowlist (H11).
- Downloads: checksum manifest only from GitHub, verified install in `hashem.sh`, no mirrors for unverifiable files (H12).
- WSS carrier refuses to run without a token (M12); revpath firewall fix limited to the peer IP (M10); token files are 0600 (M15); inline handlers can no longer be broken out of (L10, L11).
- Backup encryption key can be exported (`hashem backup key`, panel with password re-check) (M6).

### Fixed
- Panel crash `concurrent map iteration and map write` in the cluster code (C3).
- Peer Link reported "Connected" while every call landed on the login page (H1); status writes no longer clobber settings (M13).
- frpc restarted every minute by two competing Auto-Pool controllers (H2); editing Iran peer ports broke frps (H3).
- Switch Engine: real ports only, GRE inner address, kcp/quic listeners, Backhaul v2 schema, health check and rollback (H4).
- Web terminal closed after 30 s without output (H5); installer killed after 60 s (H7); `add-peer --frp-transport` rejected (H8).
- Benchmark faked UDP/loopback results and Apply could leave the two ends on different carriers (H9, L13, L14).
- Let's Encrypt certificate is renewed and reloaded without dropping the HTTPS connection (M7).
- `hashem cluster revert`, `panel-port|user|path`, `setup-foreign --bundle bh1_/gh1_`, `install_panel` stop/overwrite order, update restarting every tunnel, `fuser -k`, removal of unrelated tunnels, ephemeral port clashes, foreign control-port check (M1–M5, M18–M21).
- Private/CGNAT address reported as the public IP (M8); 5-second snapshot running ssh-keygen and IP lookups (M9); Doctor on GRE-less servers (M11); per-proxy options lost on port edits (M14); cluster UI fields (M16); bundles with default GRE IPs (M22).
- Plus L1–L9, L12, L15–L17, L19–L23 (error codes, telegram settings, backup dir, alerts after re-enable, LimitNOFILE source, fleet history, release-list caching, …).
- **Sentinel addon:** install/start/stop/uninstall errors are reported, the chosen port is honoured, concurrent installs are refused, credentials and URL are correct.

## v1.3.3 — downgrade list covers every release

### Changed
- The **Install a specific version (downgrade)** picker (`GET /api/releases`) now lists every published release of the channel, not just the newest 20. The panel pages the GitHub API (100 per page, up to 1000 releases).

## v1.3.2 — downgrade to any of the last 20 releases

### Added
- **Install a specific version from the Update tab** (`Install a specific version (downgrade)` picker, backed by `GET /api/releases`): choose any of the last 20 releases of the active channel and install it, newer or older. Downgrades keep the same safety as updates (SHA256 `checksums.txt` verification, `panel.json` preserved, automatic rollback on failure).
- `POST /api/update {"tag":"v1.1.0"}` now installs that exact release even if it is older than the running build; without a tag the behaviour is unchanged (newest of the channel).
- CLI `hashem update [tag]` (e.g. `hashem update v1.1.0`, `hashem update panel-r140`): validates the tag, then runs the normal update flow pinned to it. Plain `hashem update` still follows the channel's newest.

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
