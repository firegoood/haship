package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ClusterConfig persists the multi-Iran mesh cluster state.
type ClusterConfig struct {
	Enabled        bool                   `json:"enabled"`
	NodeID         string                 `json:"node_id"`
	ClusterSecret  string                 `json:"cluster_secret"`
	PublicIP       string                 `json:"public_ip"`
	ServicePorts   []int                  `json:"service_ports"`
	BalancingMode  string                 `json:"balancing_mode"` // "wrr" (weighted round-robin), "failover", "lowest_latency"
	Nodes          map[string]ClusterNode `json:"nodes"`          // Peer Iran Hubs (P2P mesh)
	ForeignNodes   map[string]ForeignNode `json:"foreign_nodes"`  // Foreign Exit Nodes Pool
	ActiveForeign  string                 `json:"active_foreign,omitempty"`
	AutoFailover   bool                   `json:"auto_failover"`
	ActiveFailover string                 `json:"active_failover,omitempty"` // Target NodeID if currently redirected
	FailoverTarget string                 `json:"failover_target,omitempty"` // Target Public IP
	Updated        string                 `json:"updated,omitempty"`
}

// ForeignNode represents an exit foreign server in the cluster pool.
type ForeignNode struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	PublicIP    string      `json:"public_ip"`
	TunnelPort  int         `json:"tunnel_port"`
	TargetPorts map[int]int `json:"target_ports,omitempty"` // Map local service port -> foreign target port (if custom)
	Weight      int         `json:"weight"`                 // Weight for WRR (default: 1)
	Protocol    string      `json:"protocol"`               // "gre", "wss", "bagher"
	IsActive    bool        `json:"is_active"`
	IsHealthy   bool        `json:"is_healthy"`
	LatencyMs   float64     `json:"latency_ms"`
	LastProbe   time.Time   `json:"last_probe"`
}

// ClusterNode represents a remote Iran hub peer in the cluster.
type ClusterNode struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	APIURL       string    `json:"api_url"` // e.g. "http://1.2.3.4:7777/secret"
	PublicIP     string    `json:"public_ip"`
	TunnelStatus string    `json:"tunnel_status"` // "UP", "DOWN", "DEGRADED"
	TunnelLoss   float64   `json:"tunnel_loss"`
	LatencyMs    float64   `json:"latency_ms"`
	LastSeen     time.Time `json:"last_seen"`
	IsHealthy    bool      `json:"is_healthy"`
	IsFailing    bool      `json:"is_failing"` // Remote peer's tunnel to Kharej is down
}

// ClusterHeartbeatPayload is exchanged between Iran nodes.
type ClusterHeartbeatPayload struct {
	NodeID       string  `json:"node_id"`
	PublicIP     string  `json:"public_ip"`
	TunnelStatus string  `json:"tunnel_status"`
	TunnelLoss   float64 `json:"tunnel_loss"`
	IsFailing    bool    `json:"is_failing"`
	Timestamp    int64   `json:"timestamp"`
}

var (
	clusterMu            sync.RWMutex
	clusterCache         *ClusterConfig
	clusterClient        = &http.Client{Timeout: 3 * time.Second}
	consecutiveFailures  int
	consecutiveSuccesses int
)

func clusterConfigFile() string {
	return filepath.Join(configDir, "cluster.json")
}

func defaultClusterConfig() ClusterConfig {
	return ClusterConfig{
		Enabled:       false,
		NodeID:        "iran-" + strconv.FormatInt(time.Now().Unix()%10000, 10),
		ClusterSecret: "",
		PublicIP:      "",
		ServicePorts:  []int{443, 8443, 2083},
		BalancingMode: "wrr",
		Nodes:         make(map[string]ClusterNode),
		ForeignNodes:  make(map[string]ForeignNode),
		AutoFailover:  true,
	}
}

func isClusterLicensed() bool {
	return HasFeature("bagher") || HasFeature("cluster")
}

// cloneClusterConfig deep-copies the maps and slices so a caller's copy never
// shares storage with clusterCache. Shared maps let handlers write while the
// monitor or JSON encoder iterated them: a fatal, unrecoverable runtime error.
func cloneClusterConfig(c ClusterConfig) ClusterConfig {
	out := c
	out.ServicePorts = append([]int(nil), c.ServicePorts...)
	out.Nodes = make(map[string]ClusterNode, len(c.Nodes))
	for k, v := range c.Nodes {
		out.Nodes[k] = v
	}
	out.ForeignNodes = make(map[string]ForeignNode, len(c.ForeignNodes))
	for k, v := range c.ForeignNodes {
		if v.TargetPorts != nil {
			tp := make(map[int]int, len(v.TargetPorts))
			for p, q := range v.TargetPorts {
				tp[p] = q
			}
			v.TargetPorts = tp
		}
		out.ForeignNodes[k] = v
	}
	return out
}

// loadClusterConfig returns a private copy of the cluster config.
func loadClusterConfig() ClusterConfig {
	clusterMu.Lock()
	defer clusterMu.Unlock()
	return cloneClusterConfig(*clusterCacheLocked())
}

// updateClusterRuntime mutates the cached config in place under clusterMu
// without persisting it; used for health state that is refreshed every tick.
func updateClusterRuntime(fn func(c *ClusterConfig)) {
	clusterMu.Lock()
	defer clusterMu.Unlock()
	fn(clusterCacheLocked())
}

