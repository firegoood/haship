package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// SSHFwdConfig stores configuration for the SSH port forwarding carrier.
type SSHFwdConfig struct {
	Role                string `json:"role"` // "client" (Iran entry) or "server" (Foreign origin)
	Mode                string `json:"mode"` // "frp_ssh" (default hybrid) or "direct" (pure ssh)
	RemoteHost          string `json:"remote_host"`
	RemoteUser          string `json:"remote_user"`
	RemoteSSHPort       int    `json:"remote_ssh_port"`
	KeyPath             string `json:"key_path"`
	Ports               []int  `json:"ports"`
	BindAddr            string `json:"bind_addr"`
	FRPBindPort         int    `json:"frp_bind_port"`
	PoolCount           int    `json:"pool_count"`
	Enabled             bool   `json:"enabled"`
	ServerAliveInterval int    `json:"server_alive_interval"`
	ServerAliveCountMax int    `json:"server_alive_count_max"`
	LastStatus          string `json:"last_status"`
	LastError           string `json:"last_error"`
	UpdatedAt           string `json:"updated_at"`
}

var (
	sshFwdMu sync.Mutex
)

func defaultSSHFwdConfig() SSHFwdConfig {
	return SSHFwdConfig{
		Role:                "client",
		Mode:                "frp_ssh",
		RemoteHost:          "",
		RemoteUser:          "root",
		RemoteSSHPort:       22,
		KeyPath:             "/root/.ssh/hashem-fwd",
		Ports:               []int{443, 8443, 1020, 1030, 1040},
		BindAddr:            "0.0.0.0",
		FRPBindPort:         55400,
		PoolCount:           25,
		Enabled:             false,
		ServerAliveInterval: 10,
		ServerAliveCountMax: 3,
		LastStatus:          "inactive",
		LastError:           "",
		UpdatedAt:           "",
	}
}

func sshFwdConfigFile() string {
	return filepath.Join(configDir, "sshfwd.json")
}

func loadSSHFwdConfig() SSHFwdConfig {
	sshFwdMu.Lock()
	defer sshFwdMu.Unlock()
	return loadSSHFwdConfigLocked()
}

func loadSSHFwdConfigLocked() SSHFwdConfig {
	cfg := defaultSSHFwdConfig()
	b, err := os.ReadFile(sshFwdConfigFile())
	if err == nil {
		_ = json.Unmarshal(b, &cfg)
	}
	if cfg.Mode == "" {
		cfg.Mode = "frp_ssh"
	}
	if cfg.RemoteUser == "" {
		cfg.RemoteUser = "root"
	}
	if cfg.RemoteSSHPort <= 0 {
		cfg.RemoteSSHPort = 22
	}
	if cfg.KeyPath == "" {
		cfg.KeyPath = "/root/.ssh/hashem-fwd"
	}
	if len(cfg.Ports) == 0 {
		cfg.Ports = []int{443, 8443, 1020, 1030, 1040}
	}
	if cfg.BindAddr == "" {
		cfg.BindAddr = "0.0.0.0"
	}
	if cfg.FRPBindPort <= 0 {
		cfg.FRPBindPort = 55400
	}
	if cfg.PoolCount <= 0 {
		cfg.PoolCount = 25
	}
	if cfg.ServerAliveInterval <= 0 {
		cfg.ServerAliveInterval = 10
	}
	if cfg.ServerAliveCountMax <= 0 {
		cfg.ServerAliveCountMax = 3
	}
	return cfg
}

func saveSSHFwdConfigLocked(cfg SSHFwdConfig) error {
	cfg.UpdatedAt = time.Now().Format("2006-01-02 15:04:05")
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(sshFwdConfigFile(), b, 0600)
}

