package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func setupClusterTest(t *testing.T) (string, func()) {
	t.Helper()
	dir, err := os.MkdirTemp("", "cluster_test_*")
	if err != nil {
		t.Fatalf("MkdirTemp failed: %v", err)
	}

	origConfigDir := configDir
	configDir = dir
	clusterMu.Lock()
	clusterCache = nil
	clusterMu.Unlock()

	cleanup := func() {
		configDir = origConfigDir
		clusterMu.Lock()
		clusterCache = nil
		clusterMu.Unlock()
		_ = os.RemoveAll(dir)
	}

	return dir, cleanup
}

func TestClusterConfigPersistence(t *testing.T) {
	_, cleanup := setupClusterTest(t)
	defer cleanup()

	cfg := loadClusterConfig()
	if cfg.Enabled {
		t.Errorf("expected cluster disabled by default")
	}

	cfg.Enabled = true
	cfg.ClusterSecret = "test-secret-12345"
	cfg.PublicIP = "1.2.3.4"
	cfg.ServicePorts = []int{443, 8443}
	cfg.Nodes["node-2"] = ClusterNode{
		ID:       "node-2",
		Name:     "Iran Hub 2",
		APIURL:   "http://5.6.7.8:7777",
		PublicIP: "5.6.7.8",
	}

	if err := saveClusterConfig(cfg); err != nil {
		t.Fatalf("saveClusterConfig failed: %v", err)
	}

	// Invalidate cache and reload
	clusterMu.Lock()
	clusterCache = nil
	clusterMu.Unlock()

	reloaded := loadClusterConfig()
	if !reloaded.Enabled {
		t.Errorf("expected Enabled=true after reload")
	}
	if reloaded.ClusterSecret != "test-secret-12345" {
		t.Errorf("expected secret 'test-secret-12345', got '%s'", reloaded.ClusterSecret)
	}
	if len(reloaded.Nodes) != 1 || reloaded.Nodes["node-2"].PublicIP != "5.6.7.8" {
		t.Errorf("expected node-2 in reloaded nodes: %+v", reloaded.Nodes)
	}
}

func TestVerifyClusterSecret(t *testing.T) {
	req := httptest.NewRequest("POST", "/api/cluster/heartbeat", nil)
	secret := "secret-xyz"

	if verifyClusterSecret(req, secret) {
		t.Errorf("expected false when no auth header provided")
	}

	req.Header.Set("X-Cluster-Secret", "wrong-secret")
	if verifyClusterSecret(req, secret) {
		t.Errorf("expected false for wrong secret")
	}

	req.Header.Set("X-Cluster-Secret", secret)
	if !verifyClusterSecret(req, secret) {
		t.Errorf("expected true with valid X-Cluster-Secret")
	}

	// Test Bearer auth
	req2 := httptest.NewRequest("POST", "/api/cluster/heartbeat", nil)
	req2.Header.Set("Authorization", "Bearer "+secret)
	if !verifyClusterSecret(req2, secret) {
		t.Errorf("expected true with valid Authorization Bearer header")
	}
}

func TestClusterHeartbeatEndpoint(t *testing.T) {
	_, cleanup := setupClusterTest(t)
	defer cleanup()

	cfg := loadClusterConfig()
	cfg.ClusterSecret = "shhh-secret"
	cfg.NodeID = "node-1"
	cfg.PublicIP = "10.0.0.1"
	cfg.Nodes["node-2"] = ClusterNode{
		ID:       "node-2",
		Name:     "Peer 2",
		APIURL:   "http://10.0.0.2:7777",
		PublicIP: "10.0.0.2",
	}
	_ = saveClusterConfig(cfg)

	// 1. Unauthorized request
	req1 := httptest.NewRequest("POST", "/api/cluster/heartbeat", bytes.NewReader([]byte("{}")))
	w1 := httptest.NewRecorder()
	handleClusterHeartbeat(w1, req1)
	if w1.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 Unauthorized, got %d", w1.Code)
	}

	// 2. Authorized request
	payload := ClusterHeartbeatPayload{
		NodeID:       "node-2",
		PublicIP:     "10.0.0.2",
		TunnelStatus: "UP",
		TunnelLoss:   0.0,
		IsFailing:    false,
		Timestamp:    time.Now().Unix(),
	}
	body, _ := json.Marshal(payload)
	req2 := httptest.NewRequest("POST", "/api/cluster/heartbeat", bytes.NewReader(body))
	req2.Header.Set("X-Cluster-Secret", "shhh-secret")
	w2 := httptest.NewRecorder()
	handleClusterHeartbeat(w2, req2)

	if w2.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d: %s", w2.Code, w2.Body.String())
	}

	var resp ClusterHeartbeatPayload
	if err := json.Unmarshal(w2.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode heartbeat response: %v", err)
	}
	if resp.NodeID != "node-1" {
		t.Errorf("expected response NodeID 'node-1', got '%s'", resp.NodeID)
	}

	// Verify peer node status was updated in local state
	reloaded := loadClusterConfig()
	peer := reloaded.Nodes["node-2"]
	if !peer.IsHealthy || peer.TunnelStatus != "UP" {
		t.Errorf("expected peer node-2 to be healthy after heartbeat: %+v", peer)
	}
}

func TestClusterFailoverLoopPrevention(t *testing.T) {
	_, cleanup := setupClusterTest(t)
	defer cleanup()

	// Mock license
	activeLicenseMu.Lock()
	activeLicense = &LicensePayload{
		Customer:  "Test",
		Features:  []string{"cluster"},
		ExpiresAt: time.Now().Add(24 * time.Hour).Unix(),
	}
	activeLicenseMu.Unlock()
	defer func() {
		activeLicenseMu.Lock()
		activeLicense = nil
		activeLicenseMu.Unlock()
	}()

	cfg := loadClusterConfig()
	cfg.ClusterSecret = "sec"
	cfg.Nodes["bad-node"] = ClusterNode{
		ID:           "bad-node",
		Name:         "Failing Node",
		PublicIP:     "9.9.9.9",
		TunnelStatus: "DOWN",
		IsFailing:    true, // Node itself has a broken tunnel
	}
	_ = saveClusterConfig(cfg)

	// Attempt manual failover to the failing node
	body := []byte(`{"target_id":"bad-node"}`)
	req := httptest.NewRequest("POST", "/api/cluster/failover/trigger", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handleClusterFailoverTrigger(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 Bad Request due to loop prevention, got %d", w.Code)
	}
}

func TestClusterStatusLicenseGate(t *testing.T) {
	_, cleanup := setupClusterTest(t)
	defer cleanup()

	// Clear license
	activeLicense = nil

	// Config post without license must return 402
	body := []byte(`{"enabled":true}`)
	req := httptest.NewRequest("POST", "/api/cluster/config", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handleClusterConfigPost(w, req)

	if w.Code != http.StatusPaymentRequired {
		t.Errorf("expected 402 Payment Required when unlicensed, got %d", w.Code)
	}

	// Node add without license must return 402
	addBody := []byte(`{"id":"peer-1","api_url":"http://1.1.1.1:7777"}`)
	req2 := httptest.NewRequest("POST", "/api/cluster/nodes/add", bytes.NewReader(addBody))
	w2 := httptest.NewRecorder()
	handleClusterNodeAdd(w2, req2)

	if w2.Code != http.StatusPaymentRequired {
		t.Errorf("expected 402 Payment Required on node add when unlicensed, got %d", w2.Code)
	}
}
