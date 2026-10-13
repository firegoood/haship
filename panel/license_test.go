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
	validToken := generateTestToken(t, "Alice", mHash, []string{"frp_ssh", "watchdog"}, expFuture, priv)

	p, err := verifyLicenseKey(validToken)
	if err != nil {
		t.Fatalf("expected valid token, got err: %v", err)
	}
	if p.Customer != "Alice" || !HasFeatureString(p.Features, "frp_ssh") {
		t.Errorf("payload mismatch: %+v", p)
	}

	// 2. Token with wildcard machine hash
	wildcardToken := generateTestToken(t, "Bob", "*", []string{"frp_ssh"}, expFuture, priv)
	pWildcard, err := verifyLicenseKey(wildcardToken)
	if err != nil {
		t.Fatalf("wildcard token error: %v", err)
	}
	if pWildcard.Customer != "Bob" {
		t.Errorf("wildcard customer mismatch: %s", pWildcard.Customer)
	}

	// 3. Token with mismatched machine hash
	badMachineToken := generateTestToken(t, "Charlie", "deadbeef000011112222333344445555", []string{"frp_ssh"}, expFuture, priv)
	if _, err := verifyLicenseKey(badMachineToken); err == nil {
		t.Fatalf("expected machine mismatch error, got nil")
	}

	// 4. Expired token
	expPast := time.Now().Add(-24 * time.Hour).Unix()
	expiredToken := generateTestToken(t, "Dave", mHash, []string{"frp_ssh"}, expPast, priv)
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

func TestLicenseAPI(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("failed generating test keypair: %v", err)
	}

	origKey := masterPublicKeyB64
	masterPublicKeyB64 = base64.StdEncoding.EncodeToString(pub)
	defer func() { masterPublicKeyB64 = origKey }()

	mHash := getMachineHash()
	expFuture := time.Now().Add(48 * time.Hour).Unix()
	validToken := generateTestToken(t, "VIP_User", mHash, []string{"frp_ssh"}, expFuture, priv)

	// POST /api/license to activate
	body, _ := json.Marshal(map[string]string{"key": validToken})
	reqPost := httptest.NewRequest("POST", "/api/license", bytes.NewReader(body))
	rrPost := httptest.NewRecorder()
	handleLicensePost(rrPost, reqPost)
	if rrPost.Code != http.StatusOK {
		t.Fatalf("POST /api/license failed with code %d: %s", rrPost.Code, rrPost.Body.String())
	}

	if !HasFeature("frp_ssh") {
		t.Errorf("expected HasFeature(frp_ssh) == true after activation")
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
