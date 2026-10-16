package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Master Ed25519 public key embedded in binary
var defaultMasterPublicKeyB64 = "/TiHHU2gO8abW0rZhj782elZbeeJMnLaPJrGHXxqMX8="

// List of trusted master public keys.
// Includes the primary active key and legacy keys for backwards compatibility,
// ensuring previously activated licenses remain valid upon panel upgrades.
var defaultTrustedMasterPublicKeysB64 = []string{
	"/TiHHU2gO8abW0rZhj782elZbeeJMnLaPJrGHXxqMX8=", // Current active licensor master key
	"U2gUVDmihrylZPVlScgPGP28pFMkEwAXtJODjAKoFLs=", // Legacy v2.3.4 master public key
}

var (
	masterPublicKeyB64         = defaultMasterPublicKeyB64
	trustedMasterPublicKeysB64 = defaultTrustedMasterPublicKeysB64
	activeLicense              *LicensePayload
	activeLicenseMu            sync.RWMutex
	cachedMachineHash          string
	machineHashOnce            sync.Once
	licenseCheckedAt           time.Time
)

func init() {
	loadLicenseFromDisk()
}

type LicensePayload struct {
	Customer    string   `json:"customer"`
	MachineHash string   `json:"machine_hash"`
	Features    []string `json:"features"`
	ExpiresAt   int64    `json:"expires_at"` // Unix timestamp seconds
	IssuedAt    int64    `json:"issued_at,omitempty"`
}

// getMachineRawID reads the machine identity from system files.
func getMachineRawID() string {
	candidates := []string{
		"/etc/machine-id",
		"/var/lib/dbus/machine-id",
		"/sys/class/dmi/id/product_uuid",
	}
	for _, path := range candidates {
		data, err := os.ReadFile(path)
		if err == nil {
			trimmed := strings.TrimSpace(string(data))
			if trimmed != "" {
				return trimmed
			}
		}
	}
	hostname, _ := os.Hostname()
	if hostname != "" {
		return hostname
	}
	return "hashem-default-machine-id"
}

// getMachineHash computes a stable 32-character hex fingerprint.
func getMachineHash() string {
	machineHashOnce.Do(func() {
		raw := getMachineRawID()
		h := sha256.Sum256([]byte("hashem-lic-v1:" + raw))
		cachedMachineHash = hex.EncodeToString(h[:16])
	})
	return cachedMachineHash
}

// getTrustedPublicKeys compiles the list of trusted master public keys to check against.
// It checks masterPublicKeyB64 (or test overrides) and trustedMasterPublicKeysB64.
func getTrustedPublicKeys() [][]byte {
	candidates := make([]string, 0, len(trustedMasterPublicKeysB64)+1)
	if strings.TrimSpace(masterPublicKeyB64) != "" {
		candidates = append(candidates, strings.TrimSpace(masterPublicKeyB64))
	}
	candidates = append(candidates, trustedMasterPublicKeysB64...)

	seen := make(map[string]bool)
	var keys [][]byte
	for _, c := range candidates {
		c = strings.TrimSpace(c)
		if c == "" || seen[c] {
			continue
		}
		seen[c] = true
		b, err := base64.StdEncoding.DecodeString(c)
		if err == nil && len(b) == ed25519.PublicKeySize {
			keys = append(keys, b)
		}
	}
	return keys
}

// verifyLicenseKey checks the token format, signature, expiry, and machine-hash.
func verifyLicenseKey(token string) (*LicensePayload, error) {
	token = strings.TrimSpace(token)
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return nil, errors.New("invalid license format (must be payload.signature)")
	}

	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		payloadBytes, err = base64.StdEncoding.DecodeString(parts[0])
		if err != nil {
			return nil, errors.New("invalid payload encoding")
		}
	}

	sigBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		sigBytes, err = base64.StdEncoding.DecodeString(parts[1])
		if err != nil {
			return nil, errors.New("invalid signature encoding")
		}
	}

	if len(sigBytes) != ed25519.SignatureSize {
		return nil, fmt.Errorf("invalid signature length: %d (expected %d)", len(sigBytes), ed25519.SignatureSize)
	}

	keys := getTrustedPublicKeys()
	if len(keys) == 0 {
		return nil, errors.New("invalid master public key")
	}

	var verified bool
	for _, pubBytes := range keys {
		if ed25519.Verify(pubBytes, payloadBytes, sigBytes) {
			verified = true
			break
		}
	}

	if !verified {
		return nil, errors.New("license signature verification failed")
	}

	var payload LicensePayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return nil, fmt.Errorf("corrupt license payload: %w", err)
	}

	now := time.Now().Unix()
	if payload.ExpiresAt > 0 && now > payload.ExpiresAt {
		return nil, fmt.Errorf("license expired on %s", time.Unix(payload.ExpiresAt, 0).Format("2006-01-02 15:04:05 UTC"))
	}

	mHash := getMachineHash()
	if payload.MachineHash != "" && payload.MachineHash != "*" {
		if !strings.EqualFold(payload.MachineHash, mHash) {
			return nil, fmt.Errorf("license locked to machine %s, this server is %s", payload.MachineHash, mHash)
		}
	}

	return &payload, nil
}

