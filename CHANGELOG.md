# Changelog

Format: newest first. Versions are git tags; every tag has a GitHub release with `checksums.txt`.
Builds before `v0.1.0` were numbered `panel-rN` (see the releases page).

## Unreleased — Dashboard redesign

- **Status hero:** one card answers "is the tunnel up": Healthy / Degraded / Down / Not set up, the first reason when it is not healthy, this server ⇄ the other server with their IPs and the engine chips (GRE, FRP, Backhaul, Bagher; GRE is not shown as a fault on engines that do not use it), and latency rated Good / Fair / High instead of always "Optimal".
- **Live traffic:** download and upload rates are the numbers; the lifetime total is a footnote. A separate Connections card shows the current count and the peak over the chart range.
- **Charts:** colors come from the theme tokens and match the legend (the connections legend was violet on a green line). A stopped tunnel greys the history instead of drawing it red. The axis uses round values in one unit (20 / 15 / 10 MB/s, not 18.6 GB/s and 512 KB/s), and rescales at once after a spike. The connections chart says what it counts: established TCP/UDP connections on the server.
- **Details:** no green "Stable / Zero Drops" and red "Down" before anything is set up; GRE and engine cards appear only when they exist; Role shows Iran/Foreign server (it never matched before); failover reads Automatic / Manual; times are local.
- **System:** CPU, RAM and disk as ring gauges colored by load, with uptime.
- **Tunnels table** for multi-peer hubs: status, foreign IP, engine, ports, ping and traffic per peer; a row opens its card in the Tunnel tab.
- Layout follows the space the dashboard has (container queries), so the activity side panel no longer squeezes it; works at 375px and in RTL.

## v2.3.6 — 2026-10-18

Audit fixes, a Persian UI, and working Bagher, Diagnostics and engine switch. Update both servers.

### Upgrade notes (this release)
- **Bagher:** after updating, re-apply the bundle from the Bagher tab on the foreign server once. Its frpc config is only rewritten then (the old one made frpc exit at start). The Iran key line in `authorized_keys` is tightened automatically when the panel starts; other keys are not touched.
- **iPerf3** (Diagnostics) now listens on the GRE address only, not on every address.
- **Switch Engine** from the Iran server switches the linked foreign server too and says whether it did.

### Bagher, Diagnostics and Tunnel tab
- Bagher carried no data: the generated frpc config had an frps-only field, so frpc exited on start. Tested end to end in a three-namespace lab (`tests/test_bagher_lab.sh`, now in CI).
- Security: the Iran key could run commands as root on the foreign server and open forwards to any local service there. It is now limited to its one reverse forward.
- Live engine switch always failed with `invalid engine ""` (request field name mismatch). The foreign side is now told and waited for (40 s), and the result is shown.
- Diagnostics: no more false "MTU fragmented" on every GRE server (it probed 1420/1400 on a 1380 interface); ping now runs inside the tunnel and, separately, to the peer's public IP; Backhaul and Bagher servers are judged by their own engine instead of scoring 20/100; issues and their fixes no longer drift apart; Quick Repair adds the installer's MSS rule and restarts a stopped engine.
- Tunnel tab: Restart on Backhaul servers restarted a non-existent frps; Copy Bundle never showed; GRE cards on GRE-less servers; Bagher shown as active when only enabled; carrier and engine switches now ask first; Restore shows whenever a backup exists.
- Dashboard: throughput chart spikes when the traffic source changed; Details values overflowing their cards; Diagnostics showing login errors as tunnel errors. Live Activity Stream is a structured event feed. Browser tab icon and a premium tier mark.

### Design review (Apple HIG) and Persian UI

Review of the panel UI against Apple's Human Interface Guidelines, then fixes in seven phases.

#### Upgrade notes
- **FA mode is now Persian.** It used to switch the layout to right-to-left but keep English text. Switching language reloads the page.
- **Theme follows the system** until you pick one with the theme button.
- Before a tunnel is set up the dashboard and Diagnostics show a neutral "Not set up" state instead of red errors.

#### Fixed
- Contrast: white text on the default blue was 3.6:1, light-theme status colors 2.3–3.7:1, several badges and the login button below 4.5:1. Every tab now passes 4.5:1 in both themes.
- A Bagher button referenced a function that did not exist; the error stopped `app.js` during load, so Sentinel, Cluster, license and later handlers never initialised. Two more missing handlers defined.
- Six dialogs ignored Escape and did not keep keyboard focus; all nine now do.
- Performance, Settings and Benchmark scrolled sideways on phones; the light-theme chart tooltip was unreadable; the login page stayed dark in the light theme; undefined CSS variables rendered square corners and missing borders; the Diagnostics repair button could not be hidden.
- Benchmark recommended a carrier that never answered (0/100, 100% loss); it now says no carrier answered and what to check.

#### Changed
- Design tokens for every color (about 500 hard-coded colors replaced), 12px text floor, tabular figures, quieter depth (no glows or hover lifts), one primary button per card, Title Case buttons.
- Emoji replaced by an SVG icon set; 470 inline styles moved to utility classes; 26 fields gained accessible labels.
- Topbar link strip: this server ⇄ the other side · engine · latency, with one live dot.

### Audit fixes (docs/audit/BUG_REPORT_2026-10-17.md)

Fixes for the 61 findings of the 2026-10-17 code audit, plus the Sentinel addon. IDs (C1, H4, …) refer to the report.

#### Upgrade notes (behaviour changes)
- **Reverse proxy on the same server (nginx/Caddy):** loopback is no longer trusted for `X-Forwarded-For` by default. Add `Environment=TRUSTED_PROXY_IPS=127.0.0.1` to `gre-panel` (`systemctl edit gre-panel`), or every visitor is seen as 127.0.0.1. The generated proxy configs say so.
- **Peer Link** works best with both servers updated: the peer API is now also served at the fixed prefix `/_hp` (peer secret only; bare 404 otherwise). An old peer is still reached when its full panel URL (with its base path) is entered as Peer URL.
- **Updates and installs fail closed** when `checksums.txt` cannot be fetched from github.com itself; set `GRE_PANEL_ALLOW_UNVERIFIED_UPDATE=1` to accept the risk.
- **Connectivity Rescue** no longer activates on its own; it shows the banner, and auto-activation is a separate opt-in toggle.
- **`hashem watchdog off`** turns off alerts only; the `hashem-watchdog` timer keeps running scheduled backups, scheduled restarts and Auto-Pool.
- Editing an FRP peer's ports on the Iran server no longer touches `frps-N.toml`; apply the ports on the foreign server too.
- The benchmark reports KCP/QUIC as "Not measured" and never recommends them; Apply refuses Backhaul/Bagher (use Switch Engine / the Bagher page).
- The peer limit is 10 everywhere (`GRE_MAX_PEERS` overrides it in the panel and in `hashem.sh`).

#### Security
- 2FA, terminal and TLS settings were wiped from `panel.json` on every restart of a licensed panel (C1).
- The stored password hash was accepted as the password (C2).
- Peer-supplied SSH keys could add an unrestricted root key or delete all root keys (C4, L18).
- License deactivation did not stick (H10); `X-Forwarded-For` via loopback bypassed the login lockout and terminal allowlist (H11).
- Downloads: checksum manifest only from GitHub, verified install in `hashem.sh`, no mirrors for unverifiable files (H12).
- WSS carrier refuses to run without a token (M12); revpath firewall fix limited to the peer IP (M10); token files are 0600 (M15); inline handlers can no longer be broken out of (L10, L11).
- Backup encryption key can be exported (`hashem backup key`, panel with password re-check) (M6).

#### Fixed
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