// clusterCacheLocked loads clusterCache from disk if needed. Caller holds clusterMu.
func clusterCacheLocked() *ClusterConfig {
	if clusterCache != nil {
		return clusterCache
	}

	data, err := os.ReadFile(clusterConfigFile())
	if err != nil || len(data) == 0 {
		def := defaultClusterConfig()
		clusterCache = &def
		return clusterCache
	}

	var c ClusterConfig
	if err := json.Unmarshal(data, &c); err != nil {
		def := defaultClusterConfig()
		clusterCache = &def
		return clusterCache
	}

	if c.Nodes == nil {
		c.Nodes = make(map[string]ClusterNode)
	}
	if c.ForeignNodes == nil {
		c.ForeignNodes = make(map[string]ForeignNode)
	}
	for id, fn := range c.ForeignNodes {
		if fn.Weight <= 0 {
			fn.Weight = 1
			c.ForeignNodes[id] = fn
		}
	}
	if len(c.ServicePorts) == 0 {
		c.ServicePorts = []int{443, 8443, 2083}
	}
	if c.BalancingMode == "" {
		c.BalancingMode = "wrr"
	}
	clusterCache = &c
	return clusterCache
}

func saveClusterConfig(c ClusterConfig) error {
	clusterMu.Lock()
	defer clusterMu.Unlock()

	c.Updated = time.Now().Format("2006-01-02 15:04:05")
	if c.Nodes == nil {
		c.Nodes = make(map[string]ClusterNode)
	}
	if c.ForeignNodes == nil {
		c.ForeignNodes = make(map[string]ForeignNode)
	}

	_ = os.MkdirAll(configDir, 0700)
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}

	tmp := clusterConfigFile() + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}

	if err := os.Rename(tmp, clusterConfigFile()); err != nil {
		return err
	}

	saved := cloneClusterConfig(c)
	clusterCache = &saved
	return nil
}

// verifyClusterSecret checks incoming inter-node request authentication.
func verifyClusterSecret(r *http.Request, secret string) bool {
	if secret == "" {
		return false
	}
	got := r.Header.Get("X-Cluster-Secret")
	if got == "" {
		auth := r.Header.Get("Authorization")
		if strings.HasPrefix(auth, "Bearer ") {
			got = strings.TrimPrefix(auth, "Bearer ")
		}
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(secret)) == 1
}

// handleClusterStatus returns current cluster mesh overview (licensed UI only).
func handleClusterStatus(w http.ResponseWriter, r *http.Request) {
	licensed := isClusterLicensed()
	cfg := loadClusterConfig()

	// Get local tunnel health
	localStatus, localLoss, localLat := getLocalTunnelStatus()

	type clusterStatusResponse struct {
		Licensed       bool                   `json:"licensed"`
		Enabled        bool                   `json:"enabled"`
		NodeID         string                 `json:"node_id"`
		PublicIP       string                 `json:"public_ip"`
		ClusterSecret  string                 `json:"cluster_secret"`
		ServicePorts   []int                  `json:"service_ports"`
		AutoFailover   bool                   `json:"auto_failover"`
		ActiveFailover string                 `json:"active_failover"`
		FailoverTarget string                 `json:"failover_target"`
		LocalTunnel    map[string]any         `json:"local_tunnel"`
		Nodes          map[string]ClusterNode `json:"nodes"`
		ForeignNodes   map[string]ForeignNode `json:"foreign_nodes"`
		ActiveForeign  string                 `json:"active_foreign"`
		Updated        string                 `json:"updated"`
	}

	resp := clusterStatusResponse{
		Licensed:       licensed,
		Enabled:        cfg.Enabled,
		NodeID:         cfg.NodeID,
		PublicIP:       cfg.PublicIP,
		ClusterSecret:  cfg.ClusterSecret,
		ServicePorts:   cfg.ServicePorts,
		AutoFailover:   cfg.AutoFailover,
		ActiveFailover: cfg.ActiveFailover,
		FailoverTarget: cfg.FailoverTarget,
		LocalTunnel: map[string]any{
			"status":     localStatus,
			"loss_pct":   localLoss,
			"latency_ms": localLat,
		},
		Nodes:         cfg.Nodes,
		ForeignNodes:  cfg.ForeignNodes,
		ActiveForeign: cfg.ActiveForeign,
		Updated:       cfg.Updated,
	}

	writeJSON(w, resp)
}

