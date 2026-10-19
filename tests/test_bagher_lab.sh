#!/usr/bin/env bash
# tests/test_bagher_lab.sh — real Bagher stealth tunnel in network namespaces.
#
# Iran (bg-ir) keeps an SSH session to Foreign (bg-fo) with a reverse forward
# (ssh -R 127.0.0.1:FRP:127.0.0.1:FRP). frps on Iran listens on loopback and
# publishes the user ports; frpc on Foreign reaches it through the SSH tunnel
# and serves the Foreign services. A user (bg-us) only talks to Iran.
#
# Every config is the panel's own output (panel/bagher_lab_test.go), so this
# proves what the panel ships: data path, nothing exposed, the restricted key
# allows only its one reverse forward, and recovery after crashes and a
# network outage longer than the ServerAlive timeout.
#
# Needs root (netns), ip, sshd, ssh, ssh-keygen, python3, curl, frps/frpc
# (FRP_DIR, default /tmp/frp-rel) and Go or a prebuilt test binary
# (BAGHER_LAB_TEST_BIN). Skips cleanly otherwise. Touches nothing outside the
# three namespaces and a mktemp dir (and creates /run/sshd if missing).
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT=$PWD

FRP_DIR=${FRP_DIR:-/tmp/frp-rel}
for c in ip ssh ssh-keygen python3 curl; do
    command -v "$c" >/dev/null 2>&1 || { echo "SKIP test_bagher_lab ($c missing)"; exit 0; }
done
SSHD=$(command -v sshd || echo /usr/sbin/sshd)
[[ -x $SSHD ]] || { echo "SKIP test_bagher_lab (sshd missing)"; exit 0; }
[[ -x $FRP_DIR/frps && -x $FRP_DIR/frpc ]] || { echo "SKIP test_bagher_lab (frps/frpc missing in $FRP_DIR)"; exit 0; }

