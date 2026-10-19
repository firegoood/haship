#!/usr/bin/env bash
# UDP next to a TCP-only Backhaul transport: the companion config, its unit,
# its removal and the "+udp" bundle mark. No root: systemctl and ufw are stubs.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/units" "$T/bh"
for fn in is_valid_ip is_valid_port backhaul_udp_wanted backhaul_udp_companion_wanted backhaul_udp_unit \
          backhaul_conf_transport backhaul_udp_conf backhaul_udp_remove backhaul_udp_on backhaul_udp_apply \
          backhaul_bundle_transport bundle_make_backhaul bundle_make_gre_backhaul bundle_parse; do
    awk -v f="$fn" '
        $0 ~ "^"f"\\(\\) \\{" { p = 1; print; if ($0 ~ /; \}[[:space:]]*$/) p = 0; next }
        p { print }
        p && /^}/ { p = 0 }' "$ROOT/hashem.sh"
done > "$T/fn.sh"
printf '#!/bin/sh\necho "$@" >> "%s/systemctl.log"\n' "$T" > "$T/bin/systemctl"
printf '#!/bin/sh\nexit 1\n' > "$T/bin/ufw"
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH"
BACKHAUL_CONFIG_DIR="$T/bh" HASHEM_SYSTEMD_DIR="$T/units" HASHEM_BIN=/usr/local/bin/hashem INSTALL_DIR=/usr/local/bin
BUNDLE_PREFIX="hsh1_" BUNDLE_PREFIX_BACKHAUL="bh1_" BUNDLE_PREFIX_GRE_BACKHAUL="gh1_"
CYAN="" NC="" YELLOW="" RED="" GREEN=""
# shellcheck disable=SC1091
source "$T/fn.sh"
fail=0
chk() { [[ "$2" == "$3" ]] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
yes_() { if "$@"; then echo yes; else echo no; fi; }

chk "unit name"      "$(backhaul_udp_unit backhaul-server)"    "backhaul-udp-server"
chk "peer unit name" "$(backhaul_udp_unit backhaul-server-3)"  "backhaul-udp-server-3"
chk "hub unit name"  "$(backhaul_udp_unit backhaul-client-h2)" "backhaul-udp-client-h2"

# v1 server (the v0.7.2 core): tcpmux + wss bits + dashboard
cat > "$T/bh/config.toml" <<'EOF'
[server]
bind_addr = "0.0.0.0:3080"
transport = "tcpmux"
token = "secret"
web_port = 2060
sniffer = true
mux_version = 1
ports = [
  "443",
  "2083=8443",
]
EOF
chk "transport v1" "$(backhaul_conf_transport "$T/bh/config.toml")" "tcpmux"
backhaul_udp_conf "$T/bh/config.toml" "$T/bh/udp/backhaul-server.toml" || { echo "FAIL companion conf for tcpmux"; fail=1; }
c="$T/bh/udp/backhaul-server.toml"
chk "companion transport" "$(backhaul_conf_transport "$c")" "udp"
chk "same bind"   "$(grep -c '^bind_addr = "0.0.0.0:3080"' "$c")" "1"
chk "same token"  "$(grep -c '^token = "secret"' "$c")" "1"
chk "same ports"  "$(grep -c '"2083=8443"' "$c")" "1"
chk "no dashboard" "$(grep -c '^web_port = 0' "$c")" "1"
chk "no sniffer"   "$(grep -c '^sniffer = false' "$c")" "1"

# v2 client: [transport] type =
printf '[dialer]\nremote_addr = "203.0.113.5:3080"\n\n[transport]\ntype = "wssmux"\nconnection_pool = 8\n' > "$T/bh/client.toml"
backhaul_udp_conf "$T/bh/client.toml" "$T/bh/udp/backhaul-client.toml" || { echo "FAIL companion conf for v2 client"; fail=1; }
chk "v2 companion type" "$(grep -c '^type = "udp"' "$T/bh/udp/backhaul-client.toml")" "1"

# tcp carries UDP itself (accept_udp), udp carries UDP only, missing main: skip
printf '[server]\ntransport = "tcp"\naccept_udp = true\n' > "$T/bh/tcp.toml"
printf '[server]\ntransport = "udp"\n' > "$T/bh/udp.toml"
chk "skip tcp"     "$(yes_ backhaul_udp_conf "$T/bh/tcp.toml" "$T/x.toml")" "no"
chk "skip udp"     "$(yes_ backhaul_udp_conf "$T/bh/udp.toml" "$T/x.toml")" "no"
chk "skip missing" "$(yes_ backhaul_udp_conf "$T/bh/nope.toml" "$T/x.toml")" "no"

# apply: the unit is PartOf the main one and rebuilds its config on start
BH_ACCEPT_UDP=1 backhaul_udp_apply backhaul-server "$T/bh/config.toml" >/dev/null
u="$T/units/backhaul-udp-server.service"
[[ -f "$u" ]] || { echo "FAIL companion unit not written"; fail=1; }
chk "PartOf"        "$(grep -c '^PartOf=backhaul-server.service' "$u")" "1"
chk "WantedBy"      "$(grep -c '^WantedBy=backhaul-server.service' "$u")" "1"
chk "ExecCondition" "$(grep -c "^ExecCondition=/usr/local/bin/hashem backhaul-udp-conf $T/bh/config.toml $T/bh/udp/backhaul-server.toml" "$u")" "1"
chk "ExecStart"     "$(grep -c "^ExecStart=/usr/local/bin/backhaul -c $T/bh/udp/backhaul-server.toml" "$u")" "1"
chk "enabled"       "$(grep -c 'enable backhaul-udp-server.service' "$T/systemctl.log")" "1"
printf '[Service]\nExecStart=/usr/local/bin/backhaul -c %s\n' "$T/bh/config.toml" > "$T/units/backhaul-server.service"
chk "udp on (companion)" "$(yes_ backhaul_udp_on backhaul-server)" "yes"

# not asked any more: the companion goes
BH_ACCEPT_UDP=0 backhaul_udp_apply backhaul-server "$T/bh/config.toml" >/dev/null
[[ ! -f "$u" && ! -f "$T/bh/udp/backhaul-server.toml" ]] || { echo "FAIL companion kept without UDP"; fail=1; }
chk "udp off" "$(yes_ backhaul_udp_on backhaul-server)" "no"
# tcp transport: accept_udp does it, no companion
printf '[Service]\nExecStart=/usr/local/bin/backhaul -c %s\n' "$T/bh/tcp.toml" > "$T/units/backhaul-server-2.service"
BH_ACCEPT_UDP=1 backhaul_udp_apply backhaul-server-2 "$T/bh/tcp.toml" >/dev/null
[[ ! -f "$T/units/backhaul-udp-server-2.service" ]] || { echo "FAIL companion for the tcp transport"; fail=1; }
chk "udp on (accept_udp)" "$(yes_ backhaul_udp_on backhaul-server-2)" "yes"

# bundles: the mark goes out with UDP and comes back on the foreign side
chk "mark" "$(BH_ACCEPT_UDP=1 bundle_make_backhaul 203.0.113.5 3080 tcpmux tok "443")" "bh1_203.0.113.5_3080_tcpmux+udp_tok_443"
chk "no mark" "$(BH_ACCEPT_UDP=0 bundle_make_backhaul 203.0.113.5 3080 tcpmux tok "443")" "bh1_203.0.113.5_3080_tcpmux_tok_443"
chk "udp transport no mark" "$(BH_ACCEPT_UDP=1 bundle_make_backhaul 203.0.113.5 3080 udp tok)" "bh1_203.0.113.5_3080_udp_tok"
BH_ACCEPT_UDP=0
bundle_parse "gh1_203.0.113.5_3080_10.80.0.1_10.80.0.2_wss+udp_tok_443" || { echo "FAIL parse gh1 +udp"; fail=1; }
chk "parsed transport" "$B_TRANSPORT" "wss"
chk "parsed udp" "$B_UDP/$BH_ACCEPT_UDP" "1/1"
BH_ACCEPT_UDP=0
bundle_parse "bh1_203.0.113.5_3080_tcpmux_tok_443" || { echo "FAIL parse bh1"; fail=1; }
chk "old bundle" "$B_TRANSPORT/$B_UDP/$BH_ACCEPT_UDP" "tcpmux/0/0"

[[ $fail -eq 0 ]] && echo "PASS test_backhaul_udp" || exit 1