// ensureSSHFwdKey generates an ed25519 keypair if not present.
func ensureSSHFwdKey(keyPath string) (pubKey string, err error) {
	if keyPath == "" {
		keyPath = "/root/.ssh/hashem-fwd"
	}
	pubPath := keyPath + ".pub"
	if _, statErr := os.Stat(keyPath); os.IsNotExist(statErr) {
		if err := os.MkdirAll(filepath.Dir(keyPath), 0700); err != nil {
			return "", err
		}
		out, err := runCmd("ssh-keygen", "-t", "ed25519", "-N", "", "-f", keyPath, "-C", "hashem-ssh-carrier")
		if err != nil {
			return "", fmt.Errorf("ssh-keygen failed: %v (%s)", err, strings.TrimSpace(out))
		}
	}
	b, err := os.ReadFile(pubPath)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// formatAuthorizedKeyLine constructs an authorized_keys entry with restrict & permitopen/permitlisten.
func formatAuthorizedKeyLine(pubKey string, mode string, frpPort int, ports []int) string {
	if mode == "frp_ssh" {
		if frpPort <= 0 {
			frpPort = 55400
		}
		return fmt.Sprintf("restrict,port-forwarding,permitlisten=\"127.0.0.1:%d\" %s", frpPort, strings.TrimSpace(pubKey))
	}
	permitOpenOpts := make([]string, 0, len(ports))
	for _, p := range ports {
		permitOpenOpts = append(permitOpenOpts, fmt.Sprintf("permitopen=\"127.0.0.1:%d\"", p))
	}
	permitStr := strings.Join(permitOpenOpts, ",")
	return fmt.Sprintf("restrict,port-forwarding,%s %s", permitStr, strings.TrimSpace(pubKey))
}

// buildSSHFwdService generates the systemd service file content for SSH tunnel carrier.
func buildSSHFwdService(cfg SSHFwdConfig) string {
	remoteTarget := fmt.Sprintf("%s@%s", cfg.RemoteUser, cfg.RemoteHost)
	portArg := ""
	if cfg.RemoteSSHPort > 0 && cfg.RemoteSSHPort != 22 {
		portArg = fmt.Sprintf("-p %d ", cfg.RemoteSSHPort)
	}

	var fwArgs string
	if cfg.Mode == "frp_ssh" {
		fwArgs = fmt.Sprintf("-R 127.0.0.1:%d:127.0.0.1:%d -o Ciphers=aes128-gcm@openssh.com,chacha20-poly1305@openssh.com -o TCPKeepAlive=yes", cfg.FRPBindPort, cfg.FRPBindPort)
	} else {
		forwards := make([]string, 0, len(cfg.Ports))
		for _, p := range cfg.Ports {
			forwards = append(forwards, fmt.Sprintf("-L %s:%d:127.0.0.1:%d", cfg.BindAddr, p, p))
		}
		fwArgs = strings.Join(forwards, " ")
	}

	execCmd := fmt.Sprintf("/usr/bin/ssh -N -i %s -o BatchMode=yes -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=%d -o ServerAliveCountMax=%d -o StrictHostKeyChecking=accept-new %s%s %s",
		cfg.KeyPath, cfg.ServerAliveInterval, cfg.ServerAliveCountMax, portArg, fwArgs, remoteTarget)

	desc := "Hashem SSH Forward Carrier (Direct SSH tunnel)"
	if cfg.Mode == "frp_ssh" {
		desc = "Hashem FRP-over-SSH Carrier (Reverse SSH tunnel)"
	}

	return fmt.Sprintf(`[Unit]
Description=%s
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%s
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
`, desc, execCmd)
}

// buildFRPSConfig generates the frps TOML configuration for Iran host in FRP-over-SSH mode.
func buildFRPSConfig(cfg SSHFwdConfig) string {
	return fmt.Sprintf(`bindAddr = "127.0.0.1"
bindPort = %d
proxyBindAddr = "0.0.0.0"
auth.token = "hashem-frp-ssh-sec"
transport.tcpMux = false
`, cfg.FRPBindPort)
}

// buildFRPSService generates the systemd unit for frps on Iran host.
func buildFRPSService() string {
	return `[Unit]
Description=Hashem FRP-over-SSH server (Iran)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frps -c /etc/gre-panel/frp-ssh/frps.toml
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
`
}

// buildForeignSetupCommand creates a standalone shell command to be executed on Foreign host.
func buildForeignSetupCommand(cfg SSHFwdConfig) string {
	var proxyBlocks strings.Builder
	for _, p := range cfg.Ports {
		proxyBlocks.WriteString(fmt.Sprintf(`
[[proxies]]
name = "p%d"
type = "tcp"
localIP = "127.0.0.1"
localPort = %d
remotePort = %d
`, p, p, p))
	}

	frpcToml := fmt.Sprintf(`serverAddr = "127.0.0.1"
serverPort = %d
auth.token = "hashem-frp-ssh-sec"
transport.tcpMux = false
transport.poolCount = %d
%s`, cfg.FRPBindPort, cfg.PoolCount, proxyBlocks.String())

	return fmt.Sprintf(`mkdir -p /etc/gre-panel/frp-ssh
cat > /etc/gre-panel/frp-ssh/frpc.toml <<'EOF'
%sEOF
cat > /etc/systemd/system/hashem-frp-ssh-frpc.service <<'EOF'
[Unit]
Description=Hashem FRP-over-SSH client (Foreign)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frpc -c /etc/gre-panel/frp-ssh/frpc.toml
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now hashem-frp-ssh-frpc.service`, strings.TrimSpace(frpcToml))
}

// cleanDnatConflict removes conflicting nftables table or rescues that capture these ports.
func cleanDnatConflict(ports []int) error {
	_, _ = runCmd("systemctl", "disable", "--now", "hashem-rescue-dnat.service")
	_, _ = runCmd("nft", "delete", "table", "inet", "hashem_dnat")
	return nil
}

// enableSSHFwd applies configuration, clears DNAT conflicts, installs service and starts it.
func enableSSHFwd(cfg SSHFwdConfig) error {
	if cfg.RemoteHost == "" {
		return fmt.Errorf("remote host is required")
	}
	if len(cfg.Ports) == 0 {
		return fmt.Errorf("at least one port is required")
	}
	if _, err := ensureSSHFwdKey(cfg.KeyPath); err != nil {
		return fmt.Errorf("failed ensuring key: %w", err)
	}

	// 1. Remove DNAT conflicts so traffic hits the local sockets
	_ = cleanDnatConflict(cfg.Ports)

	if cfg.Mode == "frp_ssh" {
		// Prepare frps directory and config
		_ = os.MkdirAll("/etc/gre-panel/frp-ssh", 0755)
		frpsToml := buildFRPSConfig(cfg)
		if err := os.WriteFile("/etc/gre-panel/frp-ssh/frps.toml", []byte(frpsToml), 0644); err != nil {
			return fmt.Errorf("failed writing frps.toml: %w", err)
		}
		if err := os.WriteFile("/etc/systemd/system/hashem-ssh-frps.service", []byte(buildFRPSService()), 0644); err != nil {
			return fmt.Errorf("failed writing frps service: %w", err)
		}
	} else {
		// Stop frps if switching to pure direct mode
		_, _ = runCmd("systemctl", "disable", "--now", "hashem-ssh-frps.service")
	}

	// 2. Write systemd unit for SSH carrier
	svcContent := buildSSHFwdService(cfg)
	unitPath := "/etc/systemd/system/hashem-ssh-fwd.service"
	if err := os.WriteFile(unitPath, []byte(svcContent), 0644); err != nil {
		return fmt.Errorf("failed writing unit: %w", err)
	}

	// 3. Reload and enable
	if _, err := runCmd("systemctl", "daemon-reload"); err != nil {
		return fmt.Errorf("daemon-reload failed: %w", err)
	}
	if cfg.Mode == "frp_ssh" {
		if _, err := runCmd("systemctl", "enable", "--now", "hashem-ssh-frps.service"); err != nil {
			return fmt.Errorf("failed starting hashem-ssh-frps: %w", err)
		}
	}
	if _, err := runCmd("systemctl", "enable", "--now", "hashem-ssh-fwd.service"); err != nil {
		return fmt.Errorf("systemctl enable --now hashem-ssh-fwd failed: %w", err)
	}

	cfg.Enabled = true
	cfg.LastStatus = "active"
	cfg.LastError = ""
	return saveSSHFwdConfigLocked(cfg)
}

// disableSSHFwd stops and disables the systemd service.
func disableSSHFwd() error {
	cfg := loadSSHFwdConfigLocked()
	_, _ = runCmd("systemctl", "disable", "--now", "hashem-ssh-fwd.service")
	_, _ = runCmd("systemctl", "disable", "--now", "hashem-ssh-frps.service")
	cfg.Enabled = false
	cfg.LastStatus = "inactive"
	return saveSSHFwdConfigLocked(cfg)
}

// checkPortListening returns true if a TCP listener exists on bind:port.
func checkPortListening(bind string, port int) bool {
	target := net.JoinHostPort(bind, strconv.Itoa(port))
	conn, err := net.DialTimeout("tcp", target, 500*time.Millisecond)
	if err == nil {
		_ = conn.Close()
		return true
	}
	return false
}

// getSSHFwdStatus returns runtime status of the forwarder.
func getSSHFwdStatus() map[string]any {
	cfg := loadSSHFwdConfig()
	pubKey, _ := ensureSSHFwdKey(cfg.KeyPath)

	out, _ := runCmd("systemctl", "is-active", "hashem-ssh-fwd.service")
	isActive := strings.TrimSpace(out) == "active"
	// Fallback check: if user already has hashem-frp-ssh-tunnel or legacy carrier running
	if !isActive {
		outTun, _ := runCmd("systemctl", "is-active", "hashem-frp-ssh-tunnel.service")
		if strings.TrimSpace(outTun) == "active" {
			isActive = true
		} else {
			outLegacy, _ := runCmd("systemctl", "is-active", "hashem-ssh-carrier.service")
			if strings.TrimSpace(outLegacy) == "active" {
				isActive = true
			}
		}
	}

	// Listening port check
	portStatus := make(map[string]bool)
	for _, p := range cfg.Ports {
		portStatus[strconv.Itoa(p)] = checkPortListening("127.0.0.1", p)
	}

	// DNAT status check
	dnatOut, _ := runCmd("nft", "list", "table", "inet", "hashem_dnat")
	dnatActive := strings.Contains(dnatOut, "table inet hashem_dnat")

	// Remote auth line
	authLine := ""
	if pubKey != "" {
		authLine = formatAuthorizedKeyLine(pubKey, cfg.Mode, cfg.FRPBindPort, cfg.Ports)
	}

	foreignCmd := buildForeignSetupCommand(cfg)

	return map[string]any{
		"enabled":           cfg.Enabled || isActive,
		"is_active":         isActive,
		"mode":              cfg.Mode,
		"role":              cfg.Role,
		"remote_host":       cfg.RemoteHost,
		"remote_user":       cfg.RemoteUser,
		"remote_ssh_port":   cfg.RemoteSSHPort,
		"key_path":          cfg.KeyPath,
		"pub_key":           pubKey,
		"auth_line":         authLine,
		"foreign_setup_cmd": foreignCmd,
		"ports":             cfg.Ports,
		"bind_addr":         cfg.BindAddr,
		"frp_bind_port":     cfg.FRPBindPort,
		"pool_count":        cfg.PoolCount,
		"licensed_frp_ssh":  HasFeature("frp_ssh"),
		"machine_hash":      getMachineHash(),
		"port_status":       portStatus,
		"dnat_conflict":     dnatActive,
		"last_error":        cfg.LastError,
		"updated_at":        cfg.UpdatedAt,
	}
}

// handleSSHFwdGet returns current SSH Forwarding configuration and status.
func handleSSHFwdGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, getSSHFwdStatus())
}

