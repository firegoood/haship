# Changelog

Format: newest first. Versions are git tags; every tag has a GitHub release with `checksums.txt`.
Builds before `v0.1.0` were numbered `panel-rN` (see the releases page).

## Unreleased

### Cluster, rebuilt: pools, linked Iran hubs, DNS failover
The first cluster sent users' traffic straight to the foreign servers' public IPs, outside the tunnel, and its peer hubs only exchanged an unsigned status. It is replaced; `cluster.json` is upgraded by itself (the hub id and linked hubs stay, the old foreign-server list goes, with a note in the cluster's event log).
- **Pools: one Iran port, several foreign servers.** Add the foreign servers in Setup as usual with the same port (two peers may now share a port when it is in a pool), then New Pool. The relays of the pool's tunnels (frps / backhaul-server) listen on a private address (`169.254.77.N` on the `hashem-lb` interface) and kernel DNAT sends each new connection to a working one: no process in the data path, the client's real IP still reaches the relay (PROXY protocol keeps working), and a panel restart or update drops nothing. Modes: **Failover** (priority order), **Balance** (by weight, per connection), **Sticky per user** (each source IP always on the same foreign server, so its exit IP does not change; weighted rendezvous hashing, so only the users of a server that leaves move) and **Lowest latency** (moves only when another server is clearly faster for 10 s). A member can be drained for maintenance. Tunnels whose ports include a pool port join it by themselves; a removed one stays out.
- **One-second health check per foreign server.** A link is out when its control session is gone, or when it stops answering ping on the path the relay really uses (only for links that answer ping; filtered ICMP never takes a working link out). Three failed checks take it out, three good ones put it back (Settings in the tab). frpc's health check (Performance) also takes a single service out. When no member passes, the pool tries every relay that still listens rather than refusing everyone. UDP flows of a server that left are dropped from conntrack so they move at once.
- **Linked Iran hubs.** Show Join Code on one hub, Link a Hub on the other: the hubs exchange a heartbeat every 3 s, signed with the cluster secret (HMAC-SHA256, timestamp and nonce; a replay or another secret gets a plain 404). When every member of a pool is down on one hub, its port is forwarded (DNAT + MASQUERADE, Iran to Iran) to a hub where the same pool works; a hub that forwards itself is never a target, so it cannot loop.
- **DNS failover (Cloudflare).** A record that always lists the Iran hubs that work, so users who connect by name move to a working hub. Only the reachable hub with the lowest id writes it; records that are not a hub's IP are never touched, and a proxied (orange cloud) record is refused.
- **A foreign server can serve several Iran hubs** (`hashem join-hub --bundle ...`, or Cluster on the foreign server's panel): a second frpc / backhaul-client with its own GRE interface, or dialing the hub's public IP when the bundle's GRE addresses are already used. `hashem hubs`, `hashem leave-hub --id N`.
- **New Cluster tab**: pools with where traffic goes now, per-server health, latency and share; the tunnels with their one-second health; linked hubs; DNS failover; health check; the kernel rules; an event log. Pool state changes go to the alert channels (webhook / Telegram). Terminal: the Cluster menu in `hashem`, and `hashem cluster status | pool | member | join-code | add-hub | events | rules`.
- **Tested on a real kernel** (privileged container, iptables nft and legacy): balance, stickiness, failover to another port, pass-through ports, an atomic rules swap and forwarding through a DROP forward policy. Uninstall removes the rules, the interface and the extra-hub units.

### Terminal app, HTTPS certificates, Buy License
- **`hashem` is a terminal app.** Arrow keys (or j/k) move, Enter opens, a number jumps (two digits for 10 and up), Esc, q or Left goes back. Every screen has the same header: role, tunnel up or down, panel running or stopped, license, and the panel address. Each menu remembers its row. The menus follow the panel tabs: Status, Setup, Tunnel, Bagher, Cluster, Performance, Watchdog, Diagnostics, Logs, Backup, Update, Settings, Uninstall. Without a terminal (a pipe, `TERM=dumb`, `HASHEM_PLAIN=1`) the same menus are numbered prompts, and end of input leaves cleanly. Everything is English; the status marks are plain `[OK]` and `[!]` instead of emoji, which broke the alignment in many SSH clients.
- **The terminal asks for Hashem Pro where the panel does.** `hashem perf`, `hashem watchdog`, `hashem doctor` and `hashem backup now|schedule` need the license (the same check as the panel: `gre-panel license check`), and the app's Performance, Watchdog and Diagnostics menus open a page with Activate a license key and Buy a license instead. What keeps applied settings running stays free: the watchdog timer and its tick, `watchdog check`, the Auto Pool tick, `perf apply` and the update's re-apply, `doctor stop-server`, and backup restore, status and key (nobody is locked out of their own data). `hashem perf tcpmux` stays free too: a tcpMux mismatch stops a free FRP tunnel from logging in, and the error tells you to run it. The refusal names https://pdnczone.com.
- **Everything the panel does, from the terminal.** New: `hashem tls status|issue|renew|remove|ip|custom` (the Settings tab's HTTPS card), `hashem settings show|2fa off|terminal on|off|terminal-allow|idle N` (two-factor can be turned off when the phone is lost), `hashem perf proxy-protocol|bandwidth|health-check|backhaul-pool`, and menus for the cluster, backup, update channel and logs. They run the panel's own code through `gre-panel tls` and `gre-panel settings`, then restart only the panel.
- **Fixed in the terminal:** Ctrl+C in a live log quit Hashem instead of going back; the header showed `http://127.0.0.1:7777path/` (a function that did not exist, and no slash); the Performance menu printed its status over and over without clearing; `hashem panel-tls DOMAIN EMAIL` still asked for the email; `hashem license activate` stored any text as the key (it is now checked first, and a bad key never replaces a good one); the license status needed jq; "Refresh system packages" did not refresh them; the script version line was empty.
- **Let's Encrypt in Settings fixed.** certbot is installed when it is missing (apt, dnf, yum or snap) instead of an error; ports 80 and the HTTPS port are opened in ufw or firewalld; a busy port 80 names the program that holds it; the error shows certbot's reason (for example "Timeout during connect (likely firewall problem)") instead of its whole log; the certificate is named after the domain (`--cert-name`), so a second issue no longer lands in `domain-0001` while the panel reads the old one; certbot has a time limit. When DNS does not point here (a CDN, NAT) the panel asks whether to try anyway instead of stopping.
- **Renew and auto-renew follow how the certificate was made.** Renew Now regenerates an IP certificate and runs certbot for Let's Encrypt; a custom certificate cannot be renewed here (the button hides, and the API answers `E-TLS-14`). The hourly auto-renew no longer copies certbot's certificate over a custom one for the same name, nor calls certbot for IP certificates. "Renewed" now says when Let's Encrypt found it not due yet. The card names the kind of certificate.
- **The web Terminal tab stays English and left to right** in the Persian panel.
- **Donate is now Buy License.** The popup and the Settings card sell Hashem Pro and link to the site; the popup never shows once a Pro license is active. The command palette item is "Buy a Hashem Pro license", and the installer's last line points to the license.

### FRP options, PROXY protocol, Watchdog, Benchmark
- **PROXY protocol fixed.** The Edit Peer window on the Iran server had PROXY Protocol, Encryption and Compression switches that only wrote peers.json: these options live in the foreign server's frpc, so nothing changed. They are now set where they apply, in the foreign server's Performance tab (FRP Transport), and Edit Peer says so. The Join form still sets PROXY protocol at setup, and the choice is kept in perf.json, so updates (which re-apply perf.json) never drop it. A PROXY protocol chosen before this release stays as it is until it is changed here. The hints say to turn on acceptProxyProtocol in the Xray inbound first: without it every connection fails.
- **Every FRP proxy option in one place.** FRP Transport on the foreign server: encryption, compression (shown again), TCP multiplexing, PROXY protocol (off, v1, v2), a bandwidth limit per port (`transport.bandwidthLimit`, MB/s, 0 = none) and a health check (frpc closes a port on the Iran server while the local service is down). `perf apply` writes them into every `[[proxies]]` block (PROXY protocol and health check on tcp only), a new setup or an engine switch to FRP writes them too, and applying twice changes nothing. The defaults stay off: on VLESS, Reality and Trojan the first three only cost speed, and PROXY protocol breaks a service that does not expect it.
- **Watchdog: Backhaul without GRE was always "down"** on the Iran server: the check pinged a GRE peer that does not exist, which meant false Telegram alerts and, with auto-restart on, a restart loop. A healthy Backhaul session now counts on both sides, hubs whose tunnels are all added peers (`backhaul-server-N`) are checked, and the detail line says "Backhaul session up" instead of an empty GRE ping.
- **Watchdog and Benchmark are Hashem Pro** (`watchdog`, `benchmark`; every Bagher / Pro key opens them). Locked: the tabs, `/api/watchdog` (with backup download) and `/api/benchmark`. A watchdog that already runs keeps its alerts, backups, schedules, Auto Pool and dial watch without a license. Both tabs show the lock in the sidebar.
- **Buy License** in the license window and in Settings opens the Hashem site.

### Performance tab
- **Performance is Hashem Pro** (`performance`; every Bagher / Pro key opens it, no new key). Locked: the tab and `/api/perf`. Settings already applied keep working without a license: Auto Pool keeps sizing the pool from the watchdog, and an update still re-applies perf.json.
- **A lock marks every tab that needs a license** in the sidebar and the phone menu: Performance, Diagnostics and Cluster (Hashem Pro), and Sentinel (its own add-on). It hides once the key opens the tab. The license is now read right after sign-in, so the locks are right from the first page.
- **Backhaul connection pool.** A Backhaul server had nothing to tune here. The new card sets `connection_pool` on the foreign server (1 to 64, default 8): the panel rewrites that one line in the running client config and restarts `backhaul-client` only when it changed. The value is kept in perf.json (`backhaul_pool`), so a Backhaul tunnel set up later, from the panel or `hashem.sh`, is written with it. On the Iran server the card says to set it on the foreign server.
- **Only the cards of this server's engine show**: FRP Transport and Auto Pool on FRP servers, the Backhaul pool on Backhaul servers, neither before a tunnel exists. The overview follows the engine too.
- **Carrier moved to the Tunnel tab.** Direct GRE or WSS is how the tunnel gets through, not a speed setting, so it stays free and sits with the tunnel.
- **Removed:** the Proxy Compression switch (encrypted traffic such as VLESS, Reality and Trojan does not compress, so it only cost CPU; it still shows while it is on, so it can be turned off) and the Save Without Restart button (Apply & Restart Tunnels does the job; the change waits marked Unsaved until then).

### Hashem Pro
- **The Path Test, Backhaul and Diagnostics are Hashem Pro**, next to Bagher. Locked: starting or joining a path test (panel and `gre-panel pathtest`), setting up a Backhaul tunnel with or without GRE (Setup, switching the engine to Backhaul, and `hashem backhaul` / `setup-backhaul-*` / `setup-gre-backhaul-*` / `add-backhaul-peer` from the shell, which ask the panel binary: `gre-panel license check backhaul`), and the Diagnostics tab and `/api/doctor`. Each shows PRO and opens the license window naming the feature. GRE + FRP stays free.
- **No new key for existing customers.** Every license that unlocks Bagher (`bagher`, `frp_ssh`, `*`, `all`, or no feature list) unlocks every Pro feature, including ones added after it was issued; a key may also name `pathtest`, `backhaul` or `diagnostics` alone. Sentinel and Cluster keys stay separate add-ons. `/api/license` lists what the key opens (`pro_features`), and Settings shows it.
- **Running tunnels are never taken away.** A Backhaul tunnel that already runs keeps running, restarting, being repaired by the watchdog and moving between GRE and the public IP without a license; only a new setup needs it.
- **The license survives updates.** An update replaces only the binary; the key stays in `/etc/gre-panel/license.key`, `/etc/hashem/license.key` and `panel.json`, and the new binary loads it at start. A new test activates a Bagher-only key, then starts the panel again the way an update does (also with `license.key` deleted and the key only in `panel.json`): every Pro feature is open each time with nothing entered again.

### Path test before any tunnel
- **Which transports get through, before you build a tunnel.** New card at the top of the Benchmark tab. On the Iran server press Start Test: for a few minutes (10 by default) it runs throwaway servers for every transport and shows a code. Paste the code on the foreign server's Benchmark tab: it dials all of them with the real cores, the same way a tunnel would. Both panels then show one table, each row Works / Blocked with latency and speed: plain TCP and UDP, GRE (protocol 47), SSH from Iran to the foreign server (Bagher), FRP `tcp`, `websocket`, `wss`, `kcp`, `quic` and Backhaul `tcp`, `tcpmux`, `ws`, `wss`, `wsmux`, `wssmux`, `udp`. A row only says Works when data pushed from Iran came back byte-exact through that transport; a port that merely accepts is not enough. Nothing stays behind: the processes run under `timeout`, the test GRE interface (`hpt0`, keyed, so it does not touch a real GRE tunnel) and any ufw openings are removed at the end. Missing cores are downloaded once (`hashem download-cores`).
- **Safe next to a running tunnel.** Left empty, the first port is the first free block from 41000, so a tunnel already on those ports is never touched (a port you enter that is taken is refused with the reason). The test's GRE interface `hpt0` is keyed, so it lives beside the tunnel's GRE to the same server; the carrier switch and the diagnostics' GRE lookup in `hashem.sh` skip it. A ufw rule that existed before the test is kept when the test ends. The Iran side fills in the foreign IP from the running tunnel.
- Ports: the first port and the next 10, TCP and UDP, on the Iran server. Enter your real tunnel's port to test that one.
- Also from the shell: `gre-panel pathtest serve` on Iran, `gre-panel pathtest join CODE` on the foreign server; both print the table when every check has an answer.
- Checked in a new lab that runs in CI (`tests/test_pathtest_lab.sh`, real FRP v0.71.0 and Backhaul v0.7.2 in two network namespaces): with an open path all 16 checks work and every TCP transport gets a speed; with UDP, GRE and one port dropped towards Iran exactly those checks say Blocked and the rest still work; next to a live GRE + Backhaul tunnel on port 41000 the test moves to 41040 by itself, all 16 checks work and the tunnel carries data every half second all through the test without one miss; nothing is left running afterwards.

### All tunnels in one place
- **Bagher moved into Setup and Tunnel.** It had its own tab with its own role buttons, forms and status boxes. Now it is the third engine in Setup (GRE + FRP, Backhaul, Bagher): the Iran side fills in the foreign IP and ports (SSH port, user, pool and internal FRP port under a fold) and gets the bundle in the same box as the other engines; the foreign side pastes the `BAGHER:` bundle into the same bundle field as `hsh1_`/`bh1_`/`gh1_`. The Tunnel tab's Bagher card runs it: start, stop, copy bundle, quick edit, clear DNAT conflicts, remove. Old links to the Bagher tab and the Benchmark's Bagher carrier open Setup with Bagher picked. Without a license the engine shows PRO and a note with an Activate button; the license window opens on Apply, and closing it no longer sends you to the Dashboard.
- **Backhaul is one engine.** "GRE + Backhaul" and "Backhaul (No-GRE)" were two engines that only differ by the GRE underneath. Setup now has one Backhaul with "Run Backhaul over GRE? With GRE / Without GRE", and the script's Backhaul menu has one Iran setup that asks the same question. The same names everywhere: GRE + FRP, Backhaul (with GRE), Backhaul (no GRE), Bagher.
- The foreign side of Setup asks for the route to Iran (Auto, GRE only, public IP only) when the bundle uses GRE, and `hashem backhaul` has a route item.
- Switching the engine in Setup starts from that engine's own transport (Backhaul came up on `tcp` after FRP instead of `tcpmux`).

### Route to the Iran hub
- **Back to GRE by itself.** In auto mode the watchdog moved a foreign client to the hub's public IP when GRE died, but never back: the client stayed on the public IP until someone ran `hashem dial auto`. Now, after GRE carries the control port for 5 checks in a row (one a minute; ping alone is not enough, some paths pass ICMP and drop TCP), the client moves back to GRE. If it cannot connect over GRE, it returns to the public IP and waits 30 minutes before trying again, so a half-working GRE does not make the tunnel flap. UDP transports (Backhaul `udp`, FRP `kcp`/`quic`) are judged by ping.
- A Backhaul setup without GRE removes the route state an earlier GRE setup left, so the watchdog does not chase a GRE address that no longer exists.
- Checked in a new lab that runs in CI (`tests/test_tunnel_combos_lab.sh`, real Backhaul v0.7.2 and FRP v0.71.0 in two network namespaces with GRE): all 7 Backhaul transports and UDP over `tcp`, with GRE and without GRE (GRE dropped), link and data; GRE blocked at setup goes to the public IP, GRE back returns to GRE after the 5th check with data over GRE, GRE dead goes public again; the same for GRE + FRP.

### Backhaul
- **One Backhaul, inside Hashem.** The separate `hashem-backhaul.sh` ("Modified Backhaul v2.0.0-hotfix8") is gone. It wrote the sectioned v2 config, but Hashem installs upstream Backhaul v0.7.2, which stops with `neither server nor client configuration is properly set`; none of its tunnels could start. Its IPX, ICMP, TUN, anytls and xtcpmux transports need the paid Backhaul Premium core, which Hashem never shipped. `hashem backhaul` (also from the Tunnel and Quick Setup menus, and the old `hashem modified-backhaul`) now opens Hashem's own Backhaul menu: set up Iran with or without GRE, join a foreign server from a bundle, status with the real link state, logs (tokens hidden), restart, and the bundle for the foreign server.
- **Old tunnels move in by themselves.** `hashem backhaul-migrate`, which the panel also runs once at start, turns each `backhaul-iranN` / `backhaul-kharejN` from the old script into Hashem's `backhaul-server` / `backhaul-client` with the same port, transport, token and ports, so the panel, watchdog, backup and uninstall see it. A tunnel on a transport the core lacks is retired with a notice; its config is kept in `/etc/backhaul/legacy`. A tunnel whose core really is v2.x is left alone.
- **More than one port from the menu works.** The menu wrote `"443 2083"` as one entry, and the core refused to start. Ports may now be separated by commas or spaces everywhere.
- **The port forms the core accepts:** `443`, `10000-10050`, `2083=8443`, `10000-10050=443`, with an optional `IP:` on either side, in the menu, CLI and panel. `10000-10050:443` (from Backhaul's README, rejected by the core) is rewritten to `10000-10050=443`.
- **UDP.** New `udp` transport (UDP only), and "Also forward UDP on these ports" (`--udp`) for the `tcp` transport in the menu, CLI and Setup tab. Checked on the real core: `accept_udp` works only with `tcp`.
- An unknown transport is refused before anything changes (it used to produce a server that never started), the menu offers a numbered list instead of free text, and `add-backhaul-peer --bundle` uses the bundle's transport instead of always `tcpmux`.

### GRE + Backhaul setup
- **Replacing a tunnel stops the old engine.** No setup stopped the other engine's services: after setting up GRE + Backhaul over GRE + FRP (or the other way round), `frps`/`frpc` kept running next to Backhaul on the same ports, the panel went on showing FRP, and Optimize restarted FRP from its old config. Every setup now stops and removes the other main relay (its config was already backed up). Extra peers stay. Backhaul without GRE also removes the old main GRE interface, which made the panel report GRE + Backhaul.
- **The foreign summary says what really happened.** It reported "connected" as soon as the service started, and always named the GRE address. It now waits up to 15 s for the control channel and shows the address it dialled (GRE, or the public IP when GRE does not answer). A wrong token or transport now fails the setup with the reason, and an Iran side that does not answer yet is a warning. Same for Backhaul without GRE.
- **New `E-BH-04`: transport mismatch.** With `tcp` on one side and `tcpmux` on the other (or `ws`/`wsmux`), the control channel comes up but no connection works. Diagnostics, the log view and the watchdog now recognise the core's lines for it instead of calling the link healthy.
- Checked in a GRE lab that now runs in CI (`tests/test_gre_backhaul_lab.sh`: two network namespaces, real GRE with MTU 1380, Backhaul v0.7.2): the foreign side picks the GRE address, 1 MiB arrives byte-exact, it falls back to the public IP when GRE is blocked, and the failures above are reported as described.

## v2.3.6 — 2026-10-18

Audit fixes, a Persian UI, a redesigned dashboard, and working Bagher, Diagnostics and engine switch. Update both servers.

The release was rebuilt the same day with the Dashboard, Performance, Setup, Update and Diagnostics changes below; a server that installed the first v2.3.6 build gets them with `hashem update` on the server (the Update tab sees the same version number and offers nothing).

### Diagnostics
- **Quick Repair fixes the MTU it finds.** Diagnostics reported "Packets of 1380 bytes do not cross the tunnel" but left the fix to the user, and even a manual fix did not last: `hashem.sh` set MTU 1380 and MSS 1340 again on every tunnel restart, carrier switch and Optimize. Quick Repair now saves the measured size in `/etc/gre-panel/gre_mtu`, lowers the GRE interfaces to it and replaces the larger MSS clamps with MTU − 40. `hashem.sh` honours that file wherever it sets the MTU or the clamp, the panel re-checks it every minute (for an older `hashem.sh`), and the Network Stack card shows the held value. Removing the tunnel clears it.

### Update tab
- **Automatic rollback that actually happens.** The old binary was kept as `.bak`, but nothing put it back if the new version did not start, so the panel stayed down (the confirm dialog promised a rollback). Now a short-lived systemd unit outside the panel's own service waits 60 s after an update; if the new binary has not started listening by then, it restores the previous one and restarts the panel. The tab then says which version failed and that it went back, and the error log records it (`E-UPDATE-09`).
- **Check Now works.** On an up-to-date panel the Check button was disabled, so it could never be pressed. It now asks GitHub again instead of answering from the 10-minute cache (at most every 30 s), and a failed check no longer retries every 5 s forever.
- **The page waits for the new version.** It reloaded as soon as `/api/health` answered, which the old panel often did before restarting, so the page came back on the old version. It now waits until the version changes and shows the steps: download and verify, restart, reload.
- **What's New:** release notes for every version between the installed and the latest one.
- **Other server:** shows the linked server's panel version and says when the two differ (peers now report their version).
- Installed and available versions side by side, last-checked time, release dates in the version list, the installed version cannot be "reinstalled" from it, and older versions moved under "Install a specific version". Fully translated to Persian.

### Setup tab
- **A foreign server could not join an Iran server set up with KCP, QUIC, WebSocket or WSS.** That bundle has eight parts (`…_fou443-55555_tr-kcp`) and the Setup form refused anything over seven. It now reads the transport too, shows it, and locks the FRP transport list to it (the server applied the bundle's transport anyway, whatever the list said).
- **Add Another Server Instead** (shown when the form is locked) did nothing; it now jumps to the add-server form.
- Joining from a foreign server that already has a tunnel asks before replacing it (it replaced it silently).
- Encryption and compression chosen while joining are saved to the performance settings too. Before, the Performance tab showed them as not applied and the next update removed them from frpc.
- The public IP lookup asks over IPv4 only: on a dual-stack server behind NAT it could fill in the IPv6 address, which GRE and the bundles cannot use.
- A new server's suggested control port and GRE pair skip the ones already in use (it suggested 7000 next to a tunnel on 7000), and the form clears after adding so the next suggestion is fresh. The added server's bundle has a Copy button.
- After an Iran setup the form locks right away instead of offering Apply again. The bundle info no longer turns later error messages blue, options a Backhaul bundle does not use are hidden, the diagram follows the chosen engine, the panel no longer calls `/api/setup` on every 15-second refresh, and plain TCP is no longer labelled "Multiplexed".

### Performance tab
- **Says what applies here.** On a server with no tunnel or with Backhaul, the FRP settings are greyed out with a note instead of offering an Apply that fails. On the Iran server, encryption and compression are greyed out: frps ignores them, they are set on the foreign servers. A hub with only numbered `frps-N.toml` files is now recognised as the Iran server.
- **New Network Stack card:** live congestion control and queue, socket buffers, connection-tracking use (warns at 70 % full), GRE MTU, MSS clamp and whether the settings survive a reboot, with Optimize Network and Restore right there.
- **FRP transport:** an "Unsaved changes" marker, Save is disabled until something changes, the top Apply button only shows when the running config differs, and the multiplexing line reads "In the running config: On / Off / mixed".
- **Auto Pool:** decisions in words (Scaled up, Waiting, …), last check time, and manual pool sizes are checked as you type. The API now refuses out-of-range values (pool 2–1000, max 10–2000) instead of ignoring them silently.
- **Carrier card:** the leftover FOU wording and fake "Manual / Auto Failover OFF" box are gone. It shows the active carrier, the ping to the other server ("No tunnel" instead of "Packet Loss / Link Down" when there is no GRE interface) and the WSS state. Switch Carrier asks first and is disabled until you pick a different carrier.
- **WSS settings:** a new port now moves the active carrier and Cycle to that port (they kept the old one), an empty SNI clears it, the saved SNI is shown, the port is validated, and the response no longer includes the WSS auth token.
- Fully translated to Persian; numbers and ports keep their order in RTL.

### Dashboard

- **Status hero:** one card answers "is the tunnel up": Healthy / Degraded / Down / Not set up, the first reason when it is not healthy, this server ⇄ the other server with their IPs and the engine chips (GRE, FRP, Backhaul, Bagher; GRE is not shown as a fault on engines that do not use it), and latency rated Good / Fair / High instead of always "Optimal".
- **Live traffic:** download and upload rates are the numbers; the lifetime total is a footnote. A separate Connections card shows the current count and the peak over the chart range.
- **Charts:** colors come from the theme tokens and match the legend (the connections legend was violet on a green line). A stopped tunnel greys the history instead of drawing it red. The axis uses round values in one unit (20 / 15 / 10 MB/s, not 18.6 GB/s and 512 KB/s), and rescales at once after a spike. The connections chart says what it counts: established TCP/UDP connections on the server.
- **Details:** no green "Stable / Zero Drops" and red "Down" before anything is set up; GRE and engine cards appear only when they exist; Role shows Iran/Foreign server (it never matched before); failover reads Automatic / Manual; times are local.
- **System:** CPU, RAM and disk as ring gauges colored by load, with uptime.
- **Tunnels table** for multi-peer hubs: status, foreign IP, engine, ports, ping and traffic per peer; a row opens its card in the Tunnel tab.
- Layout follows the space the dashboard has (container queries), so the activity side panel no longer squeezes it; works at 375px and in RTL.
- **Donate popup** now appears on the first visit after install ("Thanks for installing Hashem"), not only after a tunnel has been healthy, then every 7 days while the tunnel is healthy (30 days after "Don't remind me", 90 after Donate). It and the Settings/palette links point to pdnczone.com; the installer's final screen prints the link too.

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