IR=bg-ir; FO=bg-fo; US=bg-us
IR_FO=198.51.100.1; FO_IP=198.51.100.2     # Iran <-> Foreign link
IR_US=203.0.113.1;  US_IP=203.0.113.2      # user <-> Iran link
P1=18080; P2=18081                          # forwarded service ports
FRP=55400                                   # panel default
TMP=$(mktemp -d /tmp/bagher-lab.XXXXXX)
chmod 755 "$TMP"
pids=()
set +m
cleanup() {
    local p
    for p in "${pids[@]:-}"; do [[ -n $p ]] && { kill -9 "$p"; wait "$p"; } 2>/dev/null; done
    for ns in $IR $FO $US; do ip netns pids "$ns" 2>/dev/null | xargs -r kill -9 2>/dev/null; ip netns del "$ns" 2>/dev/null; done
    [[ -n ${BAGHER_LAB_LOGDIR:-} ]] && { mkdir -p "$BAGHER_LAB_LOGDIR"; cp "$TMP"/*.log "$TMP"/*.toml "$TMP"/authorized_keys "$TMP"/ssh_cmd "$BAGHER_LAB_LOGDIR"/ 2>/dev/null; }
    rm -rf "$TMP"
}
trap cleanup EXIT
for ns in $IR $FO $US; do ip netns del "$ns" 2>/dev/null; done
ip netns add $IR 2>/dev/null || { echo "SKIP test_bagher_lab (no netns permission)"; exit 0; }
ip netns add $FO && ip netns add $US || { echo "SKIP test_bagher_lab (netns)"; exit 0; }
ip link add vg-ir netns $IR type veth peer name vg-fo netns $FO || { echo "SKIP test_bagher_lab (veth unsupported)"; exit 0; }
ip link add vg-irus netns $IR type veth peer name vg-us netns $US
ip -n $IR addr add $IR_FO/24 dev vg-ir;   ip -n $IR addr add $IR_US/24 dev vg-irus
ip -n $FO addr add $FO_IP/24 dev vg-fo;   ip -n $US addr add $US_IP/24 dev vg-us
for l in "$IR vg-ir" "$IR vg-irus" "$IR lo" "$FO vg-fo" "$FO lo" "$US vg-us" "$US lo"; do set -- $l; ip -n "$1" link set "$2" up; done

fail=0
ok()   { echo "ok:   $1"; }
bad()  { echo "FAIL: $1"; fail=1; }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }
# wait_for SECS CMD...: true once CMD succeeds, polling every second.
wait_for() { local n=$1; shift; local i; for ((i = 0; i < n; i++)); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
in_ns() { local ns=$1; shift; ip netns exec "$ns" "$@"; }

# ---- the panel's own configs -------------------------------------------------
ssh-keygen -q -t ed25519 -N '' -f "$TMP/id" -C hashem-bagher-carrier
ssh-keygen -q -t ed25519 -N '' -f "$TMP/wrong" -C stranger
gen_env=(BAGHER_LAB_DIR="$TMP" BAGHER_LAB_KEY="$TMP/id" BAGHER_LAB_HOST="$FO_IP" BAGHER_LAB_PORTS="$P1,$P2" BAGHER_LAB_FRP_PORT="$FRP" BAGHER_LAB_UDP=1)
if [[ -n ${BAGHER_LAB_TEST_BIN:-} ]]; then
    (cd "$ROOT/panel" && env "${gen_env[@]}" "$BAGHER_LAB_TEST_BIN" -test.run '^TestBagherLabConfigs$' >"$TMP/gen.log" 2>&1)
elif command -v go >/dev/null 2>&1; then
    (cd "$ROOT/panel" && env "${gen_env[@]}" go test -count=1 -run '^TestBagherLabConfigs$' . >"$TMP/gen.log" 2>&1)
else
    echo "SKIP test_bagher_lab (no go and no BAGHER_LAB_TEST_BIN)"; exit 0
fi
[[ -s $TMP/frps.toml && -s $TMP/frpc.toml && -s $TMP/ssh_cmd && -s $TMP/authorized_keys ]] \
    || { cat "$TMP/gen.log"; bad "panel generated the Bagher configs"; exit 1; }
ok "panel generated frps.toml, frpc.toml, ssh command and authorized_keys"
RESTART=$(sed -n 's/^RestartSec=//p' "$TMP/unit.service"); RESTART=${RESTART:-15}

# ---- Foreign: sshd, the services, frpc ----------------------------------------
mkdir -p /run/sshd "$TMP/www1" "$TMP/www2"
ssh-keygen -q -t ed25519 -N '' -f "$TMP/host_key"
cat >"$TMP/sshd_config" <<EOF
ListenAddress $FO_IP
Port 22
HostKey $TMP/host_key
AuthorizedKeysFile $TMP/authorized_keys
PidFile $TMP/sshd.pid
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
LogLevel VERBOSE
EOF
in_ns $FO "$SSHD" -D -e -f "$TMP/sshd_config" >"$TMP/sshd.log" 2>&1 & pids+=($!)
head -c 8388608 /dev/urandom >"$TMP/www1/blob"
head -c 1048576 /dev/urandom >"$TMP/www2/blob"
in_ns $FO python3 -m http.server $P1 --bind 127.0.0.1 --directory "$TMP/www1" >"$TMP/www1.log" 2>&1 & pids+=($!)
in_ns $FO python3 -m http.server $P2 --bind 127.0.0.1 --directory "$TMP/www2" >"$TMP/www2.log" 2>&1 & pids+=($!)
# UDP echo on the first port (the panel's frpc carries it as a udp proxy)
in_ns $FO python3 -I -c '
import socket, sys
u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
u.bind(("127.0.0.1", int(sys.argv[1])))
while True:
    d, a = u.recvfrom(65535)
    u.sendto(d, a)' $P1 >"$TMP/udpecho.log" 2>&1 & pids+=($!)
in_ns $FO "$FRP_DIR/frpc" -c "$TMP/frpc.toml" >"$TMP/frpc.log" 2>&1 & pids+=($!)

# ---- Iran: frps and the ssh carrier under a Restart=always loop ---------------
start_frps() { in_ns $IR "$FRP_DIR/frps" -c "$TMP/frps.toml" >>"$TMP/frps.log" 2>&1 & FRPS_PID=$!; pids+=($FRPS_PID); }
start_frps
# The unit's command, with known_hosts kept in the lab dir.
SSH_CMD=$(sed "s| root@| -o UserKnownHostsFile=$TMP/known_hosts root@|" "$TMP/ssh_cmd")
in_ns $IR bash -c "while true; do $SSH_CMD >>'$TMP/ssh.log' 2>&1; echo \"exit \$? \$(date +%T)\" >>'$TMP/ssh.log'; sleep $RESTART; done" & pids+=($!)

fetch() { in_ns $US curl -fsS --max-time 20 "http://$IR_US:$1/blob" | sha256sum | cut -d' ' -f1; }
want1=$(sha256sum <"$TMP/www1/blob" | cut -d' ' -f1)
want2=$(sha256sum <"$TMP/www2/blob" | cut -d' ' -f1)
tunnel_up() { [[ $(fetch $P1) == "$want1" ]]; }

# ---- 1. data path ---------------------------------------------------------------
if wait_for 60 tunnel_up; then ok "user -> Iran:$P1 -> ssh -> Foreign service (8 MiB, sha256 match)"; else
    bad "tunnel never carried data"; tail -n 20 "$TMP/ssh.log" "$TMP/frpc.log" "$TMP/sshd.log"; exit 1; fi
check "second port reaches its own service (1 MiB)" "$want2" "$(fetch $P2)"
okc=0
par=()
for i in $(seq 16); do (fetch $P2 >"$TMP/par.$i") & par+=($!); done
wait "${par[@]}"   # only these: a bare wait would also wait for sshd and frp
for i in $(seq 16); do [[ $(cat "$TMP/par.$i") == "$want2" ]] && okc=$((okc + 1)); done
check "16 parallel requests all intact" 16 "$okc"

# ---- 1b. UDP on the same port, through the same ssh tunnel -------------------------
# udp_ok N SIZE: datagrams from the user to Iran:P1; true when >=90% come back intact.
udp_ok() {
    in_ns $US python3 -I - "$IR_US" "$P1" "$1" "$2" <<'PY'
import os, socket, sys
host, port, n, size = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(1.5)
s.connect((host, port))
ok = 0
for _ in range(n):
    d = os.urandom(size)
    try:
        s.send(d)
        if s.recv(65535) == d: ok += 1
    except Exception:
        pass
sys.exit(0 if ok * 10 >= n * 9 else 1)
PY
}
if wait_for 30 udp_ok 5 64; then ok "UDP user -> Iran:$P1 -> ssh -> Foreign UDP service"; else bad "UDP never crossed the Bagher tunnel"; fi
udp_ok 30 1200 && ok "30 datagrams of 1200 B (>=90% intact)" || bad "UDP datagrams of 1200 B lost"

# ---- 2. nothing exposed -----------------------------------------------------------
in_ns $US bash -c "exec 3<>/dev/tcp/$IR_US/$FRP" 2>/dev/null && bad "frps control port reachable from outside Iran" \
    || ok "frps control port is loopback-only on Iran"
in_ns $IR bash -c "exec 3<>/dev/tcp/$FO_IP/$FRP" 2>/dev/null && bad "ssh reverse port reachable on Foreign's public address" \
    || ok "ssh reverse port is loopback-only on Foreign"

# ---- 3. the key Iran holds can do nothing but its one reverse forward -----------
SSHO=(-i "$TMP/id" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8)
out=$(in_ns $IR timeout 15 ssh "${SSHO[@]}" root@$FO_IP 'echo PWNED-$(id -u)' 2>&1)
[[ $out == *PWNED* ]] && bad "key runs commands on Foreign as root ($out)" || ok "key cannot run commands on Foreign"
# -L to a real service on Foreign's loopback (the 8 MiB web server).
in_ns $IR timeout 20 ssh "${SSHO[@]}" -N -L 127.0.0.1:19999:127.0.0.1:$P1 root@$FO_IP >"$TMP/lfwd.log" 2>&1 & lf=$!; pids+=($lf)
sleep 3
got=$(in_ns $IR curl -fsS --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:19999/ 2>/dev/null)
kill "$lf" 2>/dev/null
[[ $got == 200 ]] && bad "key opens -L forwards into Foreign's loopback services" || ok "key cannot open -L forwards"
in_ns $IR timeout 15 ssh "${SSHO[@]}" -N -o ExitOnForwardFailure=yes -R 127.0.0.1:55499:127.0.0.1:1 root@$FO_IP >/dev/null 2>&1
rc=$?
[[ $rc -ne 124 ]] && ok "key cannot listen on any other port (ssh exit $rc)" || bad "key opened -R on another port"
out=$(in_ns $IR timeout 15 ssh -i "$TMP/wrong" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@$FO_IP true 2>&1)
[[ $out == *"Permission denied"* ]] && ok "a different key is refused" || bad "unknown key accepted ($out)"

# ---- 4. recovery ------------------------------------------------------------------
t0=$(date +%s)
in_ns $IR pkill -9 -f "^/usr/bin/ssh -N -i $TMP/id" || true   # anchored: the restart loop's own command line contains it too
sleep 1
if wait_for $((RESTART + 60)) tunnel_up; then ok "recovers after kill -9 of the ssh carrier ($(( $(date +%s) - t0 ))s)"
else bad "no recovery after kill -9 of the ssh carrier"; fi

t0=$(date +%s)
kill -9 "$FRPS_PID"; wait "$FRPS_PID" 2>/dev/null
sleep 10   # the frps unit's RestartSec
start_frps
if wait_for 90 tunnel_up; then ok "recovers after frps crash on Iran ($(( $(date +%s) - t0 ))s)"
else bad "no recovery after frps crash"; fi

# Outage longer than ServerAlive (15s x 3): the Iran ssh gives up while
# Foreign's sshd may still hold the reverse port for the dead session.
ip -n $FO link set vg-fo down
sleep 60
ip -n $FO link set vg-fo up
t0=$(date +%s)
if wait_for 240 tunnel_up; then ok "recovers after a 60s Iran<->Foreign outage ($(( $(date +%s) - t0 ))s after the link returned)"
else bad "no recovery within 240s after a 60s outage"; echo "--- ssh.log"; tail -n 15 "$TMP/ssh.log"; echo "--- sshd.log"; tail -n 15 "$TMP/sshd.log"; fi

[[ $fail -eq 0 ]] && echo "PASS test_bagher_lab" || { echo "--- frpc.log"; tail -n 10 "$TMP/frpc.log"; exit 1; }
