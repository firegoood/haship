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
	if len(cfg.Ports) != 5 {
		t.Errorf("expected 5 default ports, got %d", len(cfg.Ports))
	}

	cfg.RemoteHost = "1.2.3.4"
	cfg.Ports = []int{443, 8443}
	if err := saveSSHFwdConfigLocked(cfg); err != nil {
		t.Fatalf("failed saving: %v", err)
	}

	loaded := loadSSHFwdConfig()
	if loaded.RemoteHost != "1.2.3.4" || len(loaded.Ports) != 2 {
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

	authLine := formatAuthorizedKeyLine(pub, []int{443, 8443, 1020})
	if !strings.Contains(authLine, "restrict,port-forwarding,permitopen=\"127.0.0.1:443\",permitopen=\"127.0.0.1:8443\",permitopen=\"127.0.0.1:1020\"") {
		t.Errorf("authLine formatting error: %s", authLine)
	}
	if !strings.Contains(authLine, pub) {
		t.Errorf("authLine missing pub key")
	}
}

func TestSSHFwdServiceBuilder(t *testing.T) {
	cfg := SSHFwdConfig{
		RemoteHost:          "91.107.174.173",
		RemoteUser:          "root",
		RemoteSSHPort:       22,
		KeyPath:             "/root/.ssh/hashem-fwd",
		Ports:               []int{443, 8443},
		BindAddr:            "0.0.0.0",
		ServerAliveInterval: 10,
		ServerAliveCountMax:  3,
	}
	unit := buildSSHFwdService(cfg)
	if !strings.Contains(unit, "-L 0.0.0.0:443:127.0.0.1:443 -L 0.0.0.0:8443:127.0.0.1:8443") {
		t.Errorf("unit missing -L port forwarding args: %s", unit)
	}
	if !strings.Contains(unit, "root@91.107.174.173") {
		t.Errorf("unit missing target: %s", unit)
	}
	if !strings.Contains(unit, "Restart=always") {
		t.Errorf("unit missing Restart=always: %s", unit)
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
	if _, ok := res["ports"]; !ok {
		t.Errorf("response missing ports field: %+v", res)
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
