# Choosing an engine and a carrier

Hashem has two independent choices:

1. the **engine** — what relays your traffic (FRP or Backhaul) and whether a GRE link sits underneath;
2. the **carrier** — how the GRE packets cross the internet (only for engines that use GRE).

## Engines

| | GRE + FRP (`frp`) | GRE + Backhaul (`gre-backhaul`) | Backhaul standalone (`backhaul`) |
| --- | --- | --- | --- |
| Setup bundle | `hsh1_…` | `gh1_…` | `bh1_…` |
| GRE interface (`gre-tunnel`) | yes | yes | no |
| Relay binary | `frps` / `frpc` | `backhaul` | `backhaul` |
| Relay runs over | GRE inner IPs (10.10.10.x by default) | GRE inner IPs | the public IP |
| Fallback to the hub's public IP when GRE is dead | yes (`hashem dial`) | yes | not needed |
| Transports | `tcp`, `kcp`, `quic`, `websocket`, `wss` | Backhaul transports | Backhaul transports |
| Tuning in the panel | Auto Pool, encryption, compression, PROXY Protocol v2, tcpMux | Backhaul settings | Backhaul settings |

**GRE + FRP** is the default and the most complete: every Performance-tab option applies to it, and the FRP transports cover the common Iranian network conditions (see the matrix in [FRP_TUNNELS_GUIDE.md](FRP_TUNNELS_GUIDE.md)).

**GRE + Backhaul** keeps the private L3 link but uses Backhaul as the relay. Choose it if you already prefer Backhaul's behaviour and want the GRE inner addresses (for example to reach services by their inner IP).

**Backhaul standalone** has no GRE at all. It is the simplest option when IP protocol 47 cannot cross between your two servers and you do not need a Layer-3 link. Its setup bundles are the `bh1_` strings.

### Backhaul transports and ports

Hashem installs upstream Backhaul v0.7.2. Its transports are `tcpmux` (default), `tcp`, `ws`, `wss`, `wsmux`, `wssmux` and `udp`. All of them carry TCP except `udp`, which carries UDP only. To forward TCP **and** UDP on the same ports, use `tcp` with "Also forward UDP" (`--udp`, the core's `accept_udp`); the core ignores that option on the other transports.

Port entries: `443`, `10000-10050`, `2083=8443`, `10000-10050=443`, with an optional `IP:` on either side. The `10000-10050:443` form from Backhaul's README is rejected by the core, so Hashem rewrites it to `10000-10050=443`.

Everything Backhaul lives in Hashem: `hashem backhaul` (menu), the panel's Setup tab, `/etc/backhaul`, and the `backhaul-server[-N]` / `backhaul-client` units. Tunnels made by the old separate Modified Backhaul script (`backhaul-iranN` / `backhaul-kharejN`) are moved into Hashem by `hashem backhaul-migrate`, which the panel also runs once when it starts. Their IPX, ICMP, TUN, anytls and xtcpmux transports need the paid Backhaul Premium core, which Hashem does not ship; those tunnels never started on the installed core and have to be set up again with a transport from the list above.

You can switch the engine of an existing tunnel from the panel; the switch checks that the binary and unit exist before it stops anything, and reports the real error if a step fails.

## Carriers (GRE layer)

| Carrier | What crosses the network | Port | Use when |
| --- | --- | --- | --- |
| **Direct GRE** (default) | IP protocol 47 packets | none (protocol 47) | the path between the servers passes protocol 47 |
| **WSS** | GRE inside a TLS WebSocket | TCP `8443` (default) | protocol 47 is dropped, but outbound TCP/443-style traffic passes |

The FOU carrier was removed. The carrier is **never switched automatically**: the *carrier advisor* in the panel can tell you the active carrier keeps failing and suggest another, and `hashem carrier` changes it when you decide to.

The GRE interface MTU is set to 1380 (1360 for WSS) so tunnelled TCP does not fragment.

## A simple decision path

1. Try **GRE + FRP** with **Direct GRE**. Check the Dashboard: *Healthy* means done.
2. If the badge says **FRP only** or GRE never comes up, protocol 47 is probably filtered. Switch the carrier to **WSS** (`hashem carrier`).
3. If GRE is still unusable, or you do not need it, use **Backhaul standalone**.
4. Run the **Benchmark** tab to compare carriers on your real path before you commit.

## Transports for FRP

Pick per network condition; the full explanation and the operator matrix are in [FRP_TUNNELS_GUIDE.md](FRP_TUNNELS_GUIDE.md).

| Transport | Good for | Costs |
| --- | --- | --- |
| `tcp` | stable fixed lines, lowest CPU | slows under heavy packet loss |
| `kcp` | high packet loss (mobile at peak) | 10–20 % more bandwidth, needs UDP |
| `quic` | modern, many parallel streams | needs UDP |
| `websocket` | firewalls that only let web ports through | small overhead |
| `wss` | strict DPI | extra CPU for TLS; needs the TLS front (`control_port+2`) |

## One rule that bites: tcpMux

FRP `transport.tcpMux` is **off** by default and must be **identical on the hub and on every spoke**. A mismatch shows up as `connect to server error: EOF` (`E-FRP-10`). Change it everywhere with `hashem perf tcpmux on|off`.