// handleSSHFwdPost handles commands like enable, disable, update-ports, gen-key, sync-peer.
func handleSSHFwdPost(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Action      string `json:"action"`
		Mode        string `json:"mode"`
		RemoteHost  string `json:"remote_host"`
		RemoteUser  string `json:"remote_user"`
		SSHPort     int    `json:"ssh_port"`
		Ports       string `json:"ports"`
		BindAddr    string `json:"bind_addr"`
		FRPBindPort int    `json:"frp_bind_port"`
		PoolCount   int    `json:"pool_count"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeAPIError(w, r, "E-SSHFWD-01", "invalid json payload")
		return
	}

	act := strings.ToLower(strings.TrimSpace(body.Action))
	sshFwdMu.Lock()
	defer sshFwdMu.Unlock()
	cfg := loadSSHFwdConfigLocked()

	switch act {
	case "gen_key", "gen-key":
		pub, err := ensureSSHFwdKey(cfg.KeyPath)
		if err != nil {
			writeAPIError(w, r, "E-SSHFWD-03", err.Error())
			return
		}
		writeJSON(w, map[string]any{"status": "ok", "pub_key": pub, "auth_line": formatAuthorizedKeyLine(pub, cfg.Mode, cfg.FRPBindPort, cfg.Ports)})

	case "enable", "apply":
		if body.Mode != "" {
			cfg.Mode = strings.ToLower(strings.TrimSpace(body.Mode))
		}
		if body.RemoteHost != "" {
			cfg.RemoteHost = strings.TrimSpace(body.RemoteHost)
		}
		if body.RemoteUser != "" {
			cfg.RemoteUser = strings.TrimSpace(body.RemoteUser)
		}
		if body.SSHPort > 0 {
			cfg.RemoteSSHPort = body.SSHPort
		}
		if body.BindAddr != "" {
			cfg.BindAddr = strings.TrimSpace(body.BindAddr)
		}
		if body.FRPBindPort > 0 {
			cfg.FRPBindPort = body.FRPBindPort
		}
		if body.PoolCount > 0 {
			cfg.PoolCount = body.PoolCount
		}
		if body.Ports != "" {
			parsed := parsePorts(body.Ports)
			if len(parsed) > 0 {
				cfg.Ports = parsed
			}
		}

		if cfg.RemoteHost == "" {
			writeAPIError(w, r, "E-SSHFWD-01", "remote_host is required")
			return
		}

		if cfg.Mode == "frp_ssh" && !HasFeature("frp_ssh") {
			writeAPIError(w, r, "E-LIC-01", "FRP over SSH requires a valid Premium license (Machine: "+getMachineHash()+")")
			return
		}

		if err := enableSSHFwd(cfg); err != nil {
			writeAPIError(w, r, "E-SSHFWD-04", err.Error())
			return
		}
		writeJSON(w, map[string]any{"status": "ok", "message": "SSH forward carrier enabled successfully", "status_data": getSSHFwdStatus()})

	case "disable", "stop":
		if err := disableSSHFwd(); err != nil {
			writeAPIError(w, r, "E-SSHFWD-04", err.Error())
			return
		}
		writeJSON(w, map[string]any{"status": "ok", "message": "SSH forward carrier disabled", "status_data": getSSHFwdStatus()})

	case "sync_peer", "sync-peer":
		// Automatically install the public key on the remote peer if peer link is available
		pubKey, err := ensureSSHFwdKey(cfg.KeyPath)
		if err != nil {
			writeAPIError(w, r, "E-SSHFWD-03", err.Error())
			return
		}
		pcfg := loadPeerConfig()
		if pcfg.PeerSecret == "" {
			writeAPIError(w, r, "E-SSHFWD-05", "peer secret not configured")
			return
		}
		reqPayload := map[string]any{
			"pub_key":       pubKey,
			"mode":          cfg.Mode,
			"frp_bind_port": cfg.FRPBindPort,
			"ports":         cfg.Ports,
		}
		respBytes, err := sendToPeer("/api/peer/sshfwd-install-key", "POST", reqPayload)
		if err != nil {
			writeAPIError(w, r, "E-SSHFWD-06", fmt.Sprintf("failed pushing key to peer: %v", err))
			return
		}
		writeJSON(w, map[string]any{"status": "ok", "peer_response": string(respBytes)})

	case "clear_dnat", "clear-dnat":
		_ = cleanDnatConflict(cfg.Ports)
		writeJSON(w, map[string]any{"status": "ok", "message": "dnat table cleared"})

	default:
		writeAPIError(w, r, "E-SSHFWD-01", "unknown action: want enable, disable, gen_key, sync_peer, or clear_dnat")
	}
}

// handlePeerSSHFwdInstallKey is called on Kharej by Iran panel to register the restrict SSH key.
func handlePeerSSHFwdInstallKey(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PubKey      string `json:"pub_key"`
		Mode        string `json:"mode"`
		FRPBindPort int    `json:"frp_bind_port"`
		Ports       []int  `json:"ports"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeAPIError(w, r, "E-SSHFWD-01", "invalid json")
		return
	}
	if strings.TrimSpace(body.PubKey) == "" {
		writeAPIError(w, r, "E-SSHFWD-01", "pub_key is required")
		return
	}
	if len(body.Ports) == 0 {
		body.Ports = []int{443, 8443, 1020, 1030, 1040}
	}
	if body.FRPBindPort <= 0 {
		body.FRPBindPort = 55400
	}
	if body.Mode == "" {
		body.Mode = "frp_ssh"
	}

	authLine := formatAuthorizedKeyLine(body.PubKey, body.Mode, body.FRPBindPort, body.Ports)
	authFile := "/root/.ssh/authorized_keys"
	_ = os.MkdirAll("/root/.ssh", 0700)

	existing, _ := os.ReadFile(authFile)
	existingStr := string(existing)

	// Don't add duplicate if exact key already present
	cleanPub := strings.TrimSpace(body.PubKey)
	keyParts := strings.Fields(cleanPub)
	targetKey := cleanPub
	if len(keyParts) >= 2 {
		targetKey = keyParts[1]
	}

	var newLines []string
	for _, line := range strings.Split(existingStr, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if !strings.Contains(trimmed, targetKey) {
			newLines = append(newLines, trimmed)
		}
	}
	newLines = append(newLines, authLine)
	finalContent := strings.Join(newLines, "\n") + "\n"

	if err := os.WriteFile(authFile, []byte(finalContent), 0600); err != nil {
		writeAPIError(w, r, "E-SSHFWD-06", fmt.Sprintf("failed writing authorized_keys: %v", err))
		return
	}

	LogSecurityAudit("sshfwd_key_installed", "peer", ClientIP(r), fmt.Sprintf("mode=%s ports=%v frp_port=%d", body.Mode, body.Ports, body.FRPBindPort))
	writeJSON(w, map[string]any{"status": "ok", "message": "ssh forward key authorized with restrictions", "ports": body.Ports})
}
