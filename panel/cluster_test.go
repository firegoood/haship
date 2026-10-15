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

	// Clear license and set check time so disk is not re-queried during test
	activeLicenseMu.Lock()
	activeLicense = nil
	licenseCheckedAt = time.Now()
	activeLicenseMu.Unlock()

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

func TestClusterMultiForeignConfig(t *testing.T) {
	_, cleanup := setupClusterTest(t)
	defer cleanup()

	cfg := loadClusterConfig()
	if cfg.ForeignNodes == nil {
		t.Fatalf("expected ForeignNodes map to be initialized")
	}

	cfg.ForeignNodes["foreign-de"] = ForeignNode{
		ID:         "foreign-de",
		Name:       "Frankfurt Exit",
		PublicIP:   "91.107.174.173",
		TunnelPort: 55354,
		Protocol:   "wss",
		IsActive:   true,
	}
	cfg.ActiveForeign = "foreign-de"

	if err := saveClusterConfig(cfg); err != nil {
		t.Fatalf("saveClusterConfig failed: %v", err)
	}

	clusterMu.Lock()
	clusterCache = nil
	clusterMu.Unlock()

	reloaded := loadClusterConfig()
	if len(reloaded.ForeignNodes) != 1 {
		t.Fatalf("expected 1 foreign node, got %d", len(reloaded.ForeignNodes))
	}
	if reloaded.ActiveForeign != "foreign-de" {
		t.Fatalf("expected active_foreign 'foreign-de', got '%s'", reloaded.ActiveForeign)
	}
	fn := reloaded.ForeignNodes["foreign-de"]
	if fn.PublicIP != "91.107.174.173" || fn.TunnelPort != 55354 || fn.Protocol != "wss" {
		t.Errorf("unexpected foreign node fields: %+v", fn)
	}
}

func TestClusterForeignNodeEndpoints(t *testing.T) {
	_, cleanup := setupClusterTest(t)
	defer cleanup()

	// 1. Without license -> 402
	activeLicenseMu.Lock()
	activeLicense = nil
	activeLicenseMu.Unlock()

	bodyAdd := []byte(`{"id":"fn-1","name":"Kharej 1","public_ip":"198.51.100.1","tunnel_port":55354,"protocol":"wss"}`)
	req := httptest.NewRequest("POST", "/api/cluster/foreign/add", bytes.NewReader(bodyAdd))
	w := httptest.NewRecorder()
	handleClusterForeignNodeAdd(w, req)
	if w.Code != http.StatusPaymentRequired {
		t.Fatalf("expected 402, got %d", w.Code)
	}

	// 2. With license
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

	// Add foreign node 1
	req2 := httptest.NewRequest("POST", "/api/cluster/foreign/add", bytes.NewReader(bodyAdd))
	w2 := httptest.NewRecorder()
	handleClusterForeignNodeAdd(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w2.Code, w2.Body.String())
	}

	// Add foreign node 2
	bodyAdd2 := []byte(`{"id":"fn-2","name":"Kharej 2","public_ip":"198.51.100.2","tunnel_port":55354,"protocol":"gre"}`)
	req3 := httptest.NewRequest("POST", "/api/cluster/foreign/add", bytes.NewReader(bodyAdd2))
	w3 := httptest.NewRecorder()
	handleClusterForeignNodeAdd(w3, req3)
	if w3.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w3.Code)
	}

	cfg := loadClusterConfig()
	if len(cfg.ForeignNodes) != 2 {
		t.Fatalf("expected 2 foreign nodes, got %d", len(cfg.ForeignNodes))
	}
	if cfg.ActiveForeign != "fn-1" {
		t.Fatalf("expected active foreign fn-1, got %s", cfg.ActiveForeign)
	}

	// Switch active to fn-2
	bodySwitch := []byte(`{"target_id":"fn-2"}`)
	reqSwitch := httptest.NewRequest("POST", "/api/cluster/foreign/switch", bytes.NewReader(bodySwitch))
	wSwitch := httptest.NewRecorder()
	handleClusterForeignSwitch(wSwitch, reqSwitch)
	if wSwitch.Code != http.StatusOK {
		t.Fatalf("expected 200 on switch, got %d", wSwitch.Code)
	}

	cfg = loadClusterConfig()
	if cfg.ActiveForeign != "fn-2" {
		t.Fatalf("expected active foreign fn-2 after switch, got %s", cfg.ActiveForeign)
	}

	// Delete fn-1
	bodyDel := []byte(`{"id":"fn-1"}`)
	reqDel := httptest.NewRequest("POST", "/api/cluster/foreign/delete", bytes.NewReader(bodyDel))
	wDel := httptest.NewRecorder()
	handleClusterForeignNodeDelete(wDel, reqDel)
	if wDel.Code != http.StatusOK {
		t.Fatalf("expected 200 on delete, got %d", wDel.Code)
	}

	cfg = loadClusterConfig()
	if len(cfg.ForeignNodes) != 1 {
		t.Fatalf("expected 1 foreign node left, got %d", len(cfg.ForeignNodes))
	}
}

