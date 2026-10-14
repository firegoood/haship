package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
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
	Nodes          map[string]ClusterNode `json:"nodes"`
	AutoFailover   bool                   `json:"auto_failover"`
	ActiveFailover string                 `json:"active_failover,omitempty"` // Target NodeID if currently redirected
	FailoverTarget string                 `json:"failover_target,omitempty"` // Target Public IP
	Updated        string                 `json:"updated,omitempty"`
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
	clusterMu           sync.RWMutex
	clusterCache        *ClusterConfig
	clusterClient       = &http.Client{Timeout: 3 * time.Second}
	consecutiveFailures int
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
		Nodes:         make(map[string]ClusterNode),
		AutoFailover:  true,
	}
}

func isClusterLicensed() bool {
	return HasFeature("bagher") || HasFeature("cluster")
}

func loadClusterConfig() ClusterConfig {
	clusterMu.Lock()
	defer clusterMu.Unlock()

	if clusterCache != nil {
		return *clusterCache
	}

	data, err := os.ReadFile(clusterConfigFile())
	if err != nil || len(data) == 0 {
		def := defaultClusterConfig()
		clusterCache = &def
		return def
	}

	var c ClusterConfig
	if err := json.Unmarshal(data, &c); err != nil {
		def := defaultClusterConfig()
		clusterCache = &def
		return def
	}

	if c.Nodes == nil {
		c.Nodes = make(map[string]ClusterNode)
	}
	if len(c.ServicePorts) == 0 {
		c.ServicePorts = []int{443, 8443, 2083}
	}
	clusterCache = &c
	return c
}

