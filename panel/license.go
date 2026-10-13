package main

import (
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
var defaultMasterPublicKeyB64 = "U2gUVDmihrylZPVlScgPGP28pFMkEwAXtJODjAKoFLs="

var (
	masterPublicKeyB64 = defaultMasterPublicKeyB64
	activeLicense      *LicensePayload
	activeLicenseMu    sync.RWMutex
	cachedMachineHash  string
	machineHashOnce    sync.Once
)

func init() {
	// Start un-licensed (Free Edition) until key is loaded or activated
	activeLicense = nil
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

	pubBytes, err := base64.StdEncoding.DecodeString(masterPublicKeyB64)
	if err != nil || len(pubBytes) != ed25519.PublicKeySize {
		return nil, errors.New("invalid master public key")
	}

	if !ed25519.Verify(pubBytes, payloadBytes, sigBytes) {
		return nil, errors.New("license signature verification failed")
	}

	var payload LicensePayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return nil, fmt.Errorf("corrupt license payload: %w", err)
	}

	// Expiration check
	now := time.Now().Unix()
	if payload.ExpiresAt > 0 && now > payload.ExpiresAt {
		return nil, fmt.Errorf("license expired on %s", time.Unix(payload.ExpiresAt, 0).Format("2006-01-02 15:04:05 UTC"))
	}

	// Machine hash check
	mHash := getMachineHash()
	if payload.MachineHash != "" && payload.MachineHash != "*" {
		if !strings.EqualFold(payload.MachineHash, mHash) {
			return nil, fmt.Errorf("license locked to machine %s, this server is %s", payload.MachineHash, mHash)
		}
	}

	return &payload, nil
}

// loadLicenseFromDisk tries to load and verify the license file.
func loadLicenseFromDisk() {
	keyPath := filepath.Join(configDir, "license.key")
	data, err := os.ReadFile(keyPath)
	if err != nil {
		activeLicenseMu.Lock()
		activeLicense = nil
		activeLicenseMu.Unlock()
		return
	}
	payload, err := verifyLicenseKey(string(data))
	activeLicenseMu.Lock()
	if err == nil {
		activeLicense = payload
	} else {
		activeLicense = nil
	}
	activeLicenseMu.Unlock()
}

// HasFeature returns true if the feature is unlocked by an active license.
func HasFeature(feature string) bool {
	activeLicenseMu.RLock()
	defer activeLicenseMu.RUnlock()

	if activeLicense == nil {
		return false
	}
	if activeLicense.ExpiresAt > 0 && time.Now().Unix() > activeLicense.ExpiresAt {
		return false
	}
	for _, f := range activeLicense.Features {
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
