package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func seedPeersRegistry(t *testing.T, raw string) {
	t.Helper()
	old := configDir
	configDir = t.TempDir()
	t.Cleanup(func() { configDir = old })
	if err := os.WriteFile(filepath.Join(configDir, "peers.json"), []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
}

// hashem.sh add-backhaul-peer writes raw_ports as "443, 10000-10050". A
// decode failure here used to blank every peer on the hub (web panel showed
// no tunnels while the CLI listed the backhaul-server-N unit).
func TestLoadPeersAcceptsStringRawPorts(t *testing.T) {
	seedPeersRegistry(t, `{"peers":[{
		"id":1,"name":"peer-1","local_pub":"1.1.1.1","remote_pub":"2.2.2.2",
		"frp_port":7001,"ports":[443],"raw_ports":"443, 10000-10050",
		"gre_if":"none","frps_svc":"backhaul-server-1","engine":"backhaul",
		"transport":"tcpmux","no_gre":true}]}`)

	peers := loadPeers()
	if len(peers) != 1 {
		t.Fatalf("loadPeers() = %d peers, want 1", len(peers))
	}
	p := peers[0]
	if !p.NoGre || p.Engine != "backhaul" || p.FrpsSvc != "backhaul-server-1" {
		t.Fatalf("backhaul peer decoded wrong: %+v", p)
	}
	if len(p.RawPorts) != 2 || p.RawPorts[0] != "443" || p.RawPorts[1] != "10000-10050" {
		t.Fatalf("raw ports = %#v, want [443 10000-10050]", p.RawPorts)
	}
}

func TestLoadPeersAcceptsArrayRawPorts(t *testing.T) {
	seedPeersRegistry(t, `{"peers":[{
		"id":2,"name":"peer-2","frp_port":7002,"ports":[443],
		"raw_ports":["443","2083=8443"],"gre_if":"none",
		"frps_svc":"backhaul-server-2","engine":"backhaul","no_gre":true}]}`)

	peers := loadPeers()
	if len(peers) != 1 {
		t.Fatalf("loadPeers() = %d peers, want 1", len(peers))
	}
	if got := peers[0].RawPorts; len(got) != 2 || got[1] != "2083=8443" {
		t.Fatalf("raw ports = %#v", got)
	}
}

// The web UI treats raw_ports as the comma-separated string and calls
// .split(',') on it; API writes must keep that shape, alongside the peerLive
// fields.
func TestPeerLiveMarshalsRawPortsAsString(t *testing.T) {
	b, err := json.Marshal(peerLive{
		peerRecord: peerRecord{ID: 1, RawPorts: rawPorts{"443", "10000-10050"}},
		GreUp:      true,
		FrpUp:      true,
	})
	if err != nil {
		t.Fatal(err)
	}
	out := string(b)
	if !strings.Contains(out, `"raw_ports":"443,10000-10050"`) {
		t.Fatalf("raw_ports not a string: %s", out)
	}
	if !strings.Contains(out, `"gre_up":true`) || !strings.Contains(out, `"frp_up":true`) {
		t.Fatalf("peerLive fields missing: %s", out)
	}
}