// handleClusterConfigPost updates cluster settings.
func handleClusterConfigPost(w http.ResponseWriter, r *http.Request) {
	if !isClusterLicensed() {
		http.Error(w, `{"error":"Cluster mesh requires an active Bagher or Cluster license"}`, http.StatusPaymentRequired)
		return
	}

	var req struct {
		Enabled       *bool  `json:"enabled"`
		NodeID        string `json:"node_id"`
		ClusterSecret string `json:"cluster_secret"`
		PublicIP      string `json:"public_ip"`
		ServicePorts  []int  `json:"service_ports"`
		BalancingMode string `json:"balancing_mode"`
		AutoFailover  *bool  `json:"auto_failover"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json body"}`, http.StatusBadRequest)
		return
	}

	cfg := loadClusterConfig()
	if req.Enabled != nil {
		cfg.Enabled = *req.Enabled
	}
	if strings.TrimSpace(req.NodeID) != "" {
		cfg.NodeID = strings.TrimSpace(req.NodeID)
	}
	if req.ClusterSecret != "" {
		cfg.ClusterSecret = strings.TrimSpace(req.ClusterSecret)
	}
	if req.PublicIP != "" {
		cfg.PublicIP = strings.TrimSpace(req.PublicIP)
	}
	if len(req.ServicePorts) > 0 {
		var validPorts []int
		for _, p := range req.ServicePorts {
			if p > 0 && p < 65536 {
				validPorts = append(validPorts, p)
			}
		}
		if len(validPorts) > 0 {
			cfg.ServicePorts = validPorts
		}
	}
	if req.BalancingMode != "" {
		bm := strings.ToLower(strings.TrimSpace(req.BalancingMode))
		if bm == "wrr" || bm == "failover" || bm == "lowest_latency" {
			cfg.BalancingMode = bm
		}
	}
	if req.AutoFailover != nil {
		cfg.AutoFailover = *req.AutoFailover
	}

	if err := saveClusterConfig(cfg); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"failed to save config: %s"}`, err.Error()), http.StatusInternalServerError)
		return
	}

	if cfg.Enabled && cfg.BalancingMode == "wrr" && len(cfg.ForeignNodes) > 0 {
		_ = applyClusterLoadBalancing(&cfg)
	} else if !cfg.Enabled {
		_ = clearClusterFailover(&cfg)
	}

	writeJSON(w, map[string]string{"status": "ok"})
}

// handleClusterNodeAdd adds or updates a peer Iran node.
func handleClusterNodeAdd(w http.ResponseWriter, r *http.Request) {
	if !isClusterLicensed() {
		http.Error(w, `{"error":"Cluster mesh requires an active Bagher or Cluster license"}`, http.StatusPaymentRequired)
		return
	}

	var req struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		APIURL   string `json:"api_url"`
		PublicIP string `json:"public_ip"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	req.ID = strings.TrimSpace(req.ID)
	req.APIURL = strings.TrimRight(strings.TrimSpace(req.APIURL), "/")
	if req.ID == "" || req.APIURL == "" {
		http.Error(w, `{"error":"id and api_url are required"}`, http.StatusBadRequest)
		return
	}

	cfg := loadClusterConfig()
	if req.ID == cfg.NodeID {
		http.Error(w, `{"error":"cannot add self as peer node"}`, http.StatusBadRequest)
		return
	}

	node := ClusterNode{
		ID:           req.ID,
		Name:         req.Name,
		APIURL:       req.APIURL,
		PublicIP:     strings.TrimSpace(req.PublicIP),
		TunnelStatus: "UNKNOWN",
		LastSeen:     time.Time{},
		IsHealthy:    false,
	}

	// Immediate probe to test handshake
	if cfg.ClusterSecret != "" {
		probe, lat, err := sendClusterHeartbeat(node.APIURL, cfg.ClusterSecret, ClusterHeartbeatPayload{
			NodeID:   cfg.NodeID,
			PublicIP: cfg.PublicIP,
		})
		if err == nil {
			node.TunnelStatus = probe.TunnelStatus
			node.TunnelLoss = probe.TunnelLoss
			node.LatencyMs = lat
			node.IsFailing = probe.IsFailing
			node.IsHealthy = true
			node.LastSeen = time.Now()
			if node.PublicIP == "" && probe.PublicIP != "" {
				node.PublicIP = probe.PublicIP
			}
		}
	}

	cfg.Nodes[req.ID] = node
	if err := saveClusterConfig(cfg); err != nil {
		http.Error(w, `{"error":"failed to save"}`, http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]any{"status": "ok", "node": node})
}

// handleClusterNodeDelete removes a peer node from the cluster.
func handleClusterNodeDelete(w http.ResponseWriter, r *http.Request) {
	if !isClusterLicensed() {
		http.Error(w, `{"error":"license required"}`, http.StatusPaymentRequired)
		return
	}

	var req struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	cfg := loadClusterConfig()
	delete(cfg.Nodes, req.ID)
	if cfg.ActiveFailover == req.ID {
		_ = clearClusterFailover(&cfg)
	}

	if err := saveClusterConfig(cfg); err != nil {
		http.Error(w, `{"error":"failed to save"}`, http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]string{"status": "ok"})
}