func TestClusterWeightedRoundRobinRules(t *testing.T) {
	cfg := ClusterConfig{
		Enabled:       true,
		BalancingMode: "wrr",
		ServicePorts:  []int{443, 8443},
		ForeignNodes: map[string]ForeignNode{
			"fn-1": {
				ID:        "fn-1",
				PublicIP:  "1.1.1.1",
				Weight:    1,
				IsHealthy: true,
			},
			"fn-2": {
				ID:        "fn-2",
				PublicIP:  "2.2.2.2",
				Weight:    2,
				IsHealthy: true,
			},
			"fn-down": {
				ID:        "fn-down",
				PublicIP:  "3.3.3.3",
				Weight:    5,
				IsHealthy: false, // Down node must NOT receive traffic
			},
		},
	}

	rules := generateClusterBalancingRules(&cfg)
	if len(rules) == 0 {
		t.Fatalf("expected balancing rules to be generated")
	}

	// Verify fn-down IP is not present in any rule
	for _, r := range rules {
		if bytes.Contains([]byte(r), []byte("3.3.3.3")) {
			t.Errorf("unhealthy node 3.3.3.3 found in balancing rules: %s", r)
		}
	}

	// Verify 1.1.1.1 and 2.2.2.2 are present
	has1 := false
	has2 := false
	for _, r := range rules {
		if bytes.Contains([]byte(r), []byte("1.1.1.1")) {
			has1 = true
		}
		if bytes.Contains([]byte(r), []byte("2.2.2.2")) {
			has2 = true
		}
	}
	if !has1 || !has2 {
		t.Errorf("expected both healthy nodes in rules, has1=%v has2=%v", has1, has2)
	}
}

func TestClusterCustomTargetPorts(t *testing.T) {
	cfg := ClusterConfig{
		Enabled:       true,
		BalancingMode: "wrr",
		ServicePorts:  []int{443},
		ForeignNodes: map[string]ForeignNode{
			"fn-custom": {
				ID:          "fn-custom",
				PublicIP:    "5.5.5.5",
				Weight:      1,
				IsHealthy:   true,
				TargetPorts: map[int]int{443: 8443}, // Map local 443 -> foreign 8443
			},
		},
	}

	rules := generateClusterBalancingRules(&cfg)
	matched := false
	for _, r := range rules {
		if bytes.Contains([]byte(r), []byte("5.5.5.5:8443")) {
			matched = true
			break
		}
	}
	if !matched {
		t.Errorf("expected destination 5.5.5.5:8443 in rules, got: %+v", rules)
	}
}

func TestCliClusterCommands(t *testing.T) {
	_, cleanup := setupClusterTest(t)
	defer cleanup()

	// 1. Status command
	if code := cliCluster([]string{"status"}); code != 0 {
		t.Fatalf("expected status to return 0, got %d", code)
	}

	// 2. Add foreign node
	if code := cliCluster([]string{"add-foreign", "test-de", "88.99.100.101", "7000", "2", "gre"}); code != 0 {
		t.Fatalf("expected add-foreign to return 0, got %d", code)
	}

	cfg := loadClusterConfig()
	if len(cfg.ForeignNodes) != 1 {
		t.Fatalf("expected 1 foreign node, got %d", len(cfg.ForeignNodes))
	}

	// 3. Set mode
	if code := cliCluster([]string{"set-mode", "wrr"}); code != 0 {
		t.Fatalf("expected set-mode to return 0, got %d", code)
	}
	cfg = loadClusterConfig()
	if cfg.BalancingMode != "wrr" {
		t.Fatalf("expected mode wrr, got %s", cfg.BalancingMode)
	}

	// 4. Switch foreign
	if code := cliCluster([]string{"switch-foreign", "test-de"}); code != 0 {
		t.Fatalf("expected switch-foreign to return 0, got %d", code)
	}

	// 5. Del foreign
	if code := cliCluster([]string{"del-foreign", "test-de"}); code != 0 {
		t.Fatalf("expected del-foreign to return 0, got %d", code)
	}
	cfg = loadClusterConfig()
	if len(cfg.ForeignNodes) != 0 {
		t.Fatalf("expected 0 foreign nodes after deletion, got %d", len(cfg.ForeignNodes))
	}
}