func loadLicenseFromDisk() {
	candidatePaths := []string{
		filepath.Join(configDir, "license.key"),
		"/etc/hashem/license.key",
		"/root/.hashem/license.key",
		"/root/.hashem-license/license.key",
	}

	var keyData []byte
	for _, p := range candidatePaths {
		if d, err := os.ReadFile(p); err == nil && len(bytes.TrimSpace(d)) > 0 {
			keyData = d
			break
		}
	}

	if (len(bytes.TrimSpace(keyData)) == 0) && strings.TrimSpace(cfg.LicenseKey) != "" {
		keyData = []byte(strings.TrimSpace(cfg.LicenseKey))
	}

	activeLicenseMu.Lock()
	defer activeLicenseMu.Unlock()
	licenseCheckedAt = time.Now()

	if len(bytes.TrimSpace(keyData)) == 0 {
		activeLicense = nil
		return
	}

	keyStr := strings.TrimSpace(string(keyData))
	payload, err := verifyLicenseKey(keyStr)
	if err == nil {
		activeLicense = payload
		_ = os.MkdirAll(configDir, 0755)
		_ = os.WriteFile(filepath.Join(configDir, "license.key"), []byte(keyStr), 0600)
		_ = os.MkdirAll("/etc/hashem", 0755)
		_ = os.WriteFile("/etc/hashem/license.key", []byte(keyStr), 0600)
		if cfg.LicenseKey != keyStr {
			cfg.LicenseKey = keyStr
			saveCfg()
		}
	} else {
		activeLicense = nil
	}
}

func HasFeature(feature string) bool {
	activeLicenseMu.RLock()
	lic := activeLicense
	lastCheck := licenseCheckedAt
	activeLicenseMu.RUnlock()

	if lic == nil && time.Since(lastCheck) > 30*time.Second {
		loadLicenseFromDisk()
		activeLicenseMu.RLock()
		lic = activeLicense
		activeLicenseMu.RUnlock()
	}

	if lic == nil {
		return false
	}
	if lic.ExpiresAt > 0 && time.Now().Unix() > lic.ExpiresAt {
		return false
	}
	for _, f := range lic.Features {
		if f == "*" || f == "all" || strings.EqualFold(f, feature) {
			return true
		}
	}
	return false
}

// handleLicenseGet handles GET /api/license.
func handleLicenseGet(w http.ResponseWriter, r *http.Request) {
	activeLicenseMu.RLock()
	lic := activeLicense
	activeLicenseMu.RUnlock()

	if lic == nil {
		loadLicenseFromDisk()
		activeLicenseMu.RLock()
		lic = activeLicense
		activeLicenseMu.RUnlock()
	}

	mHash := getMachineHash()
	res := map[string]any{
		"machine_hash": mHash,
		"is_valid":     false,
	}

	if lic != nil {
		now := time.Now().Unix()
		if lic.ExpiresAt <= 0 || lic.ExpiresAt > now {
			res["is_valid"] = true
			res["customer"] = lic.Customer
			res["expires_at"] = lic.ExpiresAt
			if lic.ExpiresAt > 0 {
				res["expires_human"] = time.Unix(lic.ExpiresAt, 0).Format("2006-01-02 15:04:05 UTC")
				res["days_remaining"] = int((lic.ExpiresAt - now) / 86400)
			} else {
				res["expires_human"] = "Lifetime (Permanent)"
				res["days_remaining"] = -1
			}
			res["features"] = lic.Features
		} else {
			res["error"] = "License expired"
		}
	}

	writeJSON(w, res)
}

// handleLicensePost handles POST /api/license.
func handleLicensePost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		writeJSON(w, map[string]any{"error": "invalid JSON"})
		return
	}

	key := strings.TrimSpace(req.Key)
	if key == "" {
		_ = os.Remove(filepath.Join(configDir, "license.key"))
		_ = os.Remove("/etc/hashem/license.key")
		cfg.LicenseKey = ""
		saveCfg()
		activeLicenseMu.Lock()
		activeLicense = nil
		activeLicenseMu.Unlock()
		writeJSON(w, map[string]any{"status": "deactivated"})
		return
	}

	payload, err := verifyLicenseKey(key)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		writeJSON(w, map[string]any{
			"error": err.Error(),
		})
		return
	}

	_ = os.MkdirAll(configDir, 0755)
	if err := os.WriteFile(filepath.Join(configDir, "license.key"), []byte(key), 0600); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		writeJSON(w, map[string]any{"error": "failed saving license to disk"})
		return
	}
	_ = os.MkdirAll("/etc/hashem", 0755)
	_ = os.WriteFile("/etc/hashem/license.key", []byte(key), 0600)
	cfg.LicenseKey = key
	saveCfg()

	activeLicenseMu.Lock()
	activeLicense = payload
	activeLicenseMu.Unlock()

	writeJSON(w, map[string]any{
		"status":     "ok",
		"customer":   payload.Customer,
		"expires_at": payload.ExpiresAt,
		"features":   payload.Features,
	})
}
