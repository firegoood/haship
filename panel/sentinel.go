package main

import (
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type SentinelConfig struct {
	Installed      bool   `json:"installed"`
	Running        bool   `json:"running"`
	Port           int    `json:"port"`
	Path           string `json:"path"`
	URL            string `json:"url"`
	IsIran         bool   `json:"is_iran"`
	IsIranDecided  bool   `json:"is_iran_decided"`
	HasLicense     bool   `json:"has_license"`
	ForwardAlerts  bool   `json:"forward_alerts"`
	TelegramChatID string `json:"telegram_chat_id"`
	Version        string `json:"version"`
}

var sentinelMu sync.Mutex

// CheckSentinelEligibility validates that the license has "sentinel" feature.
// Region blocking is removed so Sentinel works smoothly anywhere.
func CheckSentinelEligibility(serverRole, countryCode string) (bool, string) {
	if !(HasFeature("sentinel") || HasFeature("*") || HasFeature("all")) {
		return false, "License missing required 'sentinel' feature"
	}
	return true, ""
}

// DetectServerCountry returns a fallback country code without slow/failing external network calls.
func DetectServerCountry() string {
	return "IR"
}

// PickRandomSentinelPort selects a free random port in the given range.
func PickRandomSentinelPort(minPort, maxPort int) (int, error) {
	delta := maxPort - minPort + 1
	for attempts := 0; attempts < 100; attempts++ {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(delta)))
		if err != nil {
			return 0, err
		}
		cand := minPort + int(n.Int64())
		// Ensure port is available for TCP listening
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", cand))
		if err == nil {
			_ = ln.Close()
			return cand, nil
		}
	}
	return 0, fmt.Errorf("could not find free port in range %d-%d after 100 attempts", minPort, maxPort)
}

func sentinelCredentialsPath() string {
	return "/opt/sentinel/credentials.txt"
}

func sentinelConfigPath() string {
	return filepath.Join(configDir, "sentinel.json")
}

// GetSentinelStatus gathers current Sentinel state and credentials.
func GetSentinelStatus() SentinelConfig {
	sentinelMu.Lock()
	defer sentinelMu.Unlock()

	st := localStatus()
	isIran := true
	if pData, err := os.ReadFile(sentinelConfigPath()); err == nil {
		var pState struct {
			IsIran *bool `json:"is_iran"`
		}
		if err := json.Unmarshal(pData, &pState); err == nil && pState.IsIran != nil {
			isIran = *pState.IsIran
		}
	} else if strings.Contains(strings.ToLower(st.Role), "foreign") {
		isIran = false
	}

	cfg := SentinelConfig{
		Installed:     false,
		Running:       false,
		HasLicense:    HasFeature("sentinel") || HasFeature("*") || HasFeature("all"),
		IsIran:        isIran,
		IsIranDecided: true,
		Version:       "1.2.0",
	}

	credsPath := sentinelCredentialsPath()
	if data, err := os.ReadFile(credsPath); err == nil {
		cfg.Installed = true
		lines := strings.Split(string(data), "\n")
		for _, line := range lines {
			parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
			if len(parts) == 2 {
				switch parts[0] {
				case "port":
					fmt.Sscanf(parts[1], "%d", &cfg.Port)
				case "path":
					cfg.Path = parts[1]
				}
			}
		}
	}

	if cfg.Installed && cfg.Port > 0 {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", cfg.Port), 400*time.Millisecond)
		if err == nil {
			cfg.Running = true
			conn.Close()
		}
		pubHost := st.LocalPub
		if pubHost == "" {
			pubHost = "127.0.0.1"
		}
		cfg.URL = fmt.Sprintf("http://%s:%d%s", pubHost, cfg.Port, cfg.Path)
	}

	return cfg
}

// handleSentinelGet handles GET /api/sentinel.
func handleSentinelGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, GetSentinelStatus())
}

