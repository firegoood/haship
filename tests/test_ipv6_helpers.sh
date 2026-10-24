#!/usr/bin/env bash
# IPv6 address helpers in hashem.sh: is_valid_ip6, hostport, hostonly and the
# dial helpers that read and rewrite a Backhaul remote_addr. No root.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
for fn in is_valid_ip is_valid_ip6 is_valid_ip_any hostport hostonly \
          dial_current_addr dial_current_port dial_apply_addr; do
    awk -v f="$fn" '
        $0 ~ "^"f"\\(\\) \\{" { p = 1; print; if ($0 ~ /; \}[[:space:]]*$/) p = 0; next }
        p { print }
        p && /^}/ { p = 0 }' "$ROOT/hashem.sh"
done > "$T/fn.sh"
# shellcheck disable=SC1091
source "$T/fn.sh"
fail=0
chk() { [[ "$2" == "$3" ]] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
ok() { if "$@"; then echo y; else echo n; fi; }

for a in 2001:db8::1 ::1 :: fe80::1 2001:0db8:0000:0000:0000:ff00:0042:8329 1:2:3:4:5:6:7:8 1::8 1:2:3:4:5:6:7:: ::2:3:4:5:6:7:8; do
    chk "ip6 $a" "$(ok is_valid_ip6 "$a")" y
done
for a in "" 1.2.3.4 2001:db8:::1 1::2::3 :1:2 1:2: 1:2:3:4:5:6:7:8:9 12345::1 g::1 "[::1]" "::1/128" "fe80::1%eth0" "1:2:3:4:5:6:7::8:9"; do
    chk "not ip6 '$a'" "$(ok is_valid_ip6 "$a")" n
done
chk "any v4" "$(ok is_valid_ip_any 203.0.113.1)" y
chk "any v6" "$(ok is_valid_ip_any 2001:db8::1)" y
chk "any name" "$(ok is_valid_ip_any example.com)" n

chk "hostport v4" "$(hostport 1.2.3.4 443)" 1.2.3.4:443
chk "hostport v6" "$(hostport 2001:db8::1 443)" "[2001:db8::1]:443"
chk "hostport bracketed" "$(hostport "[2001:db8::1]" 443)" "[2001:db8::1]:443"
chk "hostport name" "$(hostport example.com 80)" example.com:80
chk "hostonly v4" "$(hostonly 1.2.3.4:443)" 1.2.3.4
chk "hostonly v6" "$(hostonly "[2001:db8::1]:443")" 2001:db8::1
chk "hostonly name" "$(hostonly example.com:443)" example.com

# a Backhaul client config read and rewritten in place, both families
dial_conf_file() { echo "$T/client.toml"; }
printf '[dialer]\nremote_addr = "203.0.113.5:3080"\n' > "$T/client.toml"
chk "dial addr v4" "$(dial_current_addr backhaul)" 203.0.113.5
chk "dial port v4" "$(dial_current_port backhaul)" 3080
dial_apply_addr backhaul 2001:db8::5 3080
chk "rewritten v6" "$(grep remote_addr "$T/client.toml")" 'remote_addr = "[2001:db8::5]:3080"'
chk "dial addr v6" "$(dial_current_addr backhaul)" 2001:db8::5
chk "dial port v6" "$(dial_current_port backhaul)" 3080
dial_apply_addr backhaul 10.10.10.1 3080
chk "rewritten back" "$(grep remote_addr "$T/client.toml")" 'remote_addr = "10.10.10.1:3080"'

if [[ $fail -eq 0 ]]; then echo "PASS: test_ipv6_helpers"; else echo "FAIL: test_ipv6_helpers"; exit 1; fi
