package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// TestBagherLabConfigs writes the files the panel generates for a Bagher
// tunnel, so tests/test_bagher_lab.sh runs the real thing (sshd, ssh -R, frps,
// frpc) with exactly the panel's output. Runs only when the lab asks for it:
//
//	BAGHER_LAB_DIR=/tmp/x BAGHER_LAB_KEY=/tmp/x/id BAGHER_LAB_HOST=10.0.0.2 \
//	BAGHER_LAB_PORTS=18080,18081 go test -run TestBagherLabConfigs
func TestBagherLabConfigs(t *testing.T) {
	dir := os.Getenv("BAGHER_LAB_DIR")
	if dir == "" {
		t.Skip("set BAGHER_LAB_DIR to generate the Bagher lab configs")
	}
	var ports []int
	for _, p := range strings.Split(os.Getenv("BAGHER_LAB_PORTS"), ",") {
		n, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil {
			t.Fatalf("BAGHER_LAB_PORTS: %v", err)
		}
		ports = append(ports, n)
	}
	cfg := defaultSSHFwdConfig()
	cfg.RemoteHost = os.Getenv("BAGHER_LAB_HOST")
	cfg.KeyPath = os.Getenv("BAGHER_LAB_KEY")
	cfg.Ports = ports
	cfg.PoolCount = 5
	cfg.UDP = os.Getenv("BAGHER_LAB_UDP") == "1"
	if v := os.Getenv("BAGHER_LAB_FRP_PORT"); v != "" {
		cfg.FRPBindPort, _ = strconv.Atoi(v)
	}

	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("frps.toml", buildFRPSConfig(cfg))
	write("frpc.toml", buildFRPCConfig(cfg.FRPBindPort, cfg.PoolCount, cfg.Ports, cfg.UDP))

	// The unit's ExecStart is the exact ssh command the Iran side runs.
	unit := buildSSHFwdService(cfg)
	for _, line := range strings.Split(unit, "\n") {
		if strings.HasPrefix(line, "ExecStart=") {
			write("ssh_cmd", strings.TrimPrefix(line, "ExecStart="))
		}
	}
	write("unit.service", unit)

	// authorized_keys on the Foreign side, written by the same code a peer
	// key install or a bundle apply uses.
	pub, err := os.ReadFile(cfg.KeyPath + ".pub")
	if err != nil {
		t.Fatal(err)
	}
	old := authorizedKeysPath
	authorizedKeysPath = filepath.Join(dir, "authorized_keys")
	defer func() { authorizedKeysPath = old }()
	if err := installRestrictedKey(string(pub), "bagher", cfg.FRPBindPort, cfg.Ports); err != nil {
		t.Fatal(err)
	}
}
