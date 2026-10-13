package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestSSHFwdConfigDefaultsAndSave(t *testing.T) {
	tmpDir := t.TempDir()
	oldConfigDir := configDir
	configDir = tmpDir
	defer func() { configDir = oldConfigDir }()

	cfg := loadSSHFwdConfig()
	if cfg.RemoteUser != "root" {
		t.Errorf("expected default RemoteUser=root, got %s", cfg.RemoteUser)
	}
	if cfg.Mode != "frp_ssh" {
		t.Errorf("expected default Mode=frp_ssh, got %s", cfg.Mode)
	}
	if cfg.PoolCount != 25 {
		t.Errorf("expected default PoolCount=25, got %d", cfg.PoolCount)
	}
	if cfg.FRPBindPort != 55400 {
		t.Errorf("expected default FRPBindPort=55400, got %d", cfg.FRPBindPort)
	}
	if len(cfg.Ports) != 5 {
		t.Errorf("expected 5 default ports, got %d", len(cfg.Ports))
	}

	cfg.RemoteHost = "1.2.3.4"
	cfg.Ports = []int{443, 8443}
	cfg.PoolCount = 30
	if err := saveSSHFwdConfigLocked(cfg); err != nil {
		t.Fatalf("failed saving: %v", err)
	}

	loaded := loadSSHFwdConfig()
	if loaded.RemoteHost != "1.2.3.4" || len(loaded.Ports) != 2 || loaded.PoolCount != 30 {
		t.Errorf("loaded config mismatch: %+v", loaded)
	}
}

func TestSSHFwdKeyGenerationAndAuthLine(t *testing.T) {
	tmpDir := t.TempDir()
	keyPath := filepath.Join(tmpDir, "test_key")

	pub, err := ensureSSHFwdKey(keyPath)
	if err != nil {
		t.Fatalf("ensureSSHFwdKey failed: %v", err)
	}
	if !strings.HasPrefix(pub, "ssh-ed25519 ") {
		t.Errorf("expected ssh-ed25519 pub key, got %s", pub)
	}

	// Direct mode
	authLineDirect := formatAuthorizedKeyLine(pub, "direct", 0, []int{443, 8443, 1020})
	if !strings.Contains(authLineDirect, "restrict,port-forwarding,permitopen=\"127.0.0.1:443\",permitopen=\"127.0.0.1:8443\",permitopen=\"127.0.0.1:1020\"") {
		t.Errorf("authLineDirect formatting error: %s", authLineDirect)
	}

	// FRP over SSH mode
	authLineFRP := formatAuthorizedKeyLine(pub, "frp_ssh", 55400, []int{443, 8443})
	if !strings.Contains(authLineFRP, "restrict,port-forwarding,permitlisten=\"127.0.0.1:55400\"") {
		t.Errorf("authLineFRP error: %s", authLineFRP)
	}
}

func TestSSHFwdServiceBuilder(t *testing.T) {
	// 1. Direct mode builder
	cfgDirect := SSHFwdConfig{
		Mode:                "direct",
		RemoteHost:          "91.107.174.173",
		RemoteUser:          "root",
		RemoteSSHPort:       22,
		KeyPath:             "/root/.ssh/hashem-fwd",
		Ports:               []int{443, 8443},
		BindAddr:            "0.0.0.0",
		ServerAliveInterval: 10,
		ServerAliveCountMax: 3,
	}
	unitDirect := buildSSHFwdService(cfgDirect)
	if !strings.Contains(unitDirect, "-L 0.0.0.0:443:127.0.0.1:443 -L 0.0.0.0:8443:127.0.0.1:8443") {
		t.Errorf("unitDirect missing -L port forwarding args: %s", unitDirect)
	}

	// 2. FRP over SSH mode builder
	cfgFRP := SSHFwdConfig{
		Mode:                "frp_ssh",
		RemoteHost:          "91.107.174.173",
		RemoteUser:          "root",
		RemoteSSHPort:       22,
		KeyPath:             "/root/.ssh/hashem-fwd",
		Ports:               []int{443, 8443, 1020},
		FRPBindPort:         55400,
		PoolCount:           25,
		ServerAliveInterval: 10,
		ServerAliveCountMax: 3,
	}
	unitFRP := buildSSHFwdService(cfgFRP)
	if !strings.Contains(unitFRP, "-R 127.0.0.1:55400:127.0.0.1:55400") {
		t.Errorf("unitFRP missing -R port forwarding args: %s", unitFRP)
	}

	// 3. Foreign command builder
	foreignCmd := buildForeignSetupCommand(cfgFRP)
	if !strings.Contains(foreignCmd, "transport.poolCount = 25") || !strings.Contains(foreignCmd, "hashem-frp-ssh-frpc.service") {
		t.Errorf("foreignCmd missing poolCount or unit name: %s", foreignCmd)
	}
}

func TestSSHFwdAPIHandlers(t *testing.T) {
	tmpDir := t.TempDir()
	oldConfigDir := configDir
	configDir = tmpDir
	defer func() { configDir = oldConfigDir }()

	// Test GET /api/sshfwd
	req := httptest.NewRequest("GET", "/api/sshfwd", nil)
	rr := httptest.NewRecorder()
	handleSSHFwdGet(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("handleSSHFwdGet status=%d", rr.Code)
	}

	var res map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&res); err != nil {
		t.Fatalf("json decode failed: %v", err)
	}
	if res["mode"] != "frp_ssh" {
		t.Errorf("expected default mode frp_ssh, got %v", res["mode"])
	}
	if _, ok := res["foreign_setup_cmd"]; !ok {
		t.Errorf("expected foreign_setup_cmd in response")
	}

	// Test POST /api/sshfwd action=gen_key
	body, _ := json.Marshal(map[string]any{"action": "gen_key"})
	reqPost := httptest.NewRequest("POST", "/api/sshfwd", bytes.NewReader(body))
	rrPost := httptest.NewRecorder()
	handleSSHFwdPost(rrPost, reqPost)
	if rrPost.Code != http.StatusOK {
		t.Errorf("handleSSHFwdPost gen_key status=%d body=%s", rrPost.Code, rrPost.Body.String())
	}
}