func saveClusterConfig(c ClusterConfig) error {
	clusterMu.Lock()
	defer clusterMu.Unlock()

	c.Updated = time.Now().Format("2006-01-02 15:04:05")
	if c.Nodes == nil {
		c.Nodes = make(map[string]ClusterNode)
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

	clusterCache = &c
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
		Nodes:   cfg.Nodes,
		Updated: cfg.Updated,
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
		Enabled       *bool   `json:"enabled"`
		NodeID        string  `json:"node_id"`
		ClusterSecret string  `json:"cluster_secret"`
		PublicIP      string  `json:"public_ip"`
		ServicePorts  []int   `json:"service_ports"`
		AutoFailover  *bool   `json:"auto_failover"`
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
	if req.AutoFailover != nil {
		cfg.AutoFailover = *req.AutoFailover
	}

	if err := saveClusterConfig(cfg); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"failed to save config: %s"}`, err.Error()), http.StatusInternalServerError)
		return
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
		clusterMu.Lock()
		if existing, ok := cfg.Nodes[payload.NodeID]; ok {
			existing.TunnelStatus = payload.TunnelStatus
			existing.TunnelLoss = payload.TunnelLoss
			existing.IsFailing = payload.IsFailing
			existing.IsHealthy = payload.TunnelStatus == "UP" && !payload.IsFailing
			existing.LastSeen = time.Now()
			if payload.PublicIP != "" {
				existing.PublicIP = payload.PublicIP
			}
			cfg.Nodes[payload.NodeID] = existing
		}
		clusterMu.Unlock()
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

// getLocalTunnelStatus inspects the local machine's connection to Kharej.
func getLocalTunnelStatus() (status string, loss float64, latency float64) {
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

	return "UP", 0, 1.0 // Default healthy state if unconfigured
}

// applyClusterFailover adds safe iptables DNAT/MASQUERADE rules to forward incoming client ports.
func applyClusterFailover(cfg *ClusterConfig, target ClusterNode) error {
	if target.PublicIP == "" {
		return fmt.Errorf("target node has no public IP")
	}

	// Clean any previous rules first
	_ = clearClusterFailover(cfg)

	// Enable IP forwarding
	_ = exec.Command("sysctl", "-w", "net.ipv4.ip_forward=1").Run()

	for _, port := range cfg.ServicePorts {
		pStr := strconv.Itoa(port)
		// PREROUTING TCP
		_ = exec.Command("iptables", "-t", "nat", "-A", "PREROUTING", "-p", "tcp", "--dport", pStr, "-j", "DNAT", "--to-destination", target.PublicIP+":"+pStr).Run()
		// PREROUTING UDP
		_ = exec.Command("iptables", "-t", "nat", "-A", "PREROUTING", "-p", "udp", "--dport", pStr, "-j", "DNAT", "--to-destination", target.PublicIP+":"+pStr).Run()
		// POSTROUTING MASQUERADE
		_ = exec.Command("iptables", "-t", "nat", "-A", "POSTROUTING", "-d", target.PublicIP, "-p", "tcp", "--dport", pStr, "-j", "MASQUERADE").Run()
		_ = exec.Command("iptables", "-t", "nat", "-A", "POSTROUTING", "-d", target.PublicIP, "-p", "udp", "--dport", pStr, "-j", "MASQUERADE").Run()
	}

	cfg.ActiveFailover = target.ID
	cfg.FailoverTarget = target.PublicIP
	log.Printf("[cluster] failover activated: rerouting ports %v to %s (%s)", cfg.ServicePorts, target.ID, target.PublicIP)
	return nil
}

// clearClusterFailover removes iptables rerouting rules.
func clearClusterFailover(cfg *ClusterConfig) error {
	if cfg.FailoverTarget == "" && cfg.ActiveFailover == "" {
		return nil
	}

	targetIP := cfg.FailoverTarget
	for _, port := range cfg.ServicePorts {
		pStr := strconv.Itoa(port)
		if targetIP != "" {
			_ = exec.Command("iptables", "-t", "nat", "-D", "PREROUTING", "-p", "tcp", "--dport", pStr, "-j", "DNAT", "--to-destination", targetIP+":"+pStr).Run()
			_ = exec.Command("iptables", "-t", "nat", "-D", "PREROUTING", "-p", "udp", "--dport", pStr, "-j", "DNAT", "--to-destination", targetIP+":"+pStr).Run()
			_ = exec.Command("iptables", "-t", "nat", "-D", "POSTROUTING", "-d", targetIP, "-p", "tcp", "--dport", pStr, "-j", "MASQUERADE").Run()
			_ = exec.Command("iptables", "-t", "nat", "-D", "POSTROUTING", "-d", targetIP, "-p", "udp", "--dport", pStr, "-j", "MASQUERADE").Run()
		}
	}

	cfg.ActiveFailover = ""
	cfg.FailoverTarget = ""
	log.Printf("[cluster] failover cleared: returned to local tunnel")
	return nil
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
		if !cfg.Enabled || len(cfg.Nodes) == 0 || cfg.ClusterSecret == "" {
			continue
		}

		localStatus, localLoss, _ := getLocalTunnelStatus()
		isLocalFailing := localStatus != "UP" || localLoss > 50.0

		// Probe peer nodes concurrently
		var wg sync.WaitGroup
		for id, node := range cfg.Nodes {
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

				clusterMu.Lock()
				defer clusterMu.Unlock()
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
			}(id, node)
		}
		wg.Wait()

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
						_ = saveClusterConfig(cfg)
					}
				}
			} else {
				consecutiveFailures = 0
				consecutiveSuccesses++
				// Revert if healthy for 3 cycles and currently failed over
				if consecutiveSuccesses >= 3 && cfg.ActiveFailover != "" {
					_ = clearClusterFailover(&cfg)
					_ = saveClusterConfig(cfg)
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
		return 0
	}
	if args[0] == "revert" {
		cfg := loadClusterConfig()
		_ = clearClusterFailover(&cfg)
		_ = saveClusterConfig(cfg)
		fmt.Println("Failover iptables NAT rules reverted to local tunnel.")
		return 0
	}
	fmt.Println("Usage: gre-panel cluster [status | revert]")
	return 1
}
