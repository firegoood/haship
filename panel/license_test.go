package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Helper to generate a test signed license token
func generateTestToken(t *testing.T, customer, machineHash string, features []string, exp int64, privKey ed25519.PrivateKey) string {
	t.Helper()
	payload := LicensePayload{
		Customer:    customer,
		MachineHash: machineHash,
		Features:    features,
		ExpiresAt:   exp,
		IssuedAt:    time.Now().Unix(),
	}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}

	sig := ed25519.Sign(privKey, data)
	return fmt.Sprintf("%s.%s", base64.RawURLEncoding.EncodeToString(data), base64.RawURLEncoding.EncodeToString(sig))
}

func TestLicenseVerificationAndFeatures(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("failed generating test keypair: %v", err)
	}

	origKey := masterPublicKeyB64
	masterPublicKeyB64 = base64.StdEncoding.EncodeToString(pub)
	defer func() { masterPublicKeyB64 = origKey }()

	mHash := getMachineHash()

	// 1. Valid token with matching machine hash
	expFuture := time.Now().Add(24 * time.Hour).Unix()
	validToken := generateTestToken(t, "Alice", mHash, []string{"bagher", "watchdog"}, expFuture, priv)

	p, err := verifyLicenseKey(validToken)
	if err != nil {
		t.Fatalf("expected valid token, got err: %v", err)
	}
	if p.Customer != "Alice" || !HasFeatureString(p.Features, "bagher") {
		t.Errorf("payload mismatch: %+v", p)
	}

	// 2. Token with wildcard machine hash
	wildcardToken := generateTestToken(t, "Bob", "*", []string{"bagher"}, expFuture, priv)
	pWildcard, err := verifyLicenseKey(wildcardToken)
	if err != nil {
		t.Fatalf("wildcard token error: %v", err)
	}
	if pWildcard.Customer != "Bob" {
		t.Errorf("wildcard customer mismatch: %s", pWildcard.Customer)
	}

	// 3. Token with mismatched machine hash
	badMachineToken := generateTestToken(t, "Charlie", "deadbeef000011112222333344445555", []string{"bagher"}, expFuture, priv)
	if _, err := verifyLicenseKey(badMachineToken); err == nil {
		t.Fatalf("expected machine mismatch error, got nil")
	}

	// 4. Expired token
	expPast := time.Now().Add(-24 * time.Hour).Unix()
	expiredToken := generateTestToken(t, "Dave", mHash, []string{"bagher"}, expPast, priv)
	if _, err := verifyLicenseKey(expiredToken); err == nil {
		t.Fatalf("expected expired error, got nil")
	}

	// 5. Tampered token
	tamperedToken := validToken + "tamper"
	if _, err := verifyLicenseKey(tamperedToken); err == nil {
		t.Fatalf("expected signature verification failure, got nil")
	}

	// 6. Invalid format
	if _, err := verifyLicenseKey("invalid_token_without_dot"); err == nil {
		t.Fatalf("expected format error, got nil")
	}
}

func HasFeatureString(features []string, f string) bool {
	for _, item := range features {
		if item == "*" || item == "all" || item == f {
			return true
		}
	}
	return false
}

func TestVerifyStoredTokens(t *testing.T) {
	data, err := os.ReadFile("/opt/hashem-licensor/licenses.db")
	if err != nil {
		t.Skip("no licensor db")
	}
	_ = data
	// Let's test with a freshly generated wildcard token using the master key
	keyData, err := os.ReadFile("/root/.hashem-license/master.key")
	if err != nil {
		t.Fatalf("cannot read master key: %v", err)
	}
	privBytes, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(keyData)))
	if err != nil {
		t.Fatalf("invalid privBytes: %v", err)
	}
	priv := ed25519.PrivateKey(privBytes)
	wildcardToken := generateTestToken(t, "FullAdmin", "*", []string{"bagher", "frp_ssh", "watchdog"}, time.Now().Add(365*24*time.Hour).Unix(), priv)
	p, err := verifyLicenseKey(wildcardToken)
	t.Logf("Wildcard token err=%v, payload=%+v", err, p)
	if err != nil {
		t.Fatalf("wildcard failed: %v", err)
	}
}

func TestLicenseAPI(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("failed generating test keypair: %v", err)
	}

	origKey := masterPublicKeyB64
	masterPublicKeyB64 = base64.StdEncoding.EncodeToString(pub)
	defer func() {
		masterPublicKeyB64 = origKey
		activeLicenseMu.Lock()
		activeLicense = nil
		licenseCheckedAt = time.Now()
		activeLicenseMu.Unlock()
		_ = os.Remove("/etc/hashem/license.key")
		_ = os.Remove(filepath.Join(configDir, "license.key"))
	}()

	mHash := getMachineHash()
	expFuture := time.Now().Add(48 * time.Hour).Unix()
	validToken := generateTestToken(t, "VIP_User", mHash, []string{"bagher"}, expFuture, priv)

	// POST /api/license to activate
	body, _ := json.Marshal(map[string]string{"key": validToken})
	reqPost := httptest.NewRequest("POST", "/api/license", bytes.NewReader(body))
	rrPost := httptest.NewRecorder()
	handleLicensePost(rrPost, reqPost)
	if rrPost.Code != http.StatusOK {
		t.Fatalf("POST /api/license failed with code %d: %s", rrPost.Code, rrPost.Body.String())
	}

	if !HasFeature("bagher") {
		t.Errorf("expected HasFeature(bagher) == true after activation")
	}

	// GET /api/license
	reqGet := httptest.NewRequest("GET", "/api/license", nil)
	rrGet := httptest.NewRecorder()
	handleLicenseGet(rrGet, reqGet)
	if rrGet.Code != http.StatusOK {
		t.Fatalf("GET /api/license failed: %d", rrGet.Code)
	}

	var status map[string]any
	if err := json.NewDecoder(rrGet.Body).Decode(&status); err != nil {
		t.Fatalf("decode GET status err: %v", err)
	}
	if status["is_valid"] != true || status["customer"] != "VIP_User" {
		t.Errorf("license status mismatch: %+v", status)
	}
}
