#!/usr/bin/env bash
# tests/test_pathtest_lab.sh — the Benchmark tab's path test (gre-panel pathtest)
# between two namespaces joined by a veth (Iran 192.0.2.1, foreign 192.0.2.2),
# with the real frps/frpc and Backhaul v0.7.2 cores and no tunnel installed:
#
#  1. open path: every check works (plain TCP/UDP, GRE, SSH banner, FRP x 5,
#     Backhaul x 7), data crosses each transport and a speed is measured.
#  2. a filtered path: UDP and GRE dropped and Backhaul ws's port blocked on the
#     way to Iran -> exactly those checks are "fail", the rest still "ok".
#  3. nothing is left behind: no hpt0 interface, no core process, no temp dir.
#
# Needs: PANEL_BIN (linux gre-panel), ip, iptables, ping, python3, the cores in
# FRP_DIR and BACKHAUL_BIN, CAP_NET_ADMIN. Skips cleanly otherwise.
set -u
cd "$(dirname "$0")/.." || exit 1

PANEL=${PANEL_BIN:-}
BIN=${BACKHAUL_BIN:-/tmp/backhaul-rel/backhaul}
FRP_DIR=${FRP_DIR:-/tmp/frp-rel}
[[ -n $PANEL && -x $PANEL ]] || { echo "SKIP test_pathtest_lab (PANEL_BIN not set)"; exit 0; }
[[ -x $BIN && -x $FRP_DIR/frps && -x $FRP_DIR/frpc ]] || { echo "SKIP test_pathtest_lab (cores missing)"; exit 0; }
for c in ip iptables ping python3 timeout; do
    command -v "$c" >/dev/null 2>&1 || { echo "SKIP test_pathtest_lab ($c missing)"; exit 0; }
done

HUB=pt-iran
SPOKE=pt-foreign
TMP=$(mktemp -d /tmp/pt-lab.XXXXXX)
pids=()
set +m
cleanup() {
    local p
    for p in "${pids[@]:-}"; do [[ -n $p ]] && { kill -9 "$p"; wait "$p"; } 2>/dev/null; done
    ip netns pids "$HUB" 2>/dev/null | xargs -r kill -9 2>/dev/null
    ip netns pids "$SPOKE" 2>/dev/null | xargs -r kill -9 2>/dev/null
    ip netns del "$HUB" 2>/dev/null; ip netns del "$SPOKE" 2>/dev/null
    rm -rf "$TMP"
}
trap cleanup EXIT
ip netns del "$HUB" 2>/dev/null; ip netns del "$SPOKE" 2>/dev/null
ip netns add "$HUB" 2>/dev/null || { echo "SKIP test_pathtest_lab (no netns permission)"; exit 0; }
ip netns add "$SPOKE"
H="ip netns exec $HUB"; S="ip netns exec $SPOKE"
ip link add pt-h type veth peer name pt-s
ip link set pt-h netns "$HUB"; ip link set pt-s netns "$SPOKE"
$H sh -c 'ip addr add 192.0.2.1/24 dev pt-h; ip link set pt-h up; ip link set lo up'
$S sh -c 'ip addr add 192.0.2.2/24 dev pt-s; ip link set pt-s up; ip link set lo up'

# the cores, where the panel looks for them
mkdir -p "$TMP/cores"
ln -s "$FRP_DIR/frps" "$TMP/cores/frps"; ln -s "$FRP_DIR/frpc" "$TMP/cores/frpc"; ln -s "$BIN" "$TMP/cores/backhaul"
export HASHEM_CORE_DIR="$TMP/cores" HASHEM_PT_GRACE=25s TMPDIR="$TMP"

# an SSH server stand-in on the foreign side (Bagher dials it from Iran)
$S python3 -c '
import socket
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("192.0.2.2", 2222)); s.listen(20)
while True:
    c, _ = s.accept(); c.sendall(b"SSH-2.0-OpenSSH_9.6\r\n"); c.close()
' & pids+=($!)

fail=0
check() { if [[ "$2" != "$3" ]]; then echo "FAIL: $1 (want [$2] got [$3])"; fail=1; else echo "ok:   $1"; fi; }