// handleClusterForeignNodeAdd adds or updates a foreign exit node.
func handleClusterForeignNodeAdd(w http.ResponseWriter, r *http.Request) {
	if !isClusterLicensed() {
		http.Error(w, `{"error":"license required"}`, http.StatusPaymentRequired)
		return
	}

	var req struct {
		ID          string      `json:"id"`
		Name        string      `json:"name"`
		PublicIP    string      `json:"public_ip"`
		TunnelPort  int         `json:"tunnel_port"`
		Protocol    string      `json:"protocol"`
		Weight      int         `json:"weight"`
		TargetPorts map[int]int `json:"target_ports"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	req.ID = strings.TrimSpace(req.ID)
	req.PublicIP = strings.TrimSpace(req.PublicIP)
	if req.ID == "" || req.PublicIP == "" {
		http.Error(w, `{"error":"id and public_ip are required"}`, http.StatusBadRequest)
		return
	}
	if req.TunnelPort <= 0 {
		req.TunnelPort = 55354
	}
	if req.Protocol == "" {
		req.Protocol = "wss"
	}
	if req.Weight <= 0 {
		req.Weight = 1
	}

	cfg := loadClusterConfig()
	fn := ForeignNode{
		ID:          req.ID,
		Name:        req.Name,
		PublicIP:    req.PublicIP,
		TunnelPort:  req.TunnelPort,
		Protocol:    req.Protocol,
		Weight:      req.Weight,
		TargetPorts: req.TargetPorts,
		IsActive:    len(cfg.ForeignNodes) == 0,
		LastProbe:   time.Now(),
	}

	status, lat := probeForeignNodeHealth(fn)
	fn.IsHealthy = (status == "UP")
	fn.LatencyMs = lat

	if cfg.ForeignNodes == nil {
		cfg.ForeignNodes = make(map[string]ForeignNode)
	}
	cfg.ForeignNodes[req.ID] = fn
	if cfg.ActiveForeign == "" {
		cfg.ActiveForeign = req.ID
	}

	if err := saveClusterConfig(cfg); err != nil {
		http.Error(w, `{"error":"failed to save"}`, http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]any{"status": "ok", "foreign_node": fn})
}

// handleClusterForeignNodeDelete removes a foreign exit node from the pool.
func handleClusterForeignNodeDelete(w http.ResponseWriter, r *http.Request) {
	if !isClusterLicensed() {
		http.Error(w, `{"error":"license required"}`, http.StatusPaymentRequired)
		return
	}

	var req struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	cfg := loadClusterConfig()
	delete(cfg.ForeignNodes, req.ID)
	if cfg.ActiveForeign == req.ID {
		cfg.ActiveForeign = ""
		for k, fn := range cfg.ForeignNodes {
			cfg.ActiveForeign = k
			fn.IsActive = true
			cfg.ForeignNodes[k] = fn
			break
		}
	}

	if err := saveClusterConfig(cfg); err != nil {
		http.Error(w, `{"error":"failed to save"}`, http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]string{"status": "ok"})
}

// handleClusterForeignSwitch switches the active foreign exit node.
func handleClusterForeignSwitch(w http.ResponseWriter, r *http.Request) {
	if !isClusterLicensed() {
		http.Error(w, `{"error":"license required"}`, http.StatusPaymentRequired)
		return
	}

	var req struct {
		TargetID string `json:"target_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	cfg := loadClusterConfig()
	target, exists := cfg.ForeignNodes[req.TargetID]
	if !exists {
		http.Error(w, `{"error":"target foreign node not found"}`, http.StatusBadRequest)
		return
	}

	for k, fn := range cfg.ForeignNodes {
		fn.IsActive = (k == req.TargetID)
		cfg.ForeignNodes[k] = fn
	}
	cfg.ActiveForeign = req.TargetID

	if err := saveClusterConfig(cfg); err != nil {
		http.Error(w, `{"error":"failed to save"}`, http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]any{"status": "ok", "active_foreign": target.ID})
}

// handleClusterHeartbeat is the inter-node endpoint for gossip and status exchange.
func handleClusterHeartbeat(w http.ResponseWriter, r *http.Request) {
	cfg := loadClusterConfig()
	if !verifyClusterSecret(r, cfg.ClusterSecret) {
		http.Error(w, `{"error":"unauthorized cluster secret"}`, http.StatusUnauthorized)
		return
	}

	var payload ClusterHeartbeatPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, `{"error":"invalid json payload"}`, http.StatusBadRequest)
		return
	}

	// Update record of peer
	if payload.NodeID != "" && payload.NodeID != cfg.NodeID {
		updateClusterRuntime(func(c *ClusterConfig) {
			if existing, ok := c.Nodes[payload.NodeID]; ok {
				existing.TunnelStatus = payload.TunnelStatus
				existing.TunnelLoss = payload.TunnelLoss
				existing.IsFailing = payload.IsFailing
				existing.IsHealthy = payload.TunnelStatus == "UP" && !payload.IsFailing
				existing.LastSeen = time.Now()
				if payload.PublicIP != "" {
					existing.PublicIP = payload.PublicIP
				}
				c.Nodes[payload.NodeID] = existing
			}
		})
	}

	localStatus, localLoss, _ := getLocalTunnelStatus()
	resp := ClusterHeartbeatPayload{
		NodeID:       cfg.NodeID,
		PublicIP:     cfg.PublicIP,
		TunnelStatus: localStatus,
		TunnelLoss:   localLoss,
		IsFailing:    localStatus != "UP",
		Timestamp:    time.Now().Unix(),
	}

	writeJSON(w, resp)
}

// handleClusterFailoverTrigger manually sets or tests rerouting to a peer node.
func handleClusterFailoverTrigger(w http.ResponseWriter, r *http.Request) {
	if !isClusterLicensed() {
		http.Error(w, `{"error":"license required"}`, http.StatusPaymentRequired)
		return
	}

	var req struct {
		TargetID string `json:"target_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	cfg := loadClusterConfig()
	target, ok := cfg.Nodes[req.TargetID]
	if !ok || target.PublicIP == "" {
		http.Error(w, `{"error":"target node not found or has no public IP"}`, http.StatusBadRequest)
		return
	}

	if target.IsFailing {
		http.Error(w, `{"error":"target node tunnel is failing; cannot reroute to it"}`, http.StatusBadRequest)
		return
	}

	if err := applyClusterFailover(&cfg, target); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"failed to apply failover: %s"}`, err.Error()), http.StatusInternalServerError)
		return
	}

	_ = saveClusterConfig(cfg)
	writeJSON(w, map[string]string{"status": "ok", "active_failover": target.ID})
}

