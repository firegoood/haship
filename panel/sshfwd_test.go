package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

	// Test get_bundle gating via API
	bodyBundle := `{"action":"get_bundle"}`
	reqBundle := httptest.NewRequest("POST", "/api/ssh-fwd", strings.NewReader(bodyBundle))
	recBundle := httptest.NewRecorder()
	handleSSHFwdPost(recBundle, reqBundle)
	if recBundle.Code != http.StatusForbidden {
		t.Fatalf("expected status 403 Forbidden for un-licensed get_bundle, got %d", recBundle.Code)
	}

	// Test apply_bundle gating via API
	bodyApply := `{"action":"apply_bundle","bundle":"BAGHER:123"}`
	reqApply := httptest.NewRequest("POST", "/api/ssh-fwd", strings.NewReader(bodyApply))
	recApply := httptest.NewRecorder()
	handleSSHFwdPost(recApply, reqApply)
	if recApply.Code != http.StatusForbidden {
		t.Fatalf("expected status 403 Forbidden for un-licensed apply_bundle, got %d", recApply.Code)
	}

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

func TestBagherBundleRoundtrip(t *testing.T) {
	cfg := SSHFwdConfig{
		Mode:          "bagher",
		RemoteHost:    "1.2.3.4",
		RemoteSSHPort: 22,
		FRPBindPort:   55400,
		PoolCount:     25,
		Ports:         []int{443, 8443, 1020},
		BindAddr:      "127.0.0.1",
	}
	pub := "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGo345test hashem-bagher-carrier"

	bundleStr, err := MakeBagherBundle(cfg, pub)
	if err != nil {
		t.Fatalf("MakeBagherBundle failed: %v", err)
	}
	if !strings.HasPrefix(bundleStr, "BAGHER:") {
		t.Fatalf("expected bundle prefix 'BAGHER:', got: %s", bundleStr)
	}

	parsed, err := ParseBagherBundle(bundleStr)
	if err != nil {
		t.Fatalf("ParseBagherBundle failed: %v", err)
	}
	if parsed.FRPPort != 55400 {
		t.Errorf("expected FRPPort 55400, got: %d", parsed.FRPPort)
	}
	if parsed.PoolCount != 25 {
		t.Errorf("expected PoolCount 25, got: %d", parsed.PoolCount)
	}
	if len(parsed.Ports) != 3 || parsed.Ports[0] != 443 {
		t.Errorf("unexpected ports: %v", parsed.Ports)
	}
	if parsed.SSHPublicKey != pub {
		t.Errorf("expected pub key %q, got: %q", pub, parsed.SSHPublicKey)
	}

	// Corrupted bundle test
	if _, err := ParseBagherBundle("BAGHER:invalid-b64-here"); err == nil {
		t.Error("expected error parsing corrupted bundle, got nil")
	}
	if _, err := ParseBagherBundle("WRONGPREFIX:xxx"); err == nil {
		t.Error("expected error for wrong prefix, got nil")
	}
}

func TestBagherFormatByteSize(t *testing.T) {
	if formatByteSize(0) != "0 B" {
		t.Errorf("expected 0 B, got %s", formatByteSize(0))
	}
	if formatByteSize(500) != "500 B" {
		t.Errorf("expected 500 B, got %s", formatByteSize(500))
	}
	if formatByteSize(1024) != "1.0 KB" {
		t.Errorf("expected 1.0 KB, got %s", formatByteSize(1024))
	}
	if formatByteSize(1048576) != "1.0 MB" {
		t.Errorf("expected 1.0 MB, got %s", formatByteSize(1048576))
	}
	if formatByteSize(1073741824*2) != "2.0 GB" {
		t.Errorf("expected 2.0 GB, got %s", formatByteSize(1073741824*2))
	}
}

func TestBagherAPIEndpoints(t *testing.T) {
	activeLicenseMu.Lock()
	oldLic := activeLicense
	activeLicense = &LicensePayload{
		Customer:    "test",
		MachineHash: getMachineHash(),
		Features:    []string{"bagher", "frp_ssh"},
		ExpiresAt:   time.Now().Add(24 * time.Hour).Unix(),
	}
	activeLicenseMu.Unlock()
	defer func() {
		activeLicenseMu.Lock()
		activeLicense = oldLic
		activeLicenseMu.Unlock()
	}()

	// Test get_bundle without remote_host (should fail with 400)
	bodyNoHost := `{"action":"get_bundle"}`
	reqNoHost := httptest.NewRequest("POST", "/api/sshfwd", strings.NewReader(bodyNoHost))
	recNoHost := httptest.NewRecorder()
	handleSSHFwdPost(recNoHost, reqNoHost)
	if recNoHost.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for get_bundle without remote host, got %d", recNoHost.Code)
	}

	// Test get_bundle with valid remote_host and ports
	body := `{"action":"get_bundle","remote_host":"91.107.174.173","ports":"443,8443"}`
	req := httptest.NewRequest("POST", "/api/sshfwd", strings.NewReader(body))
	rec := httptest.NewRecorder()
	handleSSHFwdPost(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for get_bundle, got %d (body: %s)", rec.Code, rec.Body.String())
	}
	var res map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("invalid json from get_bundle: %v", err)
	}
	bundleStr, ok := res["bundle"].(string)
	if !ok || !strings.HasPrefix(bundleStr, "BAGHER:") {
		t.Fatalf("expected bundle starting with BAGHER:, got: %v", res["bundle"])
	}

	// Test apply_bundle with empty bundle
	bodyEmpty := `{"action":"apply_bundle","bundle":""}`
	reqEmpty := httptest.NewRequest("POST", "/api/sshfwd", strings.NewReader(bodyEmpty))
	recEmpty := httptest.NewRecorder()
	handleSSHFwdPost(recEmpty, reqEmpty)
	if recEmpty.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty bundle, got %d", recEmpty.Code)
	}

	// Test apply_bundle with invalid bundle
	bodyInvalid := `{"action":"apply_bundle","bundle":"NOT_BAGHER_FORMAT"}`
	reqInvalid := httptest.NewRequest("POST", "/api/sshfwd", strings.NewReader(bodyInvalid))
	recInvalid := httptest.NewRecorder()
	handleSSHFwdPost(recInvalid, reqInvalid)
	if recInvalid.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid bundle prefix, got %d", recInvalid.Code)
	}
}

func TestSSHFwdServiceBackoff(t *testing.T) {
	cfg := SSHFwdConfig{
		Mode:          "bagher",
		RemoteHost:    "1.2.3.4",
		RemoteUser:    "root",
		RemoteSSHPort: 22,
		KeyPath:       "/etc/gre-panel/sshfwd_id_ed25519",
		Ports:         []int{443, 8443},
		BindAddr:      "127.0.0.1",
		FRPBindPort:   55400,
	}

	svc := buildSSHFwdService(cfg)
	if !strings.Contains(svc, "RestartSec=15") {
		t.Fatalf("expected RestartSec=15 for fail2ban protection, got:\n%s", svc)
	}
	if !strings.Contains(svc, "StartLimitIntervalSec=120") {
		t.Fatalf("expected StartLimitIntervalSec=120 in service unit, got:\n%s", svc)
	}
	if !strings.Contains(svc, "ConnectTimeout=8") {
		t.Fatalf("expected ConnectTimeout=8 in ssh command, got:\n%s", svc)
	}
}
