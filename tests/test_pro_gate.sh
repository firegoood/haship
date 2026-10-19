#!/usr/bin/env bash
# tests/test_pro_gate.sh — Backhaul setups in hashem.sh need Hashem Pro, asked
# through the panel binary (`gre-panel license check backhaul`, the same key and
# rules as the panel); running tunnels are never gated. Hermetic: a fake binary.
set -u
cd "$(dirname "$0")/.." || exit 1
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
check() { if [[ "$2" != "$3" ]]; then echo "FAIL: $1 (want [$2] got [$3])"; fail=1; else echo "ok:   $1"; fi; }

ext() { awk -v n="$1" '$0 ~ "^"n"\\(\\) \\{" {p=1} p {print} p && /^}/ {exit}' hashem.sh; }
RED='' NC=''
eval "$(ext pro_ok)"

# fake panel binary: "license check F" succeeds only for the features in $T/unlocked
cat > "$T/gre-panel" <<EOF
#!/bin/bash
[[ "\$1 \$2" == "license check" ]] && grep -qx "\$3" "$T/unlocked" 2>/dev/null
EOF
chmod +x "$T/gre-panel"
export PANEL_BIN="$T/gre-panel"

: > "$T/unlocked"
check "no license: Backhaul refused" 1 "$(pro_ok backhaul Backhaul >/dev/null; echo $?)"
check "no license: says why" yes "$(pro_ok backhaul Backhaul | grep -q 'Hashem Pro feature' && echo yes)"
echo backhaul > "$T/unlocked"
check "Pro license: Backhaul allowed" 0 "$(pro_ok backhaul Backhaul >/dev/null; echo $?)"
PANEL_BIN="$T/missing" check "no panel binary: refused" 1 "$(PANEL_BIN="$T/missing" pro_ok backhaul Backhaul >/dev/null; echo $?)"

# every entry that creates a Backhaul tunnel asks first ...
for f in setup_backhaul_iran_server_noninteractive setup_backhaul_foreign_server_noninteractive \
         setup_gre_backhaul_iran_server_noninteractive setup_gre_backhaul_foreign_server_noninteractive \
         cli_add_backhaul_peer setup_backhaul_iran_interactive; do
    first=$(ext "$f" | sed -n '2,3p' | grep -c 'pro_ok backhaul')
    check "$f asks for Pro before doing anything" 1 "$first"
done
# ... and nothing that keeps a running tunnel alive does
for f in cli_backhaul_migrate backhaul_status backhaul_show_bundle watchdog_tick dial_watch_tick dial_reselect; do
    check "$f never asks for a license" 0 "$(ext "$f" | grep -c 'pro_ok')"
done

(( fail )) && exit 1; echo "PASS test_pro_gate"