# run_test PORT -> Iran's JSON results in $TMP/hub.json, the foreign side's in $TMP/spoke.json
run_test() {
    : > "$TMP/hub.out"
    $H "$PANEL" pathtest serve -port "$1" -ip 192.0.2.1 -foreign 192.0.2.2 -ssh 2222 -minutes 3 > "$TMP/hub.out" 2>&1 &
    local hp=$! i code=""
    for i in $(seq 1 50); do code=$(awk '/^CODE /{print $2}' "$TMP/hub.out"); [[ -n $code ]] && break; sleep 0.2; done
    [[ -n $code ]] || { echo "FAIL: no code from serve"; cat "$TMP/hub.out"; fail=1; kill $hp; return; }
    $S "$PANEL" pathtest join "$code" > "$TMP/spoke.out" 2>&1 &
    local sp=$!
    for i in $(seq 1 150); do kill -0 $hp 2>/dev/null || break; sleep 1; done
    kill $hp 2>/dev/null; wait $hp 2>/dev/null
    for i in $(seq 1 30); do kill -0 $sp 2>/dev/null || break; sleep 1; done
    kill $sp 2>/dev/null; wait $sp 2>/dev/null
    sed -n 's/^JSON //p' "$TMP/hub.out" > "$TMP/hub.json"
    sed -n 's/^JSON //p' "$TMP/spoke.out" > "$TMP/spoke.json"
    grep -v '^JSON ' "$TMP/hub.out"
}
# status_of FILE ID -> status ; field FILE ID KEY -> value
status_of() { python3 -c 'import json,sys; d={c["id"]:c for c in json.load(open(sys.argv[1]))}; print(d.get(sys.argv[2],{}).get("status","missing"))' "$1" "$2" 2>/dev/null || echo none; }
has_num()   { python3 -c 'import json,sys; d={c["id"]:c for c in json.load(open(sys.argv[1]))}; print("yes" if d.get(sys.argv[2],{}).get(sys.argv[3],0)>0 else "no")' "$1" "$2" "$3" 2>/dev/null || echo none; }

ALL="tcp udp gre ssh frp-tcp frp-websocket frp-wss frp-kcp frp-quic bh-tcp bh-tcpmux bh-ws bh-wss bh-wsmux bh-wssmux bh-udp"

# ---- 1. open path ----
echo "== open path"
run_test 41000
for id in $ALL; do check "open: $id works" ok "$(status_of "$TMP/hub.json" "$id")"; done
for id in frp-tcp frp-kcp frp-wss bh-tcpmux bh-wssmux; do check "open: $id has a speed" yes "$(has_num "$TMP/hub.json" "$id" mbps)"; done
check "open: bh-udp has a latency" yes "$(has_num "$TMP/hub.json" bh-udp rtt_ms)"
check "open: the foreign side got Iran's results" ok "$(status_of "$TMP/spoke.json" bh-tcpmux)"

# ---- 2. filtered path: UDP, GRE and Backhaul ws's port dropped towards Iran ----
echo "== filtered path"
$S iptables -A OUTPUT -d 192.0.2.1 -p udp -j DROP
$S iptables -A OUTPUT -d 192.0.2.1 -p 47 -j DROP
$S iptables -A OUTPUT -d 192.0.2.1 -p tcp --dport 42006 -j DROP
run_test 42000
for id in udp gre frp-kcp frp-quic bh-udp bh-ws; do check "filtered: $id blocked" fail "$(status_of "$TMP/hub.json" "$id")"; done
for id in tcp ssh frp-tcp frp-websocket frp-wss bh-tcp bh-tcpmux bh-wss bh-wsmux bh-wssmux; do
    check "filtered: $id still works" ok "$(status_of "$TMP/hub.json" "$id")"
done
$S iptables -F OUTPUT

# ---- 3. nothing left behind ----
sleep 1
check "no hpt0 left (Iran)" "" "$($H ip -o link show hpt0 2>/dev/null)"
check "no hpt0 left (foreign)" "" "$($S ip -o link show hpt0 2>/dev/null)"
check "no core process left" "" "$(pgrep -f "$TMP/cores/" || true)"
check "no temp dir left" "" "$(ls -d "$TMP"/hashem-pathtest-* 2>/dev/null)"

(( fail )) && exit 1; echo "PASS test_pathtest_lab"
