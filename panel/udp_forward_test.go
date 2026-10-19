package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A Backhaul bundle marks UDP after the transport; the foreign side reads it
// back and forwards UDP too. Bundles without the mark parse as before.
func TestBackhaulBundleUDPMark(t *testing.T) {
	for _, c := range []struct {
		in, want string
		udp      bool
	}{
		{"tcpmux", "tcpmux+udp", true},
		{"wssmux", "wssmux+udp", true},
		{"tcp", "tcp+udp", true},
		{"udp", "udp", true}, // carries UDP only already
		{"tcpmux", "tcpmux", false},
		{"", "tcpmux+udp", true},
		{"tcpmux+udp", "tcpmux+udp", true},
	} {
		if got := backhaulBundleTransport(c.in, c.udp); got != c.want {
			t.Errorf("backhaulBundleTransport(%q, %v) = %q, want %q", c.in, c.udp, got, c.want)
		}
	}

	s := MakeBackhaulBundle("203.0.113.5", 3080, backhaulBundleTransport("tcpmux", true), "tok", []string{"443", "2083=8443"})
	b, err := ParseBackhaulBundle(s)
	if err != nil {
		t.Fatal(err)
	}
	if b.Transport != "tcpmux" || !b.UDP {
		t.Fatalf("bh1 parse: transport %q udp %v, want tcpmux true (%s)", b.Transport, b.UDP, s)
	}
	g := MakeGreBackhaulBundle("203.0.113.5", 3080, "10.80.0.1", "10.80.0.2", backhaulBundleTransport("wss", true), "tok", []string{"443"})
	gb, err := ParseGreBackhaulBundle(g)
	if err != nil {
		t.Fatal(err)
	}
	if gb.Transport != "wss" || !gb.UDP {
		t.Fatalf("gh1 parse: transport %q udp %v, want wss true", gb.Transport, gb.UDP)
	}
	old, err := ParseBackhaulBundle("bh1_203.0.113.5_3080_tcpmux_tok_443")
	if err != nil || old.UDP || old.Transport != "tcpmux" {
		t.Fatalf("bundle without the mark: %+v %v", old, err)
	}

	var body setupRequest
	applyBundle(&body, b)
	if !body.AcceptUDP || body.Transport != "tcpmux" {
		t.Fatalf("applyBundle: accept_udp %v transport %q", body.AcceptUDP, body.Transport)
	}
	if !backhaulTransportOK(body.Transport) {
		t.Fatalf("transport %q after the mark is not a core transport", body.Transport)
	}
	args, _ := installerArgs(&body, []int{443}, []string{"443"})
	if !strings.Contains(strings.Join(args, " "), "--udp") {
		t.Fatalf("foreign setup from a +udp bundle lacks --udp: %v", args)
	}
}

// The Iran setup prints a bundle that carries the UDP mark.
func TestSetupBundleCarriesUDP(t *testing.T) {
	if got := backhaulBundleTransport("tcpmux", false); strings.Contains(got, "udp") {
		t.Fatalf("no UDP asked, got %q", got)
	}
	s := MakeBackhaulBundle("203.0.113.5", 3080, backhaulBundleTransport("tcpmux", true), "tok", nil)
	if !strings.Contains(s, "_tcpmux+udp_") {
		t.Fatalf("bundle %q lacks the UDP mark", s)
	}
}

// backhaulUnitUDP follows the companion unit hashem.sh writes.
func TestBackhaulUnitUDP(t *testing.T) {
	dir := t.TempDir()
	old := backhaulUnitDir
	backhaulUnitDir = dir
	defer func() { backhaulUnitDir = old }()

	for unit, want := range map[string]string{
		"backhaul-server":    "backhaul-udp-server",
		"backhaul-server-3":  "backhaul-udp-server-3",
		"backhaul-client":    "backhaul-udp-client",
		"backhaul-client-h2": "backhaul-udp-client-h2",
	} {
		if got := backhaulUDPUnit(unit); got != want {
			t.Errorf("backhaulUDPUnit(%q) = %q, want %q", unit, got, want)
		}
	}
	if backhaulUnitUDP("backhaul-server") || backhaulUnitUDP("") {
		t.Fatal("UDP reported without a companion unit")
	}
	if err := os.WriteFile(filepath.Join(dir, "backhaul-udp-server-3.service"), []byte("[Unit]\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if !backhaulUnitUDP("backhaul-server-3") || backhaulUnitUDP("backhaul-server") {
		t.Fatal("companion of backhaul-server-3 not matched to its own unit")
	}
}

// Bagher: UDP adds a udp proxy per port next to the tcp one, and the bundle
// carries the choice to the foreign side.
func TestBagherUDP(t *testing.T) {
	without := buildFRPCConfig(55400, 5, []int{443, 8443}, false)
	if strings.Contains(without, `type = "udp"`) {
		t.Fatalf("udp proxy without UDP:\n%s", without)
	}
	with := buildFRPCConfig(55400, 5, []int{443, 8443}, true)
	for _, want := range []string{`name = "p443"`, `name = "u443"`, `name = "u8443"`, `type = "udp"`} {
		if !strings.Contains(with, want) {
			t.Fatalf("frpc config lacks %s:\n%s", want, with)
		}
	}
	if n := strings.Count(with, "[[proxies]]"); n != 4 {
		t.Fatalf("want 4 proxies (2 tcp + 2 udp), got %d", n)
	}

	raw, _ := json.Marshal(BagherBundle{Version: 1, Role: "foreign", IranPub: "203.0.113.5", FRPPort: 55400,
		Ports: []int{443}, PoolCount: 5, SSHPublicKey: "ssh-ed25519 AAAA", UDP: true})
	b, err := ParseBagherBundle("BAGHER:" + base64.StdEncoding.EncodeToString(raw))
	if err != nil {
		t.Fatal(err)
	}
	if !b.UDP {
		t.Fatal("Bagher bundle lost the UDP choice")
	}
	cfg := defaultSSHFwdConfig()
	cfg.Ports = []int{443}
	cfg.UDP = true
	if cmd := buildForeignSetupCommand(cfg); !strings.Contains(cmd, `type = "udp"`) {
		t.Fatalf("foreign setup command lacks the udp proxy:\n%s", cmd)
	}
}
