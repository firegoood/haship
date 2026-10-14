package main

import (
	"encoding/base64"
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

// SSHFwdConfig stores configuration for the Bagher Engine / SSH carrier.
type SSHFwdConfig struct {
	Role                string `json:"role"` // "client" (Iran entry) or "server" (Foreign origin)
	Mode                string `json:"mode"` // "bagher" (default stealth hybrid) or "direct" (pure ssh)
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
		Mode:                "bagher",
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

func loadSSHFwdConfigLocked() SSHFwdConfig {
	cfg := defaultSSHFwdConfig()
	b, err := os.ReadFile(sshFwdConfigFile())
	if err == nil {
		_ = json.Unmarshal(b, &cfg)
	}
	cfg.Mode = "bagher"
	if cfg.RemoteUser == "" {
		cfg.RemoteUser = "root"
	}
	if cfg.RemoteSSHPort <= 0 {
		cfg.RemoteSSHPort = 22
	}
	if cfg.KeyPath == "" {
		cfg.KeyPath = "/root/.ssh/hashem-fwd"
	}
	if cfg.Ports == nil {
		cfg.Ports = []int{}
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
		out, err := runCmd("ssh-keygen", "-t", "ed25519", "-N", "", "-f", keyPath, "-C", "hashem-bagher-carrier")
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
	if mode == "bagher" || mode == "frp_ssh" {
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

// buildSSHFwdService generates the systemd service file content for Bagher Engine.
func buildSSHFwdService(cfg SSHFwdConfig) string {
	remoteTarget := fmt.Sprintf("%s@%s", cfg.RemoteUser, cfg.RemoteHost)
	portArg := ""
	if cfg.RemoteSSHPort > 0 && cfg.RemoteSSHPort != 22 {
		portArg = fmt.Sprintf("-p %d ", cfg.RemoteSSHPort)
	}

	var fwArgs string
	if cfg.Mode == "bagher" || cfg.Mode == "frp_ssh" {
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

	desc := "Hashem Direct SSH Forward Carrier"
	if cfg.Mode == "bagher" || cfg.Mode == "frp_ssh" {
		desc = "Hashem Bagher Engine (Stealth Hybrid Tunnel)"
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

// buildFRPSConfig generates the frps TOML configuration for Iran host in Bagher mode.
func buildFRPSConfig(cfg SSHFwdConfig) string {
	dashPort := cfg.FRPBindPort + 1
	return fmt.Sprintf(`bindAddr = "127.0.0.1"
bindPort = %d
proxyBindAddr = "0.0.0.0"
auth.token = "hashem-bagher-sec"
transport.tcpMux = false

webServer.addr = "127.0.0.1"
webServer.port = %d
webServer.user = "admin"
webServer.password = "bagher-dash-local"
`, cfg.FRPBindPort, dashPort)
}

// buildFRPSService generates the systemd unit for frps on Iran host.
func buildFRPSService() string {
	return `[Unit]
Description=Hashem Bagher Engine server (Iran)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frps -c /etc/gre-panel/bagher/frps.toml
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
`
}

// buildFRPCConfig generates the frpc TOML configuration for Foreign host in Bagher mode.
func buildFRPCConfig(frpBindPort int, poolCount int, ports []int) string {
	var proxyBlocks strings.Builder
	for _, p := range ports {
		proxyBlocks.WriteString(fmt.Sprintf(`
[[proxies]]
name = "p%d"
type = "tcp"
localIP = "127.0.0.1"
localPort = %d
remotePort = %d
`, p, p, p))
	}
	dashPort := frpBindPort + 2
	return fmt.Sprintf(`serverAddr = "127.0.0.1"
serverPort = %d
auth.token = "hashem-bagher-sec"
transport.tcpMux = false
transport.poolCount = %d
loginFailExit = false

webServer.addr = "127.0.0.1"
webServer.port = %d
webServer.user = "admin"
webServer.password = "bagher-dash-local"
%s`, frpBindPort, poolCount, dashPort, proxyBlocks.String())
}

// buildForeignSetupCommand creates a standalone shell command to be executed on Foreign host.
func buildForeignSetupCommand(cfg SSHFwdConfig) string {
	if len(cfg.Ports) == 0 {
		return ""
	}
	frpcToml := buildFRPCConfig(cfg.FRPBindPort, cfg.PoolCount, cfg.Ports)
	return fmt.Sprintf(`mkdir -p /etc/gre-panel/bagher
cat > /etc/gre-panel/bagher/frpc.toml <<'EOF'
%sEOF
cat > /etc/systemd/system/hashem-bagher-frpc.service <<'EOF'
[Unit]
Description=Hashem Bagher Engine client (Foreign)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frpc -c /etc/gre-panel/bagher/frpc.toml
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now hashem-bagher-frpc.service`, strings.TrimSpace(frpcToml))
}

// BagherBundle encapsulates all connection, authentication, and port parameters
// for zero-terminal Foreign server auto-configuration.
type BagherBundle struct {
	Version      int    `json:"v"`
	Role         string `json:"role"`
	IranPub      string `json:"iran_pub"`
	RemoteHost   string `json:"remote_host,omitempty"`
	FRPPort      int    `json:"frp_port"`
	Ports        []int  `json:"ports"`
	Token        string `json:"token"`
	PoolCount    int    `json:"pool_count"`
	SSHPublicKey string `json:"ssh_pub_key"`
	SSHPort      int    `json:"ssh_port"`
	Timestamp    int64  `json:"ts"`
}

// MakeBagherBundle builds a portable encrypted/base64 string for zero-terminal Foreign setup.
// It requires both remote host IP and forwarded ports to be set before generating a bundle.
func MakeBagherBundle(cfg SSHFwdConfig, pubKey string) (string, error) {
	if len(cfg.Ports) == 0 {
		return "", fmt.Errorf("forwarded ports are required before generating bundle")
	}
	if strings.TrimSpace(cfg.RemoteHost) == "" {
		return "", fmt.Errorf("remote host IP is required before generating bundle")
	}
	iranIP := detectPublicIP()
	if iranIP == "" {
		iranIP = cfg.BindAddr
	}
	b := BagherBundle{
		Version:      1,
		Role:         "foreign",
		IranPub:      iranIP,
		RemoteHost:   strings.TrimSpace(cfg.RemoteHost),
		FRPPort:      cfg.FRPBindPort,
		Ports:        cfg.Ports,
		Token:        "hashem-bagher-sec",
		PoolCount:    cfg.PoolCount,
		SSHPublicKey: strings.TrimSpace(pubKey),
		SSHPort:      cfg.RemoteSSHPort,
		Timestamp:    time.Now().Unix(),
	}
	data, err := json.Marshal(b)
	if err != nil {
		return "", err
	}
	return "BAGHER:" + base64.StdEncoding.EncodeToString(data), nil
}

// ParseBagherBundle parses and validates a BAGHER:... bundle string.
func ParseBagherBundle(bundleStr string) (*BagherBundle, error) {
	bundleStr = strings.TrimSpace(bundleStr)
	if !strings.HasPrefix(bundleStr, "BAGHER:") {
		return nil, fmt.Errorf("invalid bundle prefix, expected BAGHER: prefix")
	}
	rawB64 := strings.TrimPrefix(bundleStr, "BAGHER:")
	data, err := base64.StdEncoding.DecodeString(rawB64)
	if err != nil {
		return nil, fmt.Errorf("failed decoding base64 bundle: %w", err)
	}
	var b BagherBundle
	if err := json.Unmarshal(data, &b); err != nil {
		return nil, fmt.Errorf("invalid bundle json: %w", err)
	}
	if strings.TrimSpace(b.SSHPublicKey) == "" {
		return nil, fmt.Errorf("bundle missing ssh_pub_key")
	}
	if len(b.Ports) == 0 {
		return nil, fmt.Errorf("bundle contains no forwarded ports")
	}
	if strings.TrimSpace(b.IranPub) == "" && strings.TrimSpace(b.RemoteHost) == "" {
		return nil, fmt.Errorf("bundle missing server IP")
	}
	if b.FRPPort <= 0 {
		b.FRPPort = 55400
	}
	if b.PoolCount <= 0 {
		b.PoolCount = 25
	}
	if b.Token == "" {
		b.Token = "hashem-bagher-sec"
	}
	return &b, nil
}

// applyBagherBundle configures Foreign host automatically from a parsed BagherBundle.
func applyBagherBundle(b *BagherBundle) error {
	authLine := formatAuthorizedKeyLine(b.SSHPublicKey, "bagher", b.FRPPort, b.Ports)
	authFile := "/root/.ssh/authorized_keys"
	_ = os.MkdirAll("/root/.ssh", 0700)

	existing, _ := os.ReadFile(authFile)
	existingStr := string(existing)

	cleanPub := strings.TrimSpace(b.SSHPublicKey)
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
		return fmt.Errorf("failed writing authorized_keys: %w", err)
	}

	_ = os.MkdirAll("/etc/gre-panel/bagher", 0755)
	frpcToml := buildFRPCConfig(b.FRPPort, b.PoolCount, b.Ports)
	if err := os.WriteFile("/etc/gre-panel/bagher/frpc.toml", []byte(frpcToml), 0644); err != nil {
		return fmt.Errorf("failed writing frpc.toml: %w", err)
	}

	frpcUnit := `[Unit]
Description=Hashem Bagher Engine client (Foreign)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frpc -c /etc/gre-panel/bagher/frpc.toml
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
`
	if err := os.WriteFile("/etc/systemd/system/hashem-bagher-frpc.service", []byte(frpcUnit), 0644); err != nil {
		return fmt.Errorf("failed writing frpc service: %w", err)
	}

	if _, err := runCmd("systemctl", "daemon-reload"); err != nil {
		return fmt.Errorf("daemon-reload failed: %w", err)
	}
	if _, err := runCmd("systemctl", "enable", "--now", "hashem-bagher-frpc.service"); err != nil {
		return fmt.Errorf("failed starting hashem-bagher-frpc: %w", err)
	}

	cfg := loadSSHFwdConfigLocked()
	cfg.Role = "foreign"
	cfg.Mode = "bagher"
	cfg.FRPBindPort = b.FRPPort
	cfg.PoolCount = b.PoolCount
	cfg.Ports = b.Ports
	if b.IranPub != "" {
		cfg.RemoteHost = b.IranPub
	} else if b.RemoteHost != "" {
		cfg.RemoteHost = b.RemoteHost
	}
	cfg.Enabled = true
	cfg.LastStatus = "active"
	cfg.LastError = ""
	return saveSSHFwdConfigLocked(cfg)
}

func formatByteSize(b int64) string {
	if b <= 0 {
		return "0 B"
	}
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}

type BagherLiveMetrics struct {
	Connected      bool    `json:"connected"`
	StatusText     string  `json:"status_text"`
	LatencyMs      float64 `json:"latency_ms"`
	RxBytes        int64   `json:"rx_bytes"`
	TxBytes        int64   `json:"tx_bytes"`
	TotalBytes     int64   `json:"total_bytes"`
	RxFormatted    string  `json:"rx_formatted"`
	TxFormatted    string  `json:"tx_formatted"`
	TotalFormatted string  `json:"total_formatted"`
	CurConns       int     `json:"cur_conns"`
	ClientCounts   int     `json:"client_counts"`
}

func getBagherLiveMetrics(cfg SSHFwdConfig) BagherLiveMetrics {
	isForeign := cfg.Role == "foreign" || cfg.Role == "server"
	if !isForeign {
		outFrpc, _ := runCmd("systemctl", "is-active", "hashem-bagher-frpc.service")
		if strings.TrimSpace(outFrpc) == "active" {
			isForeign = true
		}
	}

	if isForeign {
		outFrpc, _ := runCmd("systemctl", "is-active", "hashem-bagher-frpc.service")
		if strings.TrimSpace(outFrpc) != "active" {
			return BagherLiveMetrics{Connected: false, StatusText: "inactive", RxFormatted: "0 B", TxFormatted: "0 B", TotalFormatted: "0 B"}
		}

		// Dial 127.0.0.1:FRPBindPort (SSH reverse forward to Iran)
		t0 := time.Now()
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", cfg.FRPBindPort), 600*time.Millisecond)
		var lat float64
		connected := false
		statusText := "waiting_for_iran"
		if err == nil {
			lat = float64(time.Since(t0).Microseconds()) / 1000.0
			_ = conn.Close()
			connected = true
			statusText = "connected"
		}

		return BagherLiveMetrics{
			Connected:      connected,
			StatusText:     statusText,
			LatencyMs:      lat,
			RxFormatted:    "0 B",
			TxFormatted:    "0 B",
			TotalFormatted: "0 B",
			ClientCounts:   1,
		}
	}

	// Iran side
	outBagher, _ := runCmd("systemctl", "is-active", "hashem-bagher.service")
	outFrps, _ := runCmd("systemctl", "is-active", "hashem-bagher-frps.service")
	bagherActive := strings.TrimSpace(outBagher) == "active"
	frpsActive := strings.TrimSpace(outFrps) == "active"

	if !bagherActive && !frpsActive {
		return BagherLiveMetrics{Connected: false, StatusText: "inactive", RxFormatted: "0 B", TxFormatted: "0 B", TotalFormatted: "0 B"}
	}

	var lat float64
	if cfg.RemoteHost != "" {
		remoteSSHPort := cfg.RemoteSSHPort
		if remoteSSHPort <= 0 {
			remoteSSHPort = 22
		}
		tRemote := time.Now()
		rConn, rErr := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", cfg.RemoteHost, remoteSSHPort), 600*time.Millisecond)
		if rErr == nil {
			lat = float64(time.Since(tRemote).Microseconds()) / 1000.0
			_ = rConn.Close()
		}
	}
	if lat <= 0 {
		t0 := time.Now()
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", cfg.FRPBindPort), 400*time.Millisecond)
		if err == nil {
			lat = float64(time.Since(t0).Microseconds()) / 1000.0
			_ = conn.Close()
		}
	}

	dashPort := cfg.FRPBindPort + 1
	dashURL := fmt.Sprintf("http://127.0.0.1:%d/api/serverinfo", dashPort)
	client := &http.Client{Timeout: 400 * time.Millisecond}
	req, err := http.NewRequest("GET", dashURL, nil)
	var rx, tx int64
	var clientCount, curConns int
	gotDashboard := false
	if err == nil {
		req.SetBasicAuth("admin", "bagher-dash-local")
		resp, rErr := client.Do(req)
		if rErr == nil && resp.StatusCode == 200 {
			var info struct {
				TotalTrafficIn  int64 `json:"totalTrafficIn"`
				TotalTrafficOut int64 `json:"totalTrafficOut"`
				CurConns        int   `json:"curConns"`
				ClientCounts    int   `json:"clientCounts"`
			}
			if json.NewDecoder(resp.Body).Decode(&info) == nil {
				rx = info.TotalTrafficIn
				tx = info.TotalTrafficOut
				curConns = info.CurConns
				clientCount = info.ClientCounts
				gotDashboard = true
			}
			_ = resp.Body.Close()
		}
	}

	connected := false
	statusText := "waiting_for_peer"
	if gotDashboard {
		if clientCount > 0 {
			connected = true
			statusText = "connected"
		}
	} else {
		outSS, _ := runCmd("ss", "-tn", "state", "established", fmt.Sprintf("sport = :%d or dport = :%d", cfg.FRPBindPort, cfg.FRPBindPort))
		lines := strings.Split(strings.TrimSpace(outSS), "\n")
		if len(lines) > 1 {
			connected = true
			statusText = "connected"
			clientCount = 1
		}
	}

	tot := rx + tx
	return BagherLiveMetrics{
		Connected:      connected,
		StatusText:     statusText,
		LatencyMs:      lat,
		RxBytes:        rx,
		TxBytes:        tx,
		TotalBytes:     tot,
		RxFormatted:    formatByteSize(rx),
		TxFormatted:    formatByteSize(tx),
		TotalFormatted: formatByteSize(tot),
		CurConns:       curConns,
		ClientCounts:   clientCount,
	}
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

	_ = cleanDnatConflict(cfg.Ports)

	_, _ = runCmd("systemctl", "disable", "--now", "hashem-ssh-fwd.service")
	_, _ = runCmd("systemctl", "disable", "--now", "hashem-ssh-frps.service")
	_ = os.Remove("/etc/systemd/system/hashem-ssh-fwd.service")
	_ = os.Remove("/etc/systemd/system/hashem-ssh-frps.service")

	isBagher := cfg.Mode == "bagher" || cfg.Mode == "frp_ssh"
	if isBagher {
		_ = os.MkdirAll("/etc/gre-panel/bagher", 0755)
		frpsToml := buildFRPSConfig(cfg)
		if err := os.WriteFile("/etc/gre-panel/bagher/frps.toml", []byte(frpsToml), 0644); err != nil {
			return fmt.Errorf("failed writing frps.toml: %w", err)
		}
		if err := os.WriteFile("/etc/systemd/system/hashem-bagher-frps.service", []byte(buildFRPSService()), 0644); err != nil {
			return fmt.Errorf("failed writing frps service: %w", err)
		}
	} else {
		_, _ = runCmd("systemctl", "disable", "--now", "hashem-bagher-frps.service")
	}

	svcContent := buildSSHFwdService(cfg)
	unitPath := "/etc/systemd/system/hashem-bagher.service"
	if err := os.WriteFile(unitPath, []byte(svcContent), 0644); err != nil {
		return fmt.Errorf("failed writing unit: %w", err)
	}

	if _, err := runCmd("systemctl", "daemon-reload"); err != nil {
		return fmt.Errorf("daemon-reload failed: %w", err)
	}
	if isBagher {
		if _, err := runCmd("systemctl", "enable", "--now", "hashem-bagher-frps.service"); err != nil {
			return fmt.Errorf("failed starting hashem-bagher-frps: %w", err)
		}
	}
	go func() {
		_, _ = runCmd("systemctl", "enable", "--now", "hashem-bagher.service")
	}()

	cfg.Enabled = true
	cfg.LastStatus = "active"
	cfg.LastError = ""
	return saveSSHFwdConfigLocked(cfg)
}

// disableSSHFwd stops and disables the systemd services.
func disableSSHFwd() error {
	cfg := loadSSHFwdConfigLocked()
	_, _ = runCmd("systemctl", "disable", "--now", "hashem-bagher.service")
	_, _ = runCmd("systemctl", "disable", "--now", "hashem-bagher-frps.service")
	_, _ = runCmd("systemctl", "disable", "--now", "hashem-bagher-frpc.service")
	_, _ = runCmd("systemctl", "disable", "--now", "hashem-ssh-fwd.service")
	_, _ = runCmd("systemctl", "disable", "--now", "hashem-ssh-frps.service")
	cfg.Enabled = false
	cfg.LastStatus = "inactive"
	return saveSSHFwdConfigLocked(cfg)
}

// cleanSSHFwd completely purges Bagher services, units, configs, and firewall rules while preserving SSH keys.
func cleanSSHFwd() error {
	_ = disableSSHFwd()
	units := []string{
		"/etc/systemd/system/hashem-bagher.service",
		"/etc/systemd/system/hashem-bagher-frps.service",
		"/etc/systemd/system/hashem-bagher-frpc.service",
		"/etc/systemd/system/hashem-ssh-fwd.service",
		"/etc/systemd/system/hashem-ssh-frps.service",
	}
	for _, u := range units {
		_ = os.Remove(u)
	}
	_, _ = runCmd("systemctl", "daemon-reload")
	_, _ = runCmd("systemctl", "reset-failed")

	_ = os.Remove("/etc/gre-panel/bagher/frps.toml")
	_ = os.Remove("/etc/gre-panel/bagher/frpc.toml")
	_, _ = runCmd("nft", "delete", "table", "inet", "hashem_dnat")

	cfg := loadSSHFwdConfigLocked()
	cfg.Enabled = false
	cfg.RemoteHost = ""
	cfg.Ports = nil
	cfg.Mode = "bagher"
	cfg.LastStatus = "inactive"
	cfg.LastError = ""
	cfg.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	cfg.Role = ""
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
	sshFwdMu.Lock()
	defer sshFwdMu.Unlock()
	return getSSHFwdStatusLocked()
}

// getSSHFwdStatusLocked returns runtime status when sshFwdMu is already held.
func getSSHFwdStatusLocked() map[string]any {
	cfg := loadSSHFwdConfigLocked()
	pubKey, _ := ensureSSHFwdKey(cfg.KeyPath)

	out, _ := runCmd("systemctl", "is-active", "hashem-bagher.service")
	isActive := strings.TrimSpace(out) == "active"
	if !isActive {
		outFrpc, _ := runCmd("systemctl", "is-active", "hashem-bagher-frpc.service")
		if strings.TrimSpace(outFrpc) == "active" {
			isActive = true
		}
	}
	if !isActive {
		outFrps, _ := runCmd("systemctl", "is-active", "hashem-bagher-frps.service")
		if strings.TrimSpace(outFrps) == "active" {
			isActive = true
		}
	}
	// Fallback check for legacy services
	if !isActive {
		outLegacy, _ := runCmd("systemctl", "is-active", "hashem-ssh-fwd.service")
		if strings.TrimSpace(outLegacy) == "active" {
			isActive = true
		} else {
			outTun, _ := runCmd("systemctl", "is-active", "hashem-frp-ssh-tunnel.service")
			if strings.TrimSpace(outTun) == "active" {
				isActive = true
			}
		}
	}

	portStatus := make(map[string]bool)
	for _, p := range cfg.Ports {
		portStatus[strconv.Itoa(p)] = checkPortListening("127.0.0.1", p)
	}

	dnatOut, _ := runCmd("nft", "list", "table", "inet", "hashem_dnat")
	dnatActive := strings.Contains(dnatOut, "table inet hashem_dnat")

	authLine := ""
	if pubKey != "" {
		authLine = formatAuthorizedKeyLine(pubKey, cfg.Mode, cfg.FRPBindPort, cfg.Ports)
	}

	foreignCmd := ""
	bundleStr := ""
	if len(cfg.Ports) > 0 && strings.TrimSpace(cfg.RemoteHost) != "" {
		foreignCmd = buildForeignSetupCommand(cfg)
		bundleStr, _ = MakeBagherBundle(cfg, pubKey)
	}
	metrics := getBagherLiveMetrics(cfg)

	hasBagher := HasFeature("bagher") || HasFeature("frp_ssh")
	hasConfig := len(strings.TrimSpace(cfg.RemoteHost)) > 0 || len(cfg.Ports) > 0 || cfg.Enabled || isActive

	return map[string]any{
		"has_config":        hasConfig,
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
		"bundle":            bundleStr,
		"ports":             cfg.Ports,
		"bind_addr":         cfg.BindAddr,
		"frp_bind_port":     cfg.FRPBindPort,
		"pool_count":        cfg.PoolCount,
		"licensed_bagher":   hasBagher,
		"licensed_frp_ssh":  hasBagher,
		"machine_hash":      getMachineHash(),
		"port_status":       portStatus,
		"dnat_conflict":     dnatActive,
		"last_error":        cfg.LastError,
		"updated_at":        cfg.UpdatedAt,
		"connected":         metrics.Connected,
		"status_text":       metrics.StatusText,
		"latency_ms":        metrics.LatencyMs,
		"rx_bytes":          metrics.RxBytes,
		"tx_bytes":          metrics.TxBytes,
		"total_bytes":       metrics.TotalBytes,
		"rx_formatted":      metrics.RxFormatted,
		"tx_formatted":      metrics.TxFormatted,
		"total_formatted":   metrics.TotalFormatted,
		"cur_conns":         metrics.CurConns,
		"client_counts":     metrics.ClientCounts,
	}
}

// handleSSHFwdGet returns current SSH Forwarding / Bagher configuration and status.
func handleSSHFwdGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, getSSHFwdStatus())
}

// handleSSHFwdPost handles commands like enable, disable, update-ports, gen-key, sync-peer, apply-bundle.
func handleSSHFwdPost(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Action      string `json:"action"`
		Mode        string `json:"mode"`
		Role        string `json:"role"`
		RemoteHost  string `json:"remote_host"`
		RemoteUser  string `json:"remote_user"`
		SSHPort     int    `json:"ssh_port"`
		Ports       string `json:"ports"`
		BindAddr    string `json:"bind_addr"`
		FRPBindPort int    `json:"frp_bind_port"`
		PoolCount   int    `json:"pool_count"`
		Bundle      string `json:"bundle"`
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
	case "apply_bundle", "apply-bundle":
		if !(HasFeature("bagher") || HasFeature("frp_ssh")) {
			writeAPIError(w, r, "E-LIC-01", "Bagher Engine requires a valid Premium license (Machine: "+getMachineHash()+")")
			return
		}
		bundleStr := strings.TrimSpace(body.Bundle)
		if bundleStr == "" {
			writeAPIError(w, r, "E-SSHFWD-07", "bundle string is required")
			return
		}
		b, err := ParseBagherBundle(bundleStr)
		if err != nil {
			writeAPIError(w, r, "E-SSHFWD-07", fmt.Sprintf("invalid bagher bundle: %v", err))
			return
		}
		if err := applyBagherBundle(b); err != nil {
			writeAPIError(w, r, "E-SSHFWD-08", fmt.Sprintf("failed applying bagher bundle: %v", err))
			return
		}
		writeJSON(w, map[string]any{
			"status":      "ok",
			"message":     "Bagher bundle applied successfully. Foreign client active.",
			"status_data": getSSHFwdStatusLocked(),
		})

	case "get_bundle", "get-bundle":
		if !(HasFeature("bagher") || HasFeature("frp_ssh")) {
			writeAPIError(w, r, "E-LIC-01", "Bagher Engine requires a valid Premium license (Machine: "+getMachineHash()+")")
			return
		}
		if body.RemoteHost != "" {
			cfg.RemoteHost = strings.TrimSpace(body.RemoteHost)
		}
		if body.Ports != "" {
			parsed := parsePorts(body.Ports)
			if len(parsed) > 0 {
				cfg.Ports = parsed
			}
		}
		if len(cfg.Ports) == 0 {
			writeAPIError(w, r, "E-SSHFWD-02", "Forwarded ports must be specified before generating bundle")
			return
		}
		if strings.TrimSpace(cfg.RemoteHost) == "" {
			writeAPIError(w, r, "E-SSHFWD-01", "Remote host IP must be specified before generating bundle")
			return
		}
		_ = saveSSHFwdConfigLocked(cfg)

		pub, err := ensureSSHFwdKey(cfg.KeyPath)
		if err != nil {
			writeAPIError(w, r, "E-SSHFWD-03", err.Error())
			return
		}
		bundleStr, err := MakeBagherBundle(cfg, pub)
		if err != nil {
			writeAPIError(w, r, "E-SSHFWD-07", fmt.Sprintf("failed generating bundle: %v", err))
			return
		}
		writeJSON(w, map[string]any{"status": "ok", "bundle": bundleStr})

	case "gen_key", "gen-key":
		if !(HasFeature("bagher") || HasFeature("frp_ssh")) {
			writeAPIError(w, r, "E-LIC-01", "Bagher Engine requires a valid Premium license (Machine: "+getMachineHash()+")")
			return
		}
		pub, err := ensureSSHFwdKey(cfg.KeyPath)
		if err != nil {
			writeAPIError(w, r, "E-SSHFWD-03", err.Error())
			return
		}
		writeJSON(w, map[string]any{"status": "ok", "pub_key": pub, "auth_line": formatAuthorizedKeyLine(pub, cfg.Mode, cfg.FRPBindPort, cfg.Ports)})

	case "enable", "apply":
		cfg.Mode = "bagher"
		if body.Role != "" {
			cfg.Role = strings.TrimSpace(body.Role)
		} else if cfg.Role == "" || cfg.Role == "foreign" {
			cfg.Role = "iran"
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
		if len(cfg.Ports) == 0 {
			writeAPIError(w, r, "E-SSHFWD-02", "At least one port must be specified in Forwarded Ports")
			return
		}
		if !(HasFeature("bagher") || HasFeature("frp_ssh")) {
			writeAPIError(w, r, "E-LIC-01", "Bagher Engine requires a valid Premium license (Machine: "+getMachineHash()+")")
			return
		}

		if err := enableSSHFwd(cfg); err != nil {
			writeAPIError(w, r, "E-SSHFWD-04", err.Error())
			return
		}
		pubKey, _ := ensureSSHFwdKey(cfg.KeyPath)
		bundleStr, _ := MakeBagherBundle(cfg, pubKey)
		writeJSON(w, map[string]any{
			"status":      "ok",
			"message":     "Bagher Engine enabled successfully",
			"bundle":      bundleStr,
			"status_data": getSSHFwdStatusLocked(),
		})

	case "disable", "stop":
		if err := disableSSHFwd(); err != nil {
			writeAPIError(w, r, "E-SSHFWD-04", err.Error())
			return
		}
		writeJSON(w, map[string]any{"status": "ok", "message": "Bagher Engine disabled", "status_data": getSSHFwdStatusLocked()})

	case "clean", "purge", "reset":
		if err := cleanSSHFwd(); err != nil {
			writeAPIError(w, r, "E-SSHFWD-07", err.Error())
			return
		}
		writeJSON(w, map[string]any{
			"status":      "ok",
			"message":     "Bagher tunnel cleaned and reset",
			"status_data": getSSHFwdStatusLocked(),
		})

	case "sync_peer", "sync-peer":
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
		body.Mode = "bagher"
	}

	authLine := formatAuthorizedKeyLine(body.PubKey, body.Mode, body.FRPBindPort, body.Ports)
	authFile := "/root/.ssh/authorized_keys"
	_ = os.MkdirAll("/root/.ssh", 0700)

	existing, _ := os.ReadFile(authFile)
	existingStr := string(existing)

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

	LogSecurityAudit("bagher_key_installed", "peer", ClientIP(r), fmt.Sprintf("mode=%s ports=%v frp_port=%d", body.Mode, body.Ports, body.FRPBindPort))
	writeJSON(w, map[string]any{"status": "ok", "message": "bagher key authorized with restrictions", "ports": body.Ports})
}