// handleClusterFailoverRevert reverts rerouting back to local tunnel.
func handleClusterFailoverRevert(w http.ResponseWriter, r *http.Request) {
	if !isClusterLicensed() {
		http.Error(w, `{"error":"license required"}`, http.StatusPaymentRequired)
		return
	}

	cfg := loadClusterConfig()
	if err := clearClusterFailover(&cfg); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"failed to clear failover: %s"}`, err.Error()), http.StatusInternalServerError)
		return
	}

	_ = saveClusterConfig(cfg)
	writeJSON(w, map[string]string{"status": "ok", "active_failover": ""})
}

// sendClusterHeartbeat contacts a peer node and measures latency.
func sendClusterHeartbeat(apiURL string, secret string, req ClusterHeartbeatPayload) (*ClusterHeartbeatPayload, float64, error) {
	body, _ := json.Marshal(req)
	url := strings.TrimRight(apiURL, "/") + "/api/cluster/heartbeat"

	httpReq, err := http.NewRequestWithContext(context.Background(), "POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Cluster-Secret", secret)

	start := time.Now()
	resp, err := clusterClient.Do(httpReq)
	lat := float64(time.Since(start).Microseconds()) / 1000.0
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, lat, fmt.Errorf("peer status %d: %s", resp.StatusCode, string(b))
	}

	var res ClusterHeartbeatPayload
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, lat, err
	}

	return &res, lat, nil
}

// probeForeignNodeHealth performs a synthetic TCP connection test to the foreign exit node.
func probeForeignNodeHealth(node ForeignNode) (status string, latency float64) {
	if node.PublicIP == "" || node.TunnelPort <= 0 {
		return "UNKNOWN", 0
	}
	addr := net.JoinHostPort(node.PublicIP, strconv.Itoa(node.TunnelPort))
	start := time.Now()
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		return "DOWN", 0
	}
	_ = conn.Close()
	lat := float64(time.Since(start).Microseconds()) / 1000.0
	return "UP", lat
}

// getLocalTunnelStatus inspects the local machine's connection to Kharej.
func getLocalTunnelStatus() (status string, loss float64, latency float64) {
	cfg := loadClusterConfig()
	if cfg.ActiveForeign != "" && len(cfg.ForeignNodes) > 0 {
		if fn, ok := cfg.ForeignNodes[cfg.ActiveForeign]; ok {
			s, lat := probeForeignNodeHealth(fn)
			if s == "UP" {
				return "UP", 0, lat
			}
			return "DOWN", 100.0, 0
		}
	}

	peer := loadPeerConfig()
	if peer.PeerURL != "" {
		if peer.IsConnected {
			return "UP", 0, peer.LatencyMs
		}
		return "DOWN", 100.0, 0
	}

	// Check tunnel health cache
	th := tunnelHealthCached()
	if th != nil && len(th.Tunnels) > 0 {
		for _, t := range th.Tunnels {
			if t.Verdict == "PASS" || t.Verdict == "UP" {
				return "UP", 0, t.LatencyMs
			}
		}
		return "DOWN", 100.0, 0
	}

	// Active check: can we reach internet DNS / gateway?
	conn, err := net.DialTimeout("tcp", "1.1.1.1:53", 2*time.Second)
	if err == nil {
		_ = conn.Close()
		return "UP", 0, 5.0
	}

	return "DOWN", 100.0, 0
}

func ensureClusterChains() {
	_ = exec.Command("iptables", "-t", "nat", "-N", "HASHEM-CLUSTER-PREROUTING").Run()
	_ = exec.Command("iptables", "-t", "nat", "-N", "HASHEM-CLUSTER-POSTROUTING").Run()

	if err := exec.Command("iptables", "-t", "nat", "-C", "PREROUTING", "-j", "HASHEM-CLUSTER-PREROUTING").Run(); err != nil {
		_ = exec.Command("iptables", "-t", "nat", "-I", "PREROUTING", "1", "-j", "HASHEM-CLUSTER-PREROUTING").Run()
	}
	if err := exec.Command("iptables", "-t", "nat", "-C", "POSTROUTING", "-j", "HASHEM-CLUSTER-POSTROUTING").Run(); err != nil {
		_ = exec.Command("iptables", "-t", "nat", "-I", "POSTROUTING", "1", "-j", "HASHEM-CLUSTER-POSTROUTING").Run()
	}
}

// applyClusterFailover adds safe iptables DNAT/MASQUERADE rules inside dedicated HASHEM-CLUSTER chains.
func applyClusterFailover(cfg *ClusterConfig, target ClusterNode) error {
	if target.PublicIP == "" {
		return fmt.Errorf("target node has no public IP")
	}

	ensureClusterChains()
	_ = clearClusterFailover(cfg)

	// Enable IP forwarding
	_ = exec.Command("sysctl", "-w", "net.ipv4.ip_forward=1").Run()

	for _, port := range cfg.ServicePorts {
		pStr := strconv.Itoa(port)
		// HASHEM-CLUSTER-PREROUTING TCP & UDP
		_ = exec.Command("iptables", "-t", "nat", "-A", "HASHEM-CLUSTER-PREROUTING", "-p", "tcp", "--dport", pStr, "-j", "DNAT", "--to-destination", target.PublicIP+":"+pStr).Run()
		_ = exec.Command("iptables", "-t", "nat", "-A", "HASHEM-CLUSTER-PREROUTING", "-p", "udp", "--dport", pStr, "-j", "DNAT", "--to-destination", target.PublicIP+":"+pStr).Run()
		// HASHEM-CLUSTER-POSTROUTING MASQUERADE
		_ = exec.Command("iptables", "-t", "nat", "-A", "HASHEM-CLUSTER-POSTROUTING", "-d", target.PublicIP, "-p", "tcp", "--dport", pStr, "-j", "MASQUERADE").Run()
		_ = exec.Command("iptables", "-t", "nat", "-A", "HASHEM-CLUSTER-POSTROUTING", "-d", target.PublicIP, "-p", "udp", "--dport", pStr, "-j", "MASQUERADE").Run()
	}

	cfg.ActiveFailover = target.ID
	cfg.FailoverTarget = target.PublicIP
	log.Printf("[cluster] failover activated: rerouting ports %v to %s (%s)", cfg.ServicePorts, target.ID, target.PublicIP)
	return nil
}

// clearClusterFailover removes iptables rerouting rules cleanly by flushing dedicated chains.
func clearClusterFailover(cfg *ClusterConfig) error {
	ensureClusterChains()
	_ = exec.Command("iptables", "-t", "nat", "-F", "HASHEM-CLUSTER-PREROUTING").Run()
	_ = exec.Command("iptables", "-t", "nat", "-F", "HASHEM-CLUSTER-POSTROUTING").Run()

	cfg.ActiveFailover = ""
	cfg.FailoverTarget = ""
	log.Printf("[cluster] failover cleared: returned to local tunnel")
	return nil
}

// generateClusterBalancingRules constructs iptables WRR load balancing rules across healthy foreign nodes.
func generateClusterBalancingRules(cfg *ClusterConfig) []string {
	if cfg == nil || !cfg.Enabled || len(cfg.ServicePorts) == 0 {
		return nil
	}

	type targetNode struct {
		id          string
		ip          string
		weight      int
		targetPorts map[int]int
	}

	var healthy []targetNode
	for id, fn := range cfg.ForeignNodes {
		if fn.IsHealthy && fn.PublicIP != "" {
			w := fn.Weight
			if w <= 0 {
				w = 1
			}
			healthy = append(healthy, targetNode{
				id:          id,
				ip:          fn.PublicIP,
				weight:      w,
				targetPorts: fn.TargetPorts,
			})
		}
	}

	sort.Slice(healthy, func(i, j int) bool {
		return healthy[i].id < healthy[j].id
	})

	if len(healthy) == 0 {
		return nil
	}

	var rules []string
	totalWeight := 0
	for _, n := range healthy {
		totalWeight += n.weight
	}

	for _, port := range cfg.ServicePorts {
		pStr := strconv.Itoa(port)
		remainingWeight := totalWeight

		for i, node := range healthy {
			targetPort := port
			if node.targetPorts != nil && node.targetPorts[port] > 0 {
				targetPort = node.targetPorts[port]
			}
			targetDst := fmt.Sprintf("%s:%d", node.ip, targetPort)

			isLast := (i == len(healthy)-1)
			if isLast || remainingWeight <= node.weight {
				// Remainder traffic
				rules = append(rules, fmt.Sprintf("iptables -t nat -A HASHEM-CLUSTER-PREROUTING -p tcp --dport %s -j DNAT --to-destination %s", pStr, targetDst))
				rules = append(rules, fmt.Sprintf("iptables -t nat -A HASHEM-CLUSTER-PREROUTING -p udp --dport %s -j DNAT --to-destination %s", pStr, targetDst))
			} else {
				prob := float64(node.weight) / float64(remainingWeight)
				probStr := fmt.Sprintf("%.4f", prob)
				rules = append(rules, fmt.Sprintf("iptables -t nat -A HASHEM-CLUSTER-PREROUTING -p tcp --dport %s -m statistic --mode random --probability %s -j DNAT --to-destination %s", pStr, probStr, targetDst))
				rules = append(rules, fmt.Sprintf("iptables -t nat -A HASHEM-CLUSTER-PREROUTING -p udp --dport %s -m statistic --mode random --probability %s -j DNAT --to-destination %s", pStr, probStr, targetDst))
				remainingWeight -= node.weight
			}

			rules = append(rules, fmt.Sprintf("iptables -t nat -A HASHEM-CLUSTER-POSTROUTING -d %s -p tcp --dport %d -j MASQUERADE", node.ip, targetPort))
			rules = append(rules, fmt.Sprintf("iptables -t nat -A HASHEM-CLUSTER-POSTROUTING -d %s -p udp --dport %d -j MASQUERADE", node.ip, targetPort))
		}
	}

	return rules
}

// applyClusterLoadBalancing applies kernel-level iptables WRR load balancing across healthy foreign nodes.
func applyClusterLoadBalancing(cfg *ClusterConfig) error {
	ensureClusterChains()
	_ = clearClusterFailover(cfg)

	rules := generateClusterBalancingRules(cfg)
	if len(rules) == 0 {
		return nil
	}

	// Enable IP forwarding
	_ = exec.Command("sysctl", "-w", "net.ipv4.ip_forward=1").Run()

	for _, rule := range rules {
		parts := strings.Fields(rule)
		if len(parts) > 1 {
			_ = exec.Command(parts[0], parts[1:]...).Run()
		}
	}

	log.Printf("[cluster] load balancing applied: %d rules across %d foreign nodes", len(rules), len(cfg.ForeignNodes))
	return nil
}

var lastClusterBalancingHash string

// persistClusterFailover saves only the failover fields onto the latest config,
// so the monitor's (seconds-old) copy never overwrites nodes edited meanwhile.
func persistClusterFailover(active, target string) {
	fresh := loadClusterConfig()
	fresh.ActiveFailover = active
	fresh.FailoverTarget = target
	_ = saveClusterConfig(fresh)
}

// startClusterMonitor runs the periodic gossip and failover check loop.
func startClusterMonitor() {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		if !isClusterLicensed() {
			continue
		}

		cfg := loadClusterConfig()
		if !cfg.Enabled || (len(cfg.Nodes) == 0 && len(cfg.ForeignNodes) == 0) {
			continue
		}

		// cfg is a private copy; probeMu guards it while probes run, and the
		// results are then published to the shared cache.
		var probeMu sync.Mutex

		// Probe foreign nodes pool
		if len(cfg.ForeignNodes) > 0 {
			ids := make([]string, 0, len(cfg.ForeignNodes))
			nodes := make([]ForeignNode, 0, len(cfg.ForeignNodes))
			for fid, fnode := range cfg.ForeignNodes {
				ids = append(ids, fid)
				nodes = append(nodes, fnode)
			}
			var fwg sync.WaitGroup
			for i := range ids {
				fwg.Add(1)
				go func(id string, fn ForeignNode) {
					defer fwg.Done()
					status, lat := probeForeignNodeHealth(fn)
					probeMu.Lock()
					fn.IsHealthy = (status == "UP")
					fn.LatencyMs = lat
					fn.LastProbe = time.Now()
					cfg.ForeignNodes[id] = fn
					probeMu.Unlock()
				}(ids[i], nodes[i])
			}
			fwg.Wait()
			updateClusterRuntime(func(c *ClusterConfig) {
				for id, probed := range cfg.ForeignNodes {
					if existing, ok := c.ForeignNodes[id]; ok {
						existing.IsHealthy = probed.IsHealthy
						existing.LatencyMs = probed.LatencyMs
						existing.LastProbe = probed.LastProbe
						c.ForeignNodes[id] = existing
					}
				}
			})

			// In WRR Load Balancing mode, synchronize kernel rules with healthy foreign nodes
			if cfg.Enabled && cfg.BalancingMode == "wrr" {
				rules := generateClusterBalancingRules(&cfg)
				rulesHash := strings.Join(rules, "\n")
				if rulesHash != lastClusterBalancingHash {
					_ = applyClusterLoadBalancing(&cfg)
					lastClusterBalancingHash = rulesHash
				}
			} else if !cfg.Enabled && lastClusterBalancingHash != "" {
				_ = clearClusterFailover(&cfg)
				lastClusterBalancingHash = ""
			}
		}

		if len(cfg.Nodes) == 0 || cfg.ClusterSecret == "" {
			continue
		}

		localStatus, localLoss, _ := getLocalTunnelStatus()
		isLocalFailing := localStatus != "UP" || localLoss > 50.0

		// Probe peer nodes concurrently
		peerIDs := make([]string, 0, len(cfg.Nodes))
		peers := make([]ClusterNode, 0, len(cfg.Nodes))
		for id, node := range cfg.Nodes {
			peerIDs = append(peerIDs, id)
			peers = append(peers, node)
		}
		var wg sync.WaitGroup
		for i := range peerIDs {
			wg.Add(1)
			go func(nid string, n ClusterNode) {
				defer wg.Done()
				res, lat, err := sendClusterHeartbeat(n.APIURL, cfg.ClusterSecret, ClusterHeartbeatPayload{
					NodeID:       cfg.NodeID,
					PublicIP:     cfg.PublicIP,
					TunnelStatus: localStatus,
					TunnelLoss:   localLoss,
					IsFailing:    isLocalFailing,
				})

				probeMu.Lock()
				defer probeMu.Unlock()
				if updated, exists := cfg.Nodes[nid]; exists {
					if err == nil {
						updated.TunnelStatus = res.TunnelStatus
						updated.TunnelLoss = res.TunnelLoss
						updated.IsFailing = res.IsFailing
						updated.IsHealthy = res.TunnelStatus == "UP" && !res.IsFailing
						updated.LatencyMs = lat
						updated.LastSeen = time.Now()
						if updated.PublicIP == "" && res.PublicIP != "" {
							updated.PublicIP = res.PublicIP
						}
					} else {
						updated.IsHealthy = false
						updated.LatencyMs = 0
					}
					cfg.Nodes[nid] = updated
				}
			}(peerIDs[i], peers[i])
		}
		wg.Wait()
		updateClusterRuntime(func(c *ClusterConfig) {
			for id, probed := range cfg.Nodes {
				if existing, ok := c.Nodes[id]; ok {
					existing.TunnelStatus = probed.TunnelStatus
					existing.TunnelLoss = probed.TunnelLoss
					existing.IsFailing = probed.IsFailing
					existing.IsHealthy = probed.IsHealthy
					existing.LatencyMs = probed.LatencyMs
					existing.LastSeen = probed.LastSeen
					if existing.PublicIP == "" {
						existing.PublicIP = probed.PublicIP
					}
					c.Nodes[id] = existing
				}
			}
		})

		// Evaluate auto-failover
		if cfg.AutoFailover {
			if isLocalFailing {
				consecutiveSuccesses = 0
				consecutiveFailures++
				// Require 3 consecutive failed cycles (approx 9s) to prevent flapping
				if consecutiveFailures >= 3 && cfg.ActiveFailover == "" {
					// Select best candidate: healthy, not failing, lowest latency, valid IP
					var bestNode *ClusterNode
					for _, candidate := range cfg.Nodes {
						if candidate.IsHealthy && !candidate.IsFailing && candidate.PublicIP != "" {
							if bestNode == nil || candidate.LatencyMs < bestNode.LatencyMs {
								n := candidate
								bestNode = &n
							}
						}
					}
					if bestNode != nil {
						_ = applyClusterFailover(&cfg, *bestNode)
						persistClusterFailover(cfg.ActiveFailover, cfg.FailoverTarget)
					}
				}
			} else {
				consecutiveFailures = 0
				consecutiveSuccesses++
				// Revert if healthy for 3 cycles and currently failed over
				if consecutiveSuccesses >= 3 && cfg.ActiveFailover != "" {
					_ = clearClusterFailover(&cfg)
					persistClusterFailover("", "")
				}
			}
		}
	}
}

func cliCluster(args []string) int {
	if len(args) == 0 || args[0] == "status" {
		cfg := loadClusterConfig()
		fmt.Printf("Cluster Enabled:  %v\n", cfg.Enabled)
		fmt.Printf("Node ID:          %s\n", cfg.NodeID)
		fmt.Printf("Balancing Mode:   %s\n", cfg.BalancingMode)
		fmt.Printf("Public IP:        %s\n", cfg.PublicIP)
		fmt.Printf("Auto Failover:    %v\n", cfg.AutoFailover)
		fmt.Printf("Active Failover:  %v\n", cfg.ActiveFailover != "")
		if cfg.ActiveFailover != "" {
			fmt.Printf("Failover Target:  %s (%s)\n", cfg.ActiveFailover, cfg.FailoverTarget)
		}
		fmt.Printf("Peer Nodes:       %d\n", len(cfg.Nodes))
		for id, node := range cfg.Nodes {
			fmt.Printf(" - %s (%s, %s): Healthy=%v, Tunnel=%s\n", id, node.Name, node.PublicIP, node.IsHealthy, node.TunnelStatus)
		}
		fmt.Printf("Foreign Nodes:    %d (Active: %s)\n", len(cfg.ForeignNodes), cfg.ActiveForeign)
		for id, fnode := range cfg.ForeignNodes {
			activeMark := ""
			if id == cfg.ActiveForeign || fnode.IsActive {
				activeMark = " [ACTIVE]"
			}
			w := fnode.Weight
			if w <= 0 {
				w = 1
			}
			fmt.Printf(" - %s (%s, %s:%d/%s)%s: Healthy=%v, Latency=%.1fms, Weight=%d\n", id, fnode.Name, fnode.PublicIP, fnode.TunnelPort, fnode.Protocol, activeMark, fnode.IsHealthy, fnode.LatencyMs, w)
		}
		return 0
	}
	if args[0] == "revert" {
		cfg := loadClusterConfig()
		_ = clearClusterFailover(&cfg)
		_ = saveClusterConfig(cfg)
		fmt.Println("Failover iptables NAT rules reverted to local tunnel.")
		return 0
	}
	if args[0] == "add-foreign" {
		if len(args) < 4 {
			fmt.Println("Usage: gre-panel cluster add-foreign <name> <ip> <tunnel_port> [weight] [protocol]")
			return 1
		}
		name := args[1]
		ip := args[2]
		port, err := strconv.Atoi(args[3])
		if err != nil || port < 1 || port > 65535 {
			fmt.Println("Invalid port:", args[3])
			return 1
		}
		weight := 1
		if len(args) >= 5 {
			if w, err := strconv.Atoi(args[4]); err == nil && w > 0 {
				weight = w
			}
		}
		proto := "gre"
		if len(args) >= 6 && args[5] != "" {
			proto = args[5]
		}
		cfg := loadClusterConfig()
		if cfg.ForeignNodes == nil {
			cfg.ForeignNodes = make(map[string]ForeignNode)
		}
		id := fmt.Sprintf("fn_%d", time.Now().UnixNano()%100000)
		cfg.ForeignNodes[id] = ForeignNode{
			ID:         id,
			Name:       name,
			PublicIP:   ip,
			TunnelPort: port,
			Weight:     weight,
			Protocol:   proto,
			IsActive:   len(cfg.ForeignNodes) == 0,
			IsHealthy:  true,
			LastProbe:  time.Now(),
		}
		if cfg.ActiveForeign == "" {
			cfg.ActiveForeign = id
		}
		if err := saveClusterConfig(cfg); err != nil {
			fmt.Println("Failed to save cluster config:", err)
			return 1
		}
		fmt.Printf("Foreign node '%s' added with ID: %s (Weight: %d)\n", name, id, weight)
		return 0
	}
	if args[0] == "del-foreign" || args[0] == "rm-foreign" {
		if len(args) < 2 {
			fmt.Println("Usage: gre-panel cluster del-foreign <id_or_name>")
			return 1
		}
		target := args[1]
		cfg := loadClusterConfig()
		found := false
		for k, v := range cfg.ForeignNodes {
			if k == target || v.Name == target {
				delete(cfg.ForeignNodes, k)
				found = true
				if cfg.ActiveForeign == k {
					cfg.ActiveForeign = ""
					for nextID := range cfg.ForeignNodes {
						cfg.ActiveForeign = nextID
						break
					}
				}
				break
			}
		}
		if !found {
			fmt.Println("Foreign node not found:", target)
			return 1
		}
		_ = saveClusterConfig(cfg)
		fmt.Println("Foreign node removed:", target)
		return 0
	}
	if args[0] == "set-mode" {
		if len(args) < 2 {
			fmt.Println("Usage: gre-panel cluster set-mode <wrr|failover|lowest_latency>")
			return 1
		}
		mode := args[1]
		if mode != "wrr" && mode != "failover" && mode != "lowest_latency" {
			fmt.Println("Invalid mode. Allowed: wrr, failover, lowest_latency")
			return 1
		}
		cfg := loadClusterConfig()
		cfg.BalancingMode = mode
		_ = saveClusterConfig(cfg)
		fmt.Println("Balancing mode set to:", mode)
		return 0
	}
	if args[0] == "switch-foreign" {
		if len(args) < 2 {
			fmt.Println("Usage: gre-panel cluster switch-foreign <id_or_name>")
			return 1
		}
		target := args[1]
		cfg := loadClusterConfig()
		found := false
		for k, v := range cfg.ForeignNodes {
			if k == target || v.Name == target {
				cfg.ActiveForeign = k
				node := v
				node.IsActive = true
				cfg.ForeignNodes[k] = node
				found = true
			} else {
				node := v
				node.IsActive = false
				cfg.ForeignNodes[k] = node
			}
		}
		if !found {
			fmt.Println("Foreign node not found:", target)
			return 1
		}
		_ = saveClusterConfig(cfg)
		fmt.Println("Switched active foreign node to:", target)
		return 0
	}
	fmt.Println("Usage: gre-panel cluster [status | revert | add-foreign | del-foreign | set-mode | switch-foreign]")
	return 1
}