// handleSentinelPost handles POST /api/sentinel actions.
func handleSentinelPost(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Action        string `json:"action"`
		ForwardAlerts *bool  `json:"forward_alerts"`
		IsIran        *bool  `json:"is_iran"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeAPIError(w, r, "E-REQ-01", "invalid json body")
		return
	}

	act := strings.ToLower(strings.TrimSpace(body.Action))
	st := localStatus()

	eligible, reason := CheckSentinelEligibility(st.Role, "")
	if !eligible && act == "install" {
		writeAPIError(w, r, "E-SENTINEL-01", reason)
		return
	}

	switch act {
	case "status":
		writeJSON(w, GetSentinelStatus())

	case "set_locality":
		if body.IsIran == nil {
			writeAPIError(w, r, "E-REQ-02", "missing is_iran boolean field")
			return
		}
		sentinelMu.Lock()
		_ = os.MkdirAll(configDir, 0700)
		pData, _ := json.Marshal(map[string]any{
			"is_iran": *body.IsIran,
		})
		if err := os.WriteFile(sentinelConfigPath(), pData, 0600); err != nil {
			sentinelMu.Unlock()
			writeAPIError(w, r, "E-FILE-01", fmt.Sprintf("failed writing sentinel config: %v", err))
			return
		}
		sentinelMu.Unlock()

		writeJSON(w, map[string]any{
			"status":  "ok",
			"message": "Sentinel server locality updated",
			"data":    GetSentinelStatus(),
		})

	case "install":
		sentinelMu.Lock()

		port, err := PickRandomSentinelPort(30000, 39999)
		if err != nil {
			sentinelMu.Unlock()
			writeAPIError(w, r, "E-PORT-01", fmt.Sprintf("failed allocating random port: %v", err))
			return
		}

		installScript := "/root/projects/sentinel/install.sh"
		if _, err := os.Stat(installScript); err != nil {
			installScript = "/opt/sentinel/install.sh"
		}

		cmd := exec.Command("bash", installScript, "--yes", "--port", fmt.Sprintf("%d", port))
		out, err := cmd.CombinedOutput()
		if err != nil {
			sentinelMu.Unlock()
			writeAPIError(w, r, "E-INSTALL-01", fmt.Sprintf("Sentinel install failed: %s", string(out)))
			return
		}
		sentinelMu.Unlock()

		writeJSON(w, map[string]any{
			"status":  "ok",
			"message": fmt.Sprintf("Sentinel successfully installed on random port %d", port),
			"data":    GetSentinelStatus(),
		})

	case "start":
		_ = exec.Command("systemctl", "start", "sentinel.service").Run()
		time.Sleep(400 * time.Millisecond)
		writeJSON(w, map[string]any{"status": "ok", "data": GetSentinelStatus()})

	case "stop":
		_ = exec.Command("systemctl", "stop", "sentinel.service").Run()
		time.Sleep(200 * time.Millisecond)
		writeJSON(w, map[string]any{"status": "ok", "data": GetSentinelStatus()})

	case "restart":
		_ = exec.Command("systemctl", "restart", "sentinel.service").Run()
		time.Sleep(500 * time.Millisecond)
		writeJSON(w, map[string]any{"status": "ok", "data": GetSentinelStatus()})

	case "uninstall":
		_ = exec.Command("systemctl", "disable", "--now", "sentinel.service").Run()
		_ = os.Remove("/etc/systemd/system/sentinel.service")
		_ = exec.Command("systemctl", "daemon-reload").Run()
		writeJSON(w, map[string]any{"status": "ok", "message": "Sentinel uninstalled successfully"})

	default:
		writeAPIError(w, r, "E-ACT-01", fmt.Sprintf("unsupported action %q", act))
	}
}

// formatSentinelTunnelAlert formats a Hashem alertEvent into an HTML Telegram notification.
func formatSentinelTunnelAlert(e alertEvent) string {
	icon := map[string]string{stateDown: "🚨", stateHealthy: "✅", stateDegraded: "⚠️"}[e.To]
	if icon == "" {
		icon = "ℹ️"
	}
	s := fmt.Sprintf("%s <b>[Hashem Tunnel Alert]</b>\nHost: <code>%s</code>\nLink: <code>%s</code>\nState: %s ➔ <b>%s</b>",
		icon, e.Host, e.Link, strings.ToUpper(e.From), strings.ToUpper(e.To))
	if e.Why != "" {
		s += fmt.Sprintf("\nReason: <i>%s</i>", e.Why)
	}
	s += "\n\n<i>📡 Forwarded via Sentinel</i>"
	return s
}

// ForwardAlertToSentinel sends an alert to Sentinel's local Telegram notification worker.
func ForwardAlertToSentinel(text string) error {
	st := GetSentinelStatus()
	if !st.Installed || !st.Running || st.Port <= 0 {
		return fmt.Errorf("sentinel is not running")
	}

	payload, err := json.Marshal(map[string]string{"text": text, "source": "hashem"})
	if err != nil {
		return err
	}

	schemes := []string{"https", "http"}
	var lastErr error
	client := &http.Client{
		Timeout: 3 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
	}

	for _, scheme := range schemes {
		cleanPath := "/" + strings.Trim(st.Path, "/")
		targetURL := fmt.Sprintf("%s://127.0.0.1:%d%s/api/external-alert", scheme, st.Port, cleanPath)
		req, err := http.NewRequest("POST", targetURL, bytes.NewReader(payload))
		if err != nil {
			lastErr = err
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-R", "1")

		resp, err := client.Do(req)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
			lastErr = fmt.Errorf("sentinel returned HTTP %d", resp.StatusCode)
		} else {
			lastErr = err
		}
	}
	return lastErr
}
