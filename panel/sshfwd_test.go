package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSSHFwdFormatAuthorizedKeyLine(t *testing.T) {
	pub := "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... test"

	// Bagher mode
	lineBagher := formatAuthorizedKeyLine(pub, "bagher", 55400, []int{443, 80})
	if !strings.Contains(lineBagher, "permitlisten=\"127.0.0.1:55400\"") {
		t.Fatalf("expected permitlisten for frp_bind_port, got: %s", lineBagher)
	}
	if !strings.Contains(lineBagher, "restrict,port-forwarding") {
		t.Fatalf("expected restrict,port-forwarding, got: %s", lineBagher)
	}

	// Direct mode
	lineDirect := formatAuthorizedKeyLine(pub, "direct", 55400, []int{443, 8443})
	if !strings.Contains(lineDirect, "permitopen=\"127.0.0.1:443\"") || !strings.Contains(lineDirect, "permitopen=\"127.0.0.1:8443\"") {
		t.Fatalf("expected permitopen list, got: %s", lineDirect)
	}
}

func TestSSHFwdBuildService(t *testing.T) {
	cfg := SSHFwdConfig{
		Mode:                "bagher",
		RemoteHost:          "1.2.3.4",
		RemoteUser:          "root",
		RemoteSSHPort:       22,
		KeyPath:             "/root/.ssh/hashem-fwd",
		Ports:               []int{443, 80},
		BindAddr:            "0.0.0.0",
		FRPBindPort:         55400,
		ServerAliveInterval: 10,
		ServerAliveCountMax: 3,
	}

	svc := buildSSHFwdService(cfg)
	if !strings.Contains(svc, "-R 127.0.0.1:55400:127.0.0.1:55400") {
		t.Fatalf("bagher service missing -R forward: %s", svc)
	}
	if !strings.Contains(svc, "root@1.2.3.4") {
		t.Fatalf("service missing remote target: %s", svc)
	}
	if !strings.Contains(svc, "Hashem Bagher Engine") {
		t.Fatalf("service description missing Bagher Engine: %s", svc)
	}

	// Direct mode test
	cfg.Mode = "direct"
	svcDirect := buildSSHFwdService(cfg)
	if !strings.Contains(svcDirect, "-L 0.0.0.0:443:127.0.0.1:443") {
		t.Fatalf("direct service missing -L forward: %s", svcDirect)
	}
}

func TestSSHFwdBuildForeignSetupCommand(t *testing.T) {
	cfg := SSHFwdConfig{
		Mode:        "bagher",
		FRPBindPort: 55400,
		PoolCount:   25,
		Ports:       []int{443, 8443},
	}
	cmd := buildForeignSetupCommand(cfg)
	if !strings.Contains(cmd, "hashem-bagher-frpc.service") {
		t.Fatalf("foreign setup missing hashem-bagher-frpc.service: %s", cmd)
	}
	if !strings.Contains(cmd, "transport.poolCount = 25") {
		t.Fatalf("foreign setup missing poolCount: %s", cmd)
	}
	if !strings.Contains(cmd, "localPort = 443") || !strings.Contains(cmd, "localPort = 8443") {
		t.Fatalf("foreign setup missing proxy ports: %s", cmd)
	}
}

func TestSSHFwdDefaultConfig(t *testing.T) {
	cfg := defaultSSHFwdConfig()
	if cfg.Mode != "bagher" {
		t.Fatalf("expected default mode 'bagher', got: %s", cfg.Mode)
	}
	if cfg.FRPBindPort != 55400 {
		t.Fatalf("expected FRPBindPort 55400, got: %d", cfg.FRPBindPort)
	}
	if cfg.PoolCount != 25 {
		t.Fatalf("expected PoolCount 25, got: %d", cfg.PoolCount)
	}
}

func TestSSHFwdLicenseGating(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "hashem-lic-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	oldConfigDir := configDir
	configDir = tmpDir
	defer func() { configDir = oldConfigDir }()

	// Ensure no active license in memory or disk
	_ = os.Remove(filepath.Join(configDir, "license.key"))
	activeLicenseMu.Lock()
	oldLic := activeLicense
	activeLicense = nil
	activeLicenseMu.Unlock()
	defer func() {
		activeLicenseMu.Lock()
		activeLicense = oldLic
		activeLicenseMu.Unlock()
	}()

	// Test Bagher mode gating via API
	body := `{"action":"enable","mode":"bagher","remote_host":"1.2.3.4"}`
	req := httptest.NewRequest("POST", "/api/ssh-fwd", strings.NewReader(body))
	rec := httptest.NewRecorder()

	handleSSHFwdPost(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected status 403 Forbidden for un-licensed Bagher Engine, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	var res map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("invalid json returned: %v", err)
	}
	if res["error_code"] != "E-LIC-01" {
		t.Fatalf("expected error_code E-LIC-01, got %v", res["error_code"])
	}
	if !strings.Contains(res["error"].(string), "Bagher Engine requires a valid Premium license") {
		t.Fatalf("unexpected error message: %v", res["error"])
	}
}
